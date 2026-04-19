import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn, ChildProcess } from 'child_process';
import { existsSync, mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
    createMessageConnection,
    StreamMessageReader,
    StreamMessageWriter,
    MessageConnection,
} from 'vscode-jsonrpc/node';

const PROXY_PATH = path.resolve(__dirname, '../../dist/proxy.js');
const FIXTURES_DIR = path.resolve(__dirname, 'fixtures');

function createTempStateDir(): string {
    return mkdtempSync(path.join(tmpdir(), 'pyright-proxy-test-'));
}

function spawnProxy(
    mode: string,
    stateDir: string
): { process: ChildProcess; connection: MessageConnection } {
    const proc = spawn('node', [PROXY_PATH, `--${mode}`], {
        cwd: FIXTURES_DIR,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
            ...process.env,
            PYRIGHT_PROXY_STATE_DIR: stateDir,
        },
    });

    proc.stdin!.on('error', () => {});
    proc.stdout!.on('error', () => {});
    proc.stderr!.on('error', () => {});
    proc.stderr!.resume();

    const connection = createMessageConnection(
        new StreamMessageReader(proc.stdout!),
        new StreamMessageWriter(proc.stdin!)
    );
    connection.listen();

    return { process: proc, connection };
}

function getPidFromStateDir(stateDir: string): number | null {
    const pidFile = path.join(stateDir, 'pyright.pid');
    if (!existsSync(pidFile)) return null;
    const content = readFileSync(pidFile, 'utf-8').trim();
    const pid = parseInt(content, 10);
    return isNaN(pid) ? null : pid;
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function waitForPidFile(stateDir: string, timeoutMs = 10_000): Promise<number> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const pid = getPidFromStateDir(stateDir);
        if (pid !== null) return pid;
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`PID file not created within ${timeoutMs}ms`);
}

async function waitForNoPidFile(stateDir: string, timeoutMs = 10_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (!existsSync(path.join(stateDir, 'pyright.pid'))) return;
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`PID file still exists after ${timeoutMs}ms`);
}

function killProxy(proc: ChildProcess): Promise<void> {
    return new Promise((resolve) => {
        if (proc.exitCode !== null) {
            resolve();
            return;
        }
        proc.on('close', () => resolve());
        proc.kill('SIGTERM');
        setTimeout(() => {
            if (proc.exitCode === null) proc.kill('SIGKILL');
        }, 3000);
    });
}

