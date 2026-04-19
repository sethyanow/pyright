import { Duplex, Readable, Writable } from 'stream';
import {
    Message,
    NotificationMessage,
    RequestMessage,
    ResponseMessage,
    StreamMessageReader,
    StreamMessageWriter,
} from 'vscode-jsonrpc/node';

export interface JsonRpcDemuxOptions {
    pyrightStdin: Writable;
    pyrightStdout: Readable;
    onPyrightExit?: () => void;
}

// Cap on concurrent in-flight requests per client. Prevents a runaway client from
// exhausting the forward map / Pyright's stdin backpressure budget.
const MAX_IN_FLIGHT_PER_CLIENT = 1024;

interface ForwardEntry {
    client: Duplex;
    clientWriter: StreamMessageWriter;
    clientOriginalId: number | string;
}

// Pyright-initiated request — we recorded the mapping so the primary client's response
// can be translated back to Pyright's original ID.
interface ReverseEntry {
    pyrightOriginalId: number | string;
    primary: Duplex;
}

function isRequest(msg: Message): msg is RequestMessage {
    return typeof (msg as RequestMessage).method === 'string' && (msg as any).id !== undefined;
}

function isResponse(msg: Message): msg is ResponseMessage {
    return (msg as any).id !== undefined && typeof (msg as any).method !== 'string';
}

function isNotification(msg: Message): msg is NotificationMessage {
    return (msg as any).id === undefined && typeof (msg as any).method === 'string';
}

export class JsonRpcDemux {
    private readonly _pyrightReader: StreamMessageReader;
    private readonly _pyrightWriter: StreamMessageWriter;
    private readonly _onPyrightExit?: () => void;

    private _nextProxyId = 1;
    private _nextReverseProxyId = 1;
    private readonly _forwardMap = new Map<number, ForwardEntry>();
    private readonly _reverseMap = new Map<number, ReverseEntry>();
    private readonly _clientWriters = new WeakMap<Duplex, StreamMessageWriter>();
    private readonly _clients = new Set<Duplex>();
    // Per-client map clientOriginalId→proxyId, used for reverse lookups when translating
    // $/cancelRequest (params.id references a previous request's client-local ID) and
    // for O(pending-for-client) cleanup on disconnect.
    private readonly _clientInFlight = new WeakMap<Duplex, Map<number | string, number>>();
    // The first-connected client is the "primary" — receives server-initiated requests.
    private _primary: Duplex | null = null;
    private _disposed = false;

    // Initialize state machine: Pyright accepts exactly one `initialize` per process
    // lifetime. Subsequent clients receive the cached result without Pyright ever seeing
    // a second initialize.
    private _initState: 'NOT_SENT' | 'IN_FLIGHT' | 'COMPLETE' | 'FAILED' = 'NOT_SENT';
    private _initProxyId: number | null = null;
    private _cachedInitializeResult: ResponseMessage['result'] = null;
    // Messages received from any client while state === IN_FLIGHT are deferred until
    // the initialize response returns, then drained in arrival order.
    private readonly _initQueue: Array<{ client: Duplex; msg: Message }> = [];
    private _initializedForwarded = false;

    constructor(options: JsonRpcDemuxOptions) {
        this._pyrightReader = new StreamMessageReader(options.pyrightStdout);
        // Single writer owns Pyright's stdin. StreamMessageWriter.write is internally
        // serialized via its writeSemaphore, so concurrent forwards from different
        // clients never interleave Content-Length frames.
        this._pyrightWriter = new StreamMessageWriter(options.pyrightStdin);
        this._onPyrightExit = options.onPyrightExit;

        this._pyrightReader.listen((msg) => this._onPyrightMessage(msg));
        this._pyrightReader.onClose(() => this._onPyrightDown());
        this._pyrightReader.onError(() => this._onPyrightDown());
    }

    addClient(client: Duplex): void {
        if (this._disposed) return;
        const writer = new StreamMessageWriter(client);
        this._clientWriters.set(client, writer);
        this._clients.add(client);
        this._clientInFlight.set(client, new Map());

        if (this._primary === null) {
            this._primary = client;
        }

        const reader = new StreamMessageReader(client);
        reader.listen((msg) => this._onClientMessage(client, msg));

        const onLost = () => this.removeClient(client);
        client.once('close', onLost);
        client.once('error', onLost);
    }

