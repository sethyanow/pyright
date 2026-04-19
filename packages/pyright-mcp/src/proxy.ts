/**
 * Node.js proxy entry point for the pyright-mcp plugin.
 * Spawns Pyright langserver and serves both LSP and MCP protocol modes
 * through a shared backend via Unix socket + PID file.
 *
 * Architecture:
 *   First proxy instance spawns Pyright, creates a Unix socket server.
 *   Socket server bridges all socket clients ↔ Pyright's stdio.
 *   Subsequent proxy instances connect to the existing socket.
 *
 * Usage:
 *   node proxy.js --lsp    # LSP JSON-RPC passthrough
 *   node proxy.js --mcp    # MCP server mode
 */
import { spawn, ChildProcess } from 'child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import net from 'net';
import path from 'path';
import {
    createMessageConnection,
    StreamMessageReader,
    StreamMessageWriter,
} from 'vscode-jsonrpc/node';
import { JsonRpcDemux } from './jsonrpc-demux';
import { createMcpServer } from './mcp-server';
import { resolveLangserverPath } from './resolve-langserver-path';

// --- State directory ---

function getStateDir(): string {
    const dir = process.env.PYRIGHT_PROXY_STATE_DIR || process.env.CLAUDE_PLUGIN_DATA;
    if (!dir) {
        process.stderr.write('Error: PYRIGHT_PROXY_STATE_DIR or CLAUDE_PLUGIN_DATA must be set\n');
        process.exit(1);
    }
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
    return dir;
}

function getPidPath(stateDir: string): string {
    return path.join(stateDir, 'pyright.pid');
}

function getSocketPath(stateDir: string): string {
    const sockPath = path.join(stateDir, 'pyright.sock');
    if (sockPath.length >= 104) {
        process.stderr.write(`Error: Socket path too long (${sockPath.length} chars): ${sockPath}\n`);
        process.exit(1);
    }
    return sockPath;
}

// --- PID file management ---

function readPid(pidPath: string): number | null {
    try {
        const content = readFileSync(pidPath, 'utf-8').trim();
        const pid = parseInt(content, 10);
        return isNaN(pid) ? null : pid;
    } catch {
        return null;
    }
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function cleanupStaleState(stateDir: string): void {
    const pidPath = getPidPath(stateDir);
    const socketPath = getSocketPath(stateDir);
    const pid = readPid(pidPath);

    if (pid !== null && isProcessAlive(pid)) return;

    try { unlinkSync(pidPath); } catch { /* ignore */ }
    try { unlinkSync(socketPath); } catch { /* ignore */ }
}

// --- Socket server (bridges socket clients ↔ Pyright stdio) ---

function createSocketBridge(
    pyrightProcess: ChildProcess,
    socketPath: string
): Promise<net.Server> {
    return new Promise((resolve, reject) => {
        const demux = new JsonRpcDemux({
            pyrightStdin: pyrightProcess.stdin!,
            pyrightStdout: pyrightProcess.stdout!,
            onPyrightExit: () => {
                // Pyright died; the parent's cleanup-on-exit handler will tear down
                // the rest of the proxy. Nothing further to do here — the demux has
                // already synthesized error responses for pending client requests.
            },
        });

        const server = net.createServer((client) => {
            demux.addClient(client);
        });

        // Keep the demux alive for the lifetime of the server.
        (server as net.Server & { _demux?: JsonRpcDemux })._demux = demux;

        server.on('close', () => {
            demux.dispose();
        });

        server.on('error', reject);
        server.listen(socketPath, () => resolve(server));
    });
}

// --- Connect to socket and return a net.Socket ---

function connectToSocket(socketPath: string): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection(socketPath);
        socket.on('connect', () => resolve(socket));
        socket.on('error', reject);
    });
}

// --- Pyright spawn ---

function spawnPyright(workspaceRoot: string): ChildProcess {
    const langserverPath = resolveLangserverPath();
    const proc = spawn('node', [langserverPath, '--stdio'], {
        cwd: workspaceRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
    });

    proc.stdin!.on('error', () => {});
    proc.stdout!.on('error', () => {});
    proc.stderr!.on('error', () => {});
    proc.stderr!.resume();

    return proc;
}

// --- Cleanup / teardown ---

let cleaningUp = false;

function cleanup(
    pyrightProcess: ChildProcess | null,
    socketServer: net.Server | null,
    stateDir: string
): void {
    if (cleaningUp) return;
    cleaningUp = true;

    const pidPath = getPidPath(stateDir);
    const socketPath = getSocketPath(stateDir);

    // Deletion order per failure catalog: PID first → socket → kill Pyright
    try { unlinkSync(pidPath); } catch { /* ignore */ }
    try { unlinkSync(socketPath); } catch { /* ignore */ }

    if (socketServer) {
        socketServer.close();
    }

    if (pyrightProcess && pyrightProcess.exitCode === null) {
        pyrightProcess.kill('SIGTERM');
        setTimeout(() => {
            if (pyrightProcess.exitCode === null) {
                pyrightProcess.kill('SIGKILL');
            }
        }, 2000);
    }
}