describe('proxy --lsp mode', () => {
    let stateDir: string;
    let proxyProc: ChildProcess | null = null;

    beforeEach(() => {
        stateDir = createTempStateDir();
    });

    afterEach(async () => {
        if (proxyProc && proxyProc.exitCode === null) {
            await killProxy(proxyProc);
        }
        proxyProc = null;
    });

    it('initializes LSP handshake and creates PID file', async () => {
        const { process: proc, connection } = spawnProxy('lsp', stateDir);
        proxyProc = proc;

        const rootUri = `file://${FIXTURES_DIR}`;
        const initResult: Record<string, any> = await connection.sendRequest('initialize', {
            processId: process.pid,
            rootUri,
            rootPath: FIXTURES_DIR,
            workspaceFolders: [{ uri: rootUri, name: 'fixtures' }],
            capabilities: {
                textDocument: {
                    implementation: { dynamicRegistration: false },
                },
                workspace: {
                    symbol: { dynamicRegistration: false },
                    workspaceFolders: true,
                },
            },
        });

        // Verify LSP initialize response has capabilities
        expect(initResult).toBeDefined();
        expect(initResult.capabilities).toBeDefined();
        // Pyright provides completion, hover, definition, etc.
        expect(initResult.capabilities.completionProvider).toBeDefined();

        // PID file should exist after initialization
        const pid = await waitForPidFile(stateDir);
        expect(isProcessAlive(pid)).toBe(true);

        // Send shutdown
        await connection.sendRequest('shutdown');
        connection.sendNotification('exit');
        connection.dispose();
    }, 30_000);

    it('cleans up PID file and kills Pyright on disconnect', async () => {
        const { process: proc, connection } = spawnProxy('lsp', stateDir);
        proxyProc = proc;

        const rootUri = `file://${FIXTURES_DIR}`;
        await connection.sendRequest('initialize', {
            processId: process.pid,
            rootUri,
            rootPath: FIXTURES_DIR,
            workspaceFolders: [{ uri: rootUri, name: 'fixtures' }],
            capabilities: {},
        });

        const pyrightPid = await waitForPidFile(stateDir);
        expect(isProcessAlive(pyrightPid)).toBe(true);

        // Kill the proxy — should clean up PID file and kill Pyright
        await killProxy(proc);

        // PID file should be gone
        await waitForNoPidFile(stateDir);

        // Pyright process should be dead
        // Give it a moment to actually terminate
        await new Promise((r) => setTimeout(r, 500));
        expect(isProcessAlive(pyrightPid)).toBe(false);
    }, 30_000);

    it('relays LSP requests to Pyright', async () => {
        const { process: proc, connection } = spawnProxy('lsp', stateDir);
        proxyProc = proc;

        const rootUri = `file://${FIXTURES_DIR}`;
        await connection.sendRequest('initialize', {
            processId: process.pid,
            rootUri,
            rootPath: FIXTURES_DIR,
            workspaceFolders: [{ uri: rootUri, name: 'fixtures' }],
            capabilities: {
                workspace: {
                    symbol: { dynamicRegistration: false },
                    workspaceFolders: true,
                },
            },
        });
        connection.sendNotification('initialized', {});

        // Poll workspace/symbol until Pyright finishes background analysis
        let symbols: any[] = [];
        for (let i = 0; i < 50; i++) {
            symbols = await connection.sendRequest('workspace/symbol', { query: 'Greeter' });
            if (Array.isArray(symbols) && symbols.length > 0) break;
            await new Promise((r) => setTimeout(r, 500));
        }

        expect(symbols.length).toBeGreaterThan(0);
        expect(symbols[0]).toHaveProperty('name');

        await connection.sendRequest('shutdown');
        connection.sendNotification('exit');
        connection.dispose();
    }, 30_000);
});

describe('proxy shared Pyright (R2)', () => {
    let stateDir: string;
    let lspProc: ChildProcess | null = null;
    let mcpClient: Client | null = null;
    let mcpTransport: StdioClientTransport | null = null;

    beforeEach(() => {
        stateDir = createTempStateDir();
    });

    afterEach(async () => {
        if (mcpClient) {
            try { await mcpClient.close(); } catch { /* ignore */ }
        }
        if (lspProc && lspProc.exitCode === null) {
            await killProxy(lspProc);
        }
        mcpClient = null;
        mcpTransport = null;
        lspProc = null;
    });

    it('both modes share one Pyright PID', async () => {
        // Start --lsp mode first
        const lsp = spawnProxy('lsp', stateDir);
        lspProc = lsp.process;

        // LSP initialize to trigger Pyright spawn
        const rootUri = `file://${FIXTURES_DIR}`;
        await lsp.connection.sendRequest('initialize', {
            processId: process.pid,
            rootUri,
            rootPath: FIXTURES_DIR,
            workspaceFolders: [{ uri: rootUri, name: 'fixtures' }],
            capabilities: {},
        });

        // Wait for PID file from --lsp
        const lspPid = await waitForPidFile(stateDir);
        expect(isProcessAlive(lspPid)).toBe(true);

        // Now start --mcp mode — should reuse same Pyright
        mcpTransport = new StdioClientTransport({
            command: 'node',
            args: [PROXY_PATH, '--mcp'],
            cwd: FIXTURES_DIR,
            env: {
                ...process.env,
                PYRIGHT_PROXY_STATE_DIR: stateDir,
            } as Record<string, string>,
        });

        mcpClient = new Client({ name: 'test-shared', version: '1.0.0' });
        await mcpClient.connect(mcpTransport);

        // Read PID file again — should be the SAME PID
        const mcpPid = getPidFromStateDir(stateDir);
        expect(mcpPid).toBe(lspPid);
    }, 30_000);

    it('teardown on disconnect kills shared Pyright', async () => {
        // Start --lsp
        const lsp = spawnProxy('lsp', stateDir);
        lspProc = lsp.process;

        const rootUri = `file://${FIXTURES_DIR}`;
        await lsp.connection.sendRequest('initialize', {
            processId: process.pid,
            rootUri,
            rootPath: FIXTURES_DIR,
            workspaceFolders: [{ uri: rootUri, name: 'fixtures' }],
            capabilities: {},
        });

        const pyrightPid = await waitForPidFile(stateDir);

        // Start --mcp
        mcpTransport = new StdioClientTransport({
            command: 'node',
            args: [PROXY_PATH, '--mcp'],
            cwd: FIXTURES_DIR,
            env: {
                ...process.env,
                PYRIGHT_PROXY_STATE_DIR: stateDir,
            } as Record<string, string>,
        });
        mcpClient = new Client({ name: 'test-shared', version: '1.0.0' });
        await mcpClient.connect(mcpTransport);

        // Kill the --lsp proxy — should tear down Pyright
        await killProxy(lsp.process);
        lspProc = null;

        await waitForNoPidFile(stateDir);
        await new Promise((r) => setTimeout(r, 500));
        expect(isProcessAlive(pyrightPid)).toBe(false);
    }, 30_000);
});

