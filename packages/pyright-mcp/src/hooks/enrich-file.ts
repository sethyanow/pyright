/**
 * PostToolUse enrichment hook for .py files.
 *
 * Reads a PostToolUse hook payload from stdin; if the tool_name and file_path
 * gate passes, opens a transient connection to the shared Pyright instance
 * (via proxy's ensurePyrightRunning), fetches file intelligence, and emits a
 * hookSpecificOutput.additionalContext payload on stdout. Any internal failure
 * results in a silent empty `{}` output and exit 0 — the hook must be
 * invisible to the user on failure.
 *
 * Wiring (pyr-smw):
 *   - hooks.json:          registers PostToolUse on Read|Edit|Write
 *   - webpack.config.js:   bundles src/hooks/enrich-file.ts → dist/hooks/enrich-file.js
 *   - check-build.sh:      warns at SessionStart if the dist bundle is missing
 */
import net from 'net';
import { isAbsolute } from 'path';
import {
    createMessageConnection,
    StreamMessageReader,
    StreamMessageWriter,
    MessageConnection,
} from 'vscode-jsonrpc/node';
import { fetchFileIntelligence, type TokenLegend } from '../fetch-file-intelligence';
import { ensurePyrightRunning } from '../proxy';

const SOFT_TIMEOUT_MS = 45_000;

export interface PostToolUseInput {
    tool_name: string;
    tool_input: { file_path?: unknown; [key: string]: unknown };
    [key: string]: unknown;
}

export function shouldEnrich(input: PostToolUseInput): boolean {
    if (!['Read', 'Edit', 'Write'].includes(input.tool_name)) return false;
    const fp = input.tool_input?.file_path;
    if (typeof fp !== 'string') return false;
    if (!fp.endsWith('.py')) return false;
    if (!isAbsolute(fp)) return false;
    return true;
}

function writeOutput(obj: unknown): void {
    process.stdout.write(JSON.stringify(obj));
}

function readStdinJson(): Promise<PostToolUseInput> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
        process.stdin.on('end', () => {
            try {
                const raw = Buffer.concat(chunks).toString('utf-8');
                resolve(JSON.parse(raw));
            } catch (err) {
                reject(err);
            }
        });
        process.stdin.on('error', reject);
    });
}

function connectToSocket(socketPath: string): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection(socketPath);
        socket.once('connect', () => resolve(socket));
        socket.once('error', reject);
    });
}

async function connectAndInit(
    socketPath: string
): Promise<{ connection: MessageConnection; legend: TokenLegend; socket: net.Socket }> {
    const socket = await connectToSocket(socketPath);
    const connection = createMessageConnection(
        new StreamMessageReader(socket),
        new StreamMessageWriter(socket)
    );
    connection.listen();

    // Capabilities must match proxy.ts runMcpMode — mismatches trigger
    // re-negotiation on the shared Pyright.
    const workspaceRoot = process.cwd();
    const rootUri = `file://${workspaceRoot}`;
    const workspaceName = workspaceRoot.split('/').pop() || 'workspace';

    const initResult: Record<string, unknown> = await connection.sendRequest('initialize', {
        processId: process.pid,
        rootUri,
        rootPath: workspaceRoot,
        workspaceFolders: [{ uri: rootUri, name: workspaceName }],
        capabilities: {
            textDocument: {
                implementation: { dynamicRegistration: false },
                semanticTokens: {
                    dynamicRegistration: false,
                    requests: { full: true, range: true },
                    tokenTypes: [],
                    tokenModifiers: [],
                },
                inlayHint: { dynamicRegistration: false },
                codeLens: { dynamicRegistration: false },
            },
            workspace: {
                symbol: { dynamicRegistration: false },
                workspaceFolders: true,
            },
        },
    });
    connection.sendNotification('initialized', {});

    const caps = initResult.capabilities as
        | { semanticTokensProvider?: { legend?: TokenLegend } }
        | undefined;
    const legend = caps?.semanticTokensProvider?.legend;
    if (!legend) {
        throw new Error('initialize response missing semanticTokensProvider.legend');
    }

    return { connection, legend, socket };
}

async function runEnrichment(): Promise<void> {
    const input = await readStdinJson();
    if (!shouldEnrich(input)) {
        writeOutput({});
        return;
    }
    const filePath = input.tool_input.file_path as string;

    const stateDir =
        process.env.PYRIGHT_PROXY_STATE_DIR || process.env.CLAUDE_PLUGIN_DATA;
    if (!stateDir) {
        writeOutput({});
        return;
    }

    const { socketPath } = await ensurePyrightRunning(stateDir);
    const { connection, socket, legend } = await connectAndInit(socketPath);

    try {
        const result = await fetchFileIntelligence(
            connection,
            filePath,
            legend,
            new Set<string>()
        );
        if ('error' in result) {
            writeOutput({});
            return;
        }
        writeOutput({
            hookSpecificOutput: {
                hookEventName: 'PostToolUse',
                additionalContext: result.block,
            },
        });
    } finally {
        connection.dispose();
        socket.destroy();
    }
}

async function main(): Promise<void> {
    let timer: NodeJS.Timeout | null = null;
    try {
        await Promise.race([
            runEnrichment(),
            new Promise<void>((resolve) => {
                timer = setTimeout(() => {
                    writeOutput({});
                    resolve();
                }, SOFT_TIMEOUT_MS);
            }),
        ]);
    } catch {
        writeOutput({});
    } finally {
        if (timer) clearTimeout(timer);
        process.exit(0);
    }
}

if (require.main === module) {
    main();
}
