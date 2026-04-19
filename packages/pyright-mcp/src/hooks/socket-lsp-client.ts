import net from 'net';
import { existsSync, readFileSync } from 'fs';
import { pathToFileURL } from 'url';
import {
    CancellationToken,
    CancellationTokenSource,
    createMessageConnection,
    MessageConnection,
    StreamMessageReader,
    StreamMessageWriter,
} from 'vscode-jsonrpc/node';
import { FileIntelligence, InlayTypeHint, ResolvedLens } from './format-block';

export { FileIntelligence, InlayTypeHint, ResolvedLens } from './format-block';

const INNER_TIMEOUT_MS = 7_000;
const ANALYSIS_POLL_MS = 3_000;

interface RawCodeLens {
    range: { start: { line: number; character: number } };
    command?: { title: string };
    data?: { kind?: 'references' | 'implementations' };
}

interface DocumentSymbol {
    name: string;
    selectionRange: { start: { line: number; character: number } };
    children?: DocumentSymbol[];
}

interface RawInlayHint {
    position: { line: number; character: number };
    label: string | Array<{ value?: unknown } | unknown>;
    kind?: number;
    paddingLeft?: boolean;
    paddingRight?: boolean;
}

function connectSocket(socketPath: string): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection(socketPath);
        const onError = (err: Error) => {
            socket.removeListener('connect', onConnect);
            reject(err);
        };
        const onConnect = () => {
            socket.removeListener('error', onError);
            resolve(socket);
        };
        socket.once('error', onError);
        socket.once('connect', onConnect);
    });
}

async function initialize(
    conn: MessageConnection,
    workspaceRoot: string,
    token: CancellationToken
): Promise<void> {
    const rootUri = pathToFileURL(workspaceRoot).toString();
    const workspaceName = workspaceRoot.split('/').pop() || 'workspace';
    try {
        await conn.sendRequest(
            'initialize',
            {
                processId: process.pid,
                rootUri,
                rootPath: workspaceRoot,
                workspaceFolders: [{ uri: rootUri, name: workspaceName }],
                capabilities: {
                    textDocument: {
                        documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
                        codeLens: { dynamicRegistration: false },
                        inlayHint: { dynamicRegistration: false },
                    },
                    workspace: {
                        symbol: { dynamicRegistration: false },
                        workspaceFolders: true,
                    },
                },
            },
            token
        );
        conn.sendNotification('initialized', {});
    } catch {
        // Pyright may already be initialized by another client, or request was cancelled — safe to continue
    }
}

function positionKey(line: number, character: number): string {
    return `${line}:${character}`;
}

function flattenSymbols(symbols: DocumentSymbol[], out: Map<string, string>): void {
    for (const sym of symbols) {
        const k = positionKey(sym.selectionRange.start.line, sym.selectionRange.start.character);
        if (!out.has(k)) out.set(k, sym.name);
        if (sym.children) flattenSymbols(sym.children, out);
    }
}

function parseTitle(title: string): { kind: 'references' | 'implementations'; count: number } | null {
    const m = title.match(/^(\d+)\s+(reference|implementation)s?$/);
    if (!m) return null;
    const count = parseInt(m[1], 10);
    const kind = m[2] === 'reference' ? 'references' : 'implementations';
    return { kind, count };
}

async function pollDocumentSymbols(
    conn: MessageConnection,
    uri: string,
    deadline: number,
    token: CancellationToken,
    stop: () => boolean
): Promise<DocumentSymbol[]> {
    let symbols: DocumentSymbol[] = [];
    while (Date.now() < deadline && !stop()) {
        const res = (await conn.sendRequest(
            'textDocument/documentSymbol',
            { textDocument: { uri } },
            token
        )) as DocumentSymbol[] | null;
        if (Array.isArray(res) && res.length > 0) {
            symbols = res;
            break;
        }
        await new Promise((r) => setTimeout(r, 200));
    }
    return symbols;
}

async function fetchResolvedLenses(
    conn: MessageConnection,
    uri: string,
    symbolMap: Map<string, string>,
    token: CancellationToken
): Promise<ResolvedLens[]> {
    const rawLenses = (await conn.sendRequest(
        'textDocument/codeLens',
        { textDocument: { uri } },
        token
    )) as RawCodeLens[] | null;

    if (!Array.isArray(rawLenses) || rawLenses.length === 0) return [];

    const resolved = await Promise.all(
        rawLenses.map(async (lens) => {
            try {
                return (await conn.sendRequest('codeLens/resolve', lens, token)) as RawCodeLens;
            } catch {
                return null;
            }
        })
    );

    const byPos = new Map<string, ResolvedLens>();
    for (const r of resolved) {
        if (!r || !r.command) continue;
        const parsed = parseTitle(r.command.title);
        if (!parsed) continue;
        const line = r.range.start.line;
        const ch = r.range.start.character;
        const k = positionKey(line, ch);
        let entry = byPos.get(k);
        if (!entry) {
            const symbol = symbolMap.get(k) ?? '';
            if (!symbol) continue;
            entry = { line: line + 1, symbol };
            byPos.set(k, entry);
        }
        entry[parsed.kind] = parsed.count;
    }

    return Array.from(byPos.values());
}