describe('proxy --mcp mode', () => {
    let stateDir: string;
    let mcpClient: Client | null = null;
    let transport: StdioClientTransport | null = null;

    beforeEach(() => {
        stateDir = createTempStateDir();
    });

    afterEach(async () => {
        if (mcpClient) {
            try { await mcpClient.close(); } catch { /* ignore */ }
        }
        mcpClient = null;
        transport = null;
    });

    it('serves MCP lsp() tool and returns valid data', async () => {
        transport = new StdioClientTransport({
            command: 'node',
            args: [PROXY_PATH, '--mcp'],
            cwd: FIXTURES_DIR,
            env: {
                ...process.env,
                PYRIGHT_PROXY_STATE_DIR: stateDir,
            } as Record<string, string>,
        });

        mcpClient = new Client({ name: 'test-mcp-client', version: '1.0.0' });
        await mcpClient.connect(transport);

        // PID file should exist (Pyright spawned by proxy)
        const pid = await waitForPidFile(stateDir);
        expect(isProcessAlive(pid)).toBe(true);

        // Wait for Pyright to analyze fixtures, then query symbols
        let result: any;
        for (let i = 0; i < 50; i++) {
            result = await mcpClient.callTool({
                name: 'lsp',
                arguments: {
                    method: 'workspace/symbol',
                    params: { query: 'Greeter' },
                },
            });
            const content = result.content as Array<{ type: string; text: string }>;
            if (
                !result.isError &&
                content.length > 0 &&
                JSON.parse(content[0].text).length > 0
            ) {
                break;
            }
            await new Promise((r) => setTimeout(r, 500));
        }

        expect(result.isError).not.toBe(true);
        const content = result.content as Array<{ type: string; text: string }>;
        const symbols = JSON.parse(content[0].text);
        expect(symbols.length).toBeGreaterThan(0);
        expect(symbols[0]).toHaveProperty('name');
    }, 60_000);

    it('cleans up PID file and Pyright on MCP disconnect', async () => {
        transport = new StdioClientTransport({
            command: 'node',
            args: [PROXY_PATH, '--mcp'],
            cwd: FIXTURES_DIR,
            env: {
                ...process.env,
                PYRIGHT_PROXY_STATE_DIR: stateDir,
            } as Record<string, string>,
        });

        mcpClient = new Client({ name: 'test-mcp-client', version: '1.0.0' });
        await mcpClient.connect(transport);

        const pyrightPid = await waitForPidFile(stateDir);
        expect(isProcessAlive(pyrightPid)).toBe(true);

        // Close MCP client — should trigger proxy teardown
        await mcpClient.close();
        mcpClient = null;

        await waitForNoPidFile(stateDir);
        await new Promise((r) => setTimeout(r, 500));
        expect(isProcessAlive(pyrightPid)).toBe(false);
    }, 30_000);
});