    removeClient(client: Duplex): void {
        if (this._disposed) return;
        if (!this._clients.has(client)) return;
        this._clients.delete(client);

        // Drop any forward-map entries owned by this client — late Pyright responses
        // will be dropped silently by the "unknown ID" guard in _onPyrightMessage.
        const inFlight = this._clientInFlight.get(client);
        if (inFlight) {
            for (const proxyId of inFlight.values()) {
                this._forwardMap.delete(proxyId);
            }
            inFlight.clear();
        }

        // If this was the primary, synthesize RequestCancelled errors back to Pyright
        // for every in-flight server-initiated request, then elect a new primary.
        if (this._primary === client) {
            const nowCancelled: number[] = [];
            for (const [proxyId, entry] of this._reverseMap) {
                if (entry.primary === client) {
                    nowCancelled.push(proxyId);
                    const err: ResponseMessage = {
                        jsonrpc: '2.0',
                        id: entry.pyrightOriginalId,
                        error: { code: -32800, message: 'RequestCancelled: primary client disconnected' },
                    };
                    void this._pyrightWriter.write(err);
                }
            }
            for (const proxyId of nowCancelled) {
                this._reverseMap.delete(proxyId);
            }
            // Elect next primary — first surviving client, or null
            this._primary = this._clients.size > 0 ? this._clients.values().next().value ?? null : null;
        }
    }

    dispose(): void {
        if (this._disposed) return;
        this._disposed = true;
        this._clients.clear();
        this._forwardMap.clear();
        this._reverseMap.clear();
        this._initQueue.length = 0;
    }

    private _onPyrightDown(): void {
        if (this._disposed) return;
        // Synthesize InternalError for every pending forward-map entry so clients get
        // a resolved promise rather than hanging indefinitely.
        for (const [, entry] of this._forwardMap) {
            const err: ResponseMessage = {
                jsonrpc: '2.0',
                id: entry.clientOriginalId,
                error: { code: -32097, message: 'InternalError: Pyright langserver exited' },
            };
            void entry.clientWriter.write(err);
        }
        this._forwardMap.clear();
        this._reverseMap.clear();
        this._initQueue.length = 0;
        this._onPyrightExit?.();
    }

    private _onClientMessage(client: Duplex, msg: Message): void {
        if (this._disposed) return;
        const isInitializeRequest = isRequest(msg) && msg.method === 'initialize';

        // Initialize multiplexing: Pyright accepts exactly one `initialize`.
        if (isInitializeRequest) {
            if (this._initState === 'COMPLETE') {
                // Synthesize cached response — don't forward to Pyright.
                const writer = this._clientWriters.get(client);
                if (writer) {
                    const synth: ResponseMessage = {
                        jsonrpc: '2.0',
                        id: msg.id as number | string,
                        result: this._cachedInitializeResult,
                    };
                    void writer.write(synth);
                }
                return;
            }
            if (this._initState === 'IN_FLIGHT') {
                // Another client's initialize raced; defer until the first one completes.
                this._initQueue.push({ client, msg });
                return;
            }
            if (this._initState === 'NOT_SENT') {
                this._initState = 'IN_FLIGHT';
                // Fall through to normal request forwarding — _initProxyId recorded there.
            }
            // FAILED: fall through (forward will likely also fail, but be honest about it)
        }

        // `initialized` notification is a one-shot: forward on first occurrence.
        if (isNotification(msg) && msg.method === 'initialized') {
            if (this._initializedForwarded) return;
            this._initializedForwarded = true;
            void this._pyrightWriter.write(msg);
            return;
        }

        // While Pyright is still processing initialize, queue everything EXCEPT the
        // initialize request we just started bootstrapping.
        if (this._initState === 'IN_FLIGHT' && !isInitializeRequest) {
            this._initQueue.push({ client, msg });
            return;
        }

        if (isRequest(msg)) {
            const clientWriter = this._clientWriters.get(client)!;
            const clientOriginalId = msg.id as number | string;
            const inFlight = this._clientInFlight.get(client)!;

            // Reject duplicate in-flight ID from the same client.
            if (inFlight.has(clientOriginalId)) {
                const err: ResponseMessage = {
                    jsonrpc: '2.0',
                    id: clientOriginalId,
                    error: { code: -32600, message: 'InvalidRequest: request ID already in flight' },
                };
                void clientWriter.write(err);
                return;
            }

            // Enforce per-client in-flight cap.
            if (inFlight.size >= MAX_IN_FLIGHT_PER_CLIENT) {
                const err: ResponseMessage = {
                    jsonrpc: '2.0',
                    id: clientOriginalId,
                    error: {
                        code: -32001,
                        message: `ServerError: too many in-flight requests (cap ${MAX_IN_FLIGHT_PER_CLIENT})`,
                    },
                };
                void clientWriter.write(err);
                return;
            }

            const proxyId = this._nextProxyId++;
            this._forwardMap.set(proxyId, {
                client,
                clientWriter,
                clientOriginalId,
            });
            inFlight.set(clientOriginalId, proxyId);
            if (isInitializeRequest) {
                this._initProxyId = proxyId;
            }
            const forwarded: RequestMessage = {
                ...msg,
                id: proxyId,
            };
            void this._pyrightWriter.write(forwarded);
        } else if (isResponse(msg)) {
            // Client is responding to a Pyright-initiated request. Look up the reverse map
            // and translate the ID back to Pyright's original.
            const proxyId = msg.id as number;
            const entry = this._reverseMap.get(proxyId);
            if (!entry) return; // late or unknown — drop silently
            this._reverseMap.delete(proxyId);
            const restored: ResponseMessage = {
                ...msg,
                id: entry.pyrightOriginalId,
            };
            void this._pyrightWriter.write(restored);
        } else if (isNotification(msg)) {
            // Special case: $/cancelRequest references a request ID in params.id.
            // Translate the client-local ID to the proxy ID before forwarding.
            if (msg.method === '$/cancelRequest') {
                const clientTargetId = (msg.params as { id?: number | string })?.id;
                if (clientTargetId === undefined) return;
                const inFlight = this._clientInFlight.get(client);
                const proxyId = inFlight?.get(clientTargetId);
                if (proxyId === undefined) return; // request already completed or unknown
                const translated: NotificationMessage = {
                    ...msg,
                    params: { ...(msg.params as object), id: proxyId },
                } as NotificationMessage;
                void this._pyrightWriter.write(translated);
                return;
            }
            // Other client→server notifications: forward as-is (NOT broadcast to other clients)
            void this._pyrightWriter.write(msg);
        }
    }

