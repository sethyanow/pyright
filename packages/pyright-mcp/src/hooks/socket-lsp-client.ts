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
import { ResolvedLens } from './format-block';

export { ResolvedLens } from './format-block';

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

export async function fetchCodeLenses(socketPath: string, filePath: string): Promise<ResolvedLens[]> {
    if (!existsSync(socketPath) || !existsSync(filePath)) return [];

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

    try {
        socket = await connectSocket(socketPath);
        if (timedOut) return [];
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
            if (timedOut) return [];

            const uri = pathToFileURL(filePath).toString();
            const text = readFileSync(filePath, 'utf-8');
            conn.sendNotification('textDocument/didOpen', {
                textDocument: { uri, languageId: 'python', version: 1, text },
            });

            // Poll documentSymbol briefly — returns non-empty once binding completes
            const pollDeadline = Date.now() + ANALYSIS_POLL_MS;
            let symbols: DocumentSymbol[] = [];
            while (Date.now() < pollDeadline && !timedOut) {
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
            if (timedOut) return [];

            const symbolMap = new Map<string, string>();
            flattenSymbols(symbols, symbolMap);

            const rawLenses = (await conn.sendRequest(
                'textDocument/codeLens',
                { textDocument: { uri } },
                token
            )) as RawCodeLens[] | null;

            if (!Array.isArray(rawLenses) || rawLenses.length === 0) return [];

            const resolved = await Promise.all(
                rawLenses.map(async (lens) => {
                    try {
                        return (await conn!.sendRequest('codeLens/resolve', lens, token)) as RawCodeLens;
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
        } finally {
            cancel.dispose();
        }
    } catch {
        return [];
    } finally {
        clearTimeout(timer);
        close();
    }
}