function normalizeLabel(label: RawInlayHint['label']): string {
    if (typeof label === 'string') return label;
    if (Array.isArray(label)) {
        const parts: string[] = [];
        for (const part of label) {
            if (part && typeof (part as { value?: unknown }).value === 'string') {
                parts.push((part as { value: string }).value);
            }
        }
        return parts.join('');
    }
    return '';
}

async function fetchInlayTypeHints(
    conn: MessageConnection,
    uri: string,
    text: string,
    token: CancellationToken
): Promise<InlayTypeHint[]> {
    const endLine = text.split('\n').length;
    const raw = (await conn.sendRequest(
        'textDocument/inlayHint',
        {
            textDocument: { uri },
            range: { start: { line: 0, character: 0 }, end: { line: endLine, character: 0 } },
        },
        token
    )) as RawInlayHint[] | null;

    if (!Array.isArray(raw)) return [];

    const hints: InlayTypeHint[] = [];
    for (const h of raw) {
        // Drop parameter hints; keep Type hints and entries with no kind (LSP spec default).
        if (h.kind === 2) continue;
        const label = normalizeLabel(h.label);
        if (!label) continue;
        const line = (h.position?.line ?? -1) + 1;
        if (line <= 0) continue;
        hints.push({ line, label });
    }
    return hints;
}

export async function fetchFileIntelligence(socketPath: string, filePath: string): Promise<FileIntelligence> {
    const empty: FileIntelligence = { codeLenses: [], inlayHints: [] };
    if (!existsSync(socketPath) || !existsSync(filePath)) return empty;

    let socket: net.Socket | null = null;
    let conn: MessageConnection | null = null;
    let timedOut = false;

    const close = () => {
        try { conn?.dispose(); } catch { /* ignore */ }
        try { socket?.destroy(); } catch { /* ignore */ }
    };

    const timer = setTimeout(() => {
        timedOut = true;
        close();
    }, INNER_TIMEOUT_MS);

    const result: FileIntelligence = { codeLenses: [], inlayHints: [] };

    try {
        socket = await connectSocket(socketPath);
        if (timedOut) return empty;
        conn = createMessageConnection(
            new StreamMessageReader(socket),
            new StreamMessageWriter(socket)
        );
        conn.listen();

        const cancel = new CancellationTokenSource();
        const token = cancel.token;

        try {
            const workspaceRoot = process.cwd();
            await initialize(conn, workspaceRoot, token);
            if (timedOut) return result;

            const uri = pathToFileURL(filePath).toString();
            const text = readFileSync(filePath, 'utf-8');
            conn.sendNotification('textDocument/didOpen', {
                textDocument: { uri, languageId: 'python', version: 1, text },
            });

            const pollDeadline = Date.now() + ANALYSIS_POLL_MS;
            const symbols = await pollDocumentSymbols(conn, uri, pollDeadline, token, () => timedOut);
            if (timedOut) return result;

            const symbolMap = new Map<string, string>();
            flattenSymbols(symbols, symbolMap);

            // Sequence codeLens THEN inlay on the same connection.
            // If codeLens throws, inlay is never attempted; outer catch returns { [], [] }.
            // If codeLens succeeds but inlay throws, we keep the codeLens data we already have.
            try {
                result.codeLenses = await fetchResolvedLenses(conn, uri, symbolMap, token);
            } catch {
                // Leave result.codeLenses at [].
            }
            if (timedOut) return result;

            try {
                result.inlayHints = await fetchInlayTypeHints(conn, uri, text, token);
            } catch {
                // Leave result.inlayHints at [].
            }

            return result;
        } finally {
            cancel.dispose();
        }
    } catch {
        // Any throw from socket connect / initialize / unexpected path — return what we have.
        return result;
    } finally {
        clearTimeout(timer);
        close();
    }
}

export async function fetchCodeLenses(socketPath: string, filePath: string): Promise<ResolvedLens[]> {
    return (await fetchFileIntelligence(socketPath, filePath)).codeLenses;
}