    private _drainInitQueue(): void {
        const queue = this._initQueue.splice(0);
        if (this._initState === 'FAILED') {
            // Initialize failed — every queued request gets an error response;
            // notifications are dropped. No further forwards to Pyright; signal exit.
            for (const { client, msg } of queue) {
                if (!isRequest(msg)) continue;
                const writer = this._clientWriters.get(client);
                if (!writer) continue;
                const err: ResponseMessage = {
                    jsonrpc: '2.0',
                    id: msg.id as number | string,
                    error: { code: -32603, message: 'InitializeError: Pyright init failed' },
                };
                void writer.write(err);
            }
            this._onPyrightExit?.();
            return;
        }
        for (const { client, msg } of queue) {
            // Skip clients that have since disconnected (post-Step 8).
            if (!this._clients.has(client)) continue;
            this._onClientMessage(client, msg);
        }
    }

    private _onPyrightMessage(msg: Message): void {
        if (this._disposed) return;
        if (isRequest(msg)) {
            // Pyright-initiated request (e.g., workspace/configuration). Route to the primary
            // client; record the mapping so we can translate the response back.
            if (this._primary === null) return; // no clients to ask; drop
            const proxyId = this._nextReverseProxyId++;
            this._reverseMap.set(proxyId, {
                pyrightOriginalId: msg.id as number | string,
                primary: this._primary,
            });
            const forwarded: RequestMessage = {
                ...msg,
                id: proxyId,
            };
            const primaryWriter = this._clientWriters.get(this._primary);
            if (primaryWriter) void primaryWriter.write(forwarded);
        } else if (isResponse(msg)) {
            const proxyId = msg.id as number;
            const entry = this._forwardMap.get(proxyId);
            if (!entry) return; // unknown ID — drop silently
            this._forwardMap.delete(proxyId);
            entry.client && this._clientInFlight.get(entry.client)?.delete(entry.clientOriginalId);
            const restored: ResponseMessage = {
                ...msg,
                id: entry.clientOriginalId,
            };
            void entry.clientWriter.write(restored);

            // Initialize response completes the state machine. Cache and drain.
            if (this._initState === 'IN_FLIGHT' && proxyId === this._initProxyId) {
                if ('result' in msg && msg.result !== undefined) {
                    this._cachedInitializeResult = msg.result;
                    this._initState = 'COMPLETE';
                } else {
                    this._initState = 'FAILED';
                }
                this._drainInitQueue();
            }
        } else if (isNotification(msg)) {
            // Special case: Pyright cancelling a server-initiated request.
            // Translate params.id (Pyright-local) → proxy ID allocated for the primary,
            // then route the cancellation to the primary only.
            if (msg.method === '$/cancelRequest') {
                const pyrightTargetId = (msg.params as { id?: number | string })?.id;
                if (pyrightTargetId === undefined) return;
                let matchedProxyId: number | undefined;
                let matchedPrimary: Duplex | undefined;
                for (const [proxyId, entry] of this._reverseMap) {
                    if (entry.pyrightOriginalId === pyrightTargetId) {
                        matchedProxyId = proxyId;
                        matchedPrimary = entry.primary;
                        break;
                    }
                }
                if (matchedProxyId === undefined || matchedPrimary === undefined) return;
                const primaryWriter = this._clientWriters.get(matchedPrimary);
                if (!primaryWriter) return;
                const translated: NotificationMessage = {
                    ...msg,
                    params: { ...(msg.params as object), id: matchedProxyId },
                } as NotificationMessage;
                void primaryWriter.write(translated);
                return;
            }
            // Other server→client notifications: broadcast to every connected client
            for (const client of this._clients) {
                const writer = this._clientWriters.get(client);
                if (writer) void writer.write(msg);
            }
        }
    }
}