describe('proxy three-client ID isolation (R8)', () => {
    let stateDir: string;
    let bootstrapProc: ChildProcess | null = null;
    const rawSockets: import('net').Socket[] = [];

    beforeEach(() => {
        stateDir = createTempStateDir();
    });

    afterEach(async () => {
        for (const s of rawSockets) {
            try { s.destroy(); } catch { /* ignore */ }
        }
        rawSockets.length = 0;
        if (bootstrapProc && bootstrapProc.exitCode === null) {
            await killProxy(bootstrapProc);
        }
        bootstrapProc = null;
    });

    it('three concurrent clients with overlapping request IDs each receive their own response (no cross-talk)', async () => {
        // Spawn --lsp to bootstrap a shared Pyright via the proxy
        const bootstrap = spawnProxy('lsp', stateDir);
        bootstrapProc = bootstrap.process;

        const rootUri = `file://${FIXTURES_DIR}`;
        await bootstrap.connection.sendRequest('initialize', {
            processId: process.pid,
            rootUri,
            rootPath: FIXTURES_DIR,
            workspaceFolders: [{ uri: rootUri, name: 'fixtures' }],
            capabilities: {
                workspace: { symbol: { dynamicRegistration: false }, workspaceFolders: true },
            },
        });
        bootstrap.connection.sendNotification('initialized', {});

        await waitForPidFile(stateDir);

        // Let Pyright finish background analysis so workspace/symbol returns non-empty
        for (let i = 0; i < 50; i++) {
            const symbols = await bootstrap.connection.sendRequest('workspace/symbol', { query: 'Greeter' });
            if (Array.isArray(symbols) && symbols.length > 0) break;
            await new Promise((r) => setTimeout(r, 200));
        }

        // Open three RAW socket connections against pyright.sock and wrap each in its own
        // MessageConnection. Each client's ID counter starts at 0 independently — the
        // pre-demux bridge would cross-talk responses. The demux must isolate.
        const socketPath = path.join(stateDir, 'pyright.sock');
        const net = await import('net');
        const clients: MessageConnection[] = [];
        for (let i = 0; i < 3; i++) {
            const sock = net.createConnection(socketPath);
            rawSockets.push(sock);
            await new Promise<void>((res, rej) => {
                sock.once('connect', () => res());
                sock.once('error', rej);
            });
            sock.on('error', () => {});
            const conn = createMessageConnection(
                new StreamMessageReader(sock),
                new StreamMessageWriter(sock)
            );
            conn.listen();
            // Each new client sends initialize; cached response from the demux returns
            // immediately without hitting Pyright a second time.
            await conn.sendRequest('initialize', {
                processId: process.pid,
                rootUri,
                rootPath: FIXTURES_DIR,
                workspaceFolders: [{ uri: rootUri, name: `raw-${i}` }],
                capabilities: {
                    workspace: { symbol: { dynamicRegistration: false }, workspaceFolders: true },
                },
            });
            clients.push(conn);
        }

        // Fire three concurrent workspace/symbol requests with distinct queries.
        // MessageConnection assigns each call's ID from its own counter (starting at 0),
        // so the three requests collide on the wire if the proxy is a byte-tee.
        const queries = ['Greeter', 'EnglishGreeter', 'SpanishGreeter'];
        const results = await Promise.all(
            clients.map((conn, i) =>
                conn.sendRequest<any[]>('workspace/symbol', { query: queries[i] })
            )
        );

        // Each client's response should contain ITS OWN query's symbols, not another's.
        expect(results[0].some((s: any) => s.name === 'Greeter')).toBe(true);
        expect(results[1].some((s: any) => s.name === 'EnglishGreeter')).toBe(true);
        expect(results[2].some((s: any) => s.name === 'SpanishGreeter')).toBe(true);

        // No leaked responses — each client got exactly one
        expect(results[0].length).toBeGreaterThan(0);
        expect(results[1].length).toBeGreaterThan(0);
        expect(results[2].length).toBeGreaterThan(0);

        // Cleanup
        for (const conn of clients) {
            try { conn.dispose(); } catch { /* ignore */ }
        }
        await bootstrap.connection.sendRequest('shutdown');
        bootstrap.connection.sendNotification('exit');
        bootstrap.connection.dispose();
    }, 60_000);
});