function installSignalHandlers(
    pyrightProcess: ChildProcess | null,
    socketServer: net.Server | null,
    stateDir: string
): void {
    const doCleanup = () => cleanup(pyrightProcess, socketServer, stateDir);
    process.on('SIGTERM', doCleanup);
    process.on('SIGINT', doCleanup);
    process.stdin.on('end', doCleanup);
    process.on('exit', () => {
        // Synchronous last-resort cleanup
        try { unlinkSync(getPidPath(stateDir)); } catch { /* ignore */ }
    });

    if (pyrightProcess) {
        pyrightProcess.on('close', () => {
            doCleanup();
            process.exit(0);
        });
    }
}

// --- Ensure Pyright is running ---

interface PyrightBackend {
    socketPath: string;
    pyrightProcess: ChildProcess | null; // null if we connected to existing
    socketServer: net.Server | null;     // null if we're a client
    isOwner: boolean;
}

export async function ensurePyrightRunning(stateDir: string): Promise<PyrightBackend> {
    const pidPath = getPidPath(stateDir);
    const socketPath = getSocketPath(stateDir);
    const existingPid = readPid(pidPath);

    // If Pyright is already running with a socket, connect to it
    if (existingPid !== null && isProcessAlive(existingPid) && existsSync(socketPath)) {
        try {
            // Test socket is connectable
            const testSocket = await connectToSocket(socketPath);
            testSocket.destroy();
            return {
                socketPath,
                pyrightProcess: null,
                socketServer: null,
                isOwner: false,
            };
        } catch {
            // Socket not connectable — stale state
        }
    }

    // Spawn fresh Pyright
    cleanupStaleState(stateDir);
    const workspaceRoot = process.cwd();
    const pyrightProcess = spawnPyright(workspaceRoot);

    // Create socket server (per failure catalog: spawn → socket → PID)
    const socketServer = await createSocketBridge(pyrightProcess, socketPath);

    // Write PID file LAST
    writeFileSync(pidPath, String(pyrightProcess.pid), 'utf-8');

    return {
        socketPath,
        pyrightProcess,
        socketServer,
        isOwner: true,
    };
}

// --- LSP passthrough mode ---

async function runLspMode(stateDir: string): Promise<void> {
    const backend = await ensurePyrightRunning(stateDir);

    installSignalHandlers(backend.pyrightProcess, backend.socketServer, stateDir);

    // Connect to socket and relay stdin/stdout
    const socket = await connectToSocket(backend.socketPath);

    socket.on('close', () => {
        if (!cleaningUp) {
            cleanup(backend.pyrightProcess, backend.socketServer, stateDir);
            process.exit(0);
        }
    });

    process.stdin.pipe(socket);
    socket.pipe(process.stdout);
}

// --- MCP server mode ---

async function runMcpMode(stateDir: string): Promise<void> {
    const backend = await ensurePyrightRunning(stateDir);

    installSignalHandlers(backend.pyrightProcess, backend.socketServer, stateDir);

    // Connect to socket and create LSP MessageConnection
    const socket = await connectToSocket(backend.socketPath);

    const lspConnection = createMessageConnection(
        new StreamMessageReader(socket),
        new StreamMessageWriter(socket)
    );
    lspConnection.listen();

    socket.on('close', () => {
        if (!cleaningUp) {
            cleanup(backend.pyrightProcess, backend.socketServer, stateDir);
            lspConnection.dispose();
            process.exit(0);
        }
    });

    // LSP initialize handshake (proxy owns this per failure catalog)
    const workspaceRoot = process.cwd();
    const rootUri = `file://${workspaceRoot}`;
    const workspaceName = workspaceRoot.split('/').pop() || 'workspace';

    const initResult: Record<string, any> = await lspConnection.sendRequest('initialize', {
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
    lspConnection.sendNotification('initialized', {});

    // Create MCP server with the initialized connection
    const mcpServer = createMcpServer(lspConnection);

    const legend = initResult?.capabilities?.semanticTokensProvider?.legend;
    if (legend) {
        mcpServer.setTokenLegend(legend);
    }

    // Connect MCP server to stdin/stdout
    const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
    const transport = new StdioServerTransport();
    await mcpServer.server.connect(transport);
}

// --- Entry point ---

if (require.main === module) {
    const mode = process.argv.includes('--lsp')
        ? 'lsp'
        : process.argv.includes('--mcp')
          ? 'mcp'
          : null;

    if (!mode) {
        process.stderr.write('Usage: proxy.js --lsp | --mcp\n');
        process.exit(1);
    }

    const stateDir = getStateDir();

    if (mode === 'lsp') {
        runLspMode(stateDir).catch((err) => {
            process.stderr.write(`proxy --lsp error: ${(err as Error).message}\n`);
            process.exit(1);
        });
    } else {
        runMcpMode(stateDir).catch((err) => {
            process.stderr.write(`proxy --mcp error: ${(err as Error).message}\n`);
            process.exit(1);
        });
    }
}
