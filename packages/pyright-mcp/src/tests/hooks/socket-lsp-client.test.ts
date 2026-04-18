import { spawn, ChildProcess } from 'child_process';
import { existsSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fetchCodeLenses } from '../../hooks/socket-lsp-client';

const PROXY_PATH = path.resolve(__dirname, '../../../dist/proxy.js');
const FIXTURES_DIR = path.resolve(__dirname, '../fixtures');
const SAMPLE_FILE = path.resolve(FIXTURES_DIR, 'sample.py');

function createTempStateDir(): string {
    return mkdtempSync(path.join(tmpdir(), 'pyright-hook-test-'));
}

function spawnLspProxy(stateDir: string): ChildProcess {
    const proc = spawn('node', [PROXY_PATH, '--lsp'], {
        cwd: FIXTURES_DIR,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYRIGHT_PROXY_STATE_DIR: stateDir },
    });
    proc.stdin!.on('error', () => {});
    proc.stdout!.on('error', () => {});
    proc.stderr!.on('error', () => {});
    proc.stderr!.resume();
    return proc;
}

async function waitForSocket(stateDir: string, timeoutMs = 10_000): Promise<string> {
    const sockPath = path.join(stateDir, 'pyright.sock');
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (existsSync(sockPath)) return sockPath;
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`socket ${sockPath} not created within ${timeoutMs}ms`);
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

describe('fetchCodeLenses', () => {
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

    it('returns resolved code lenses for an ABC with subclasses', async () => {
        proxyProc = spawnLspProxy(stateDir);
        const sockPath = await waitForSocket(stateDir);

        const lenses = await fetchCodeLenses(sockPath, SAMPLE_FILE);

        expect(Array.isArray(lenses)).toBe(true);
        expect(lenses.length).toBeGreaterThan(0);

        // Greeter ABC has EnglishGreeter + SpanishGreeter as subclasses
        const greeter = lenses.find((l) => l.symbol === 'Greeter');
        expect(greeter).toBeDefined();
        expect(greeter!.implementations).toBeGreaterThanOrEqual(2);

        // Every resolved lens has a numeric line and a symbol name
        for (const l of lenses) {
            expect(typeof l.line).toBe('number');
            expect(typeof l.symbol).toBe('string');
            expect(l.symbol.length).toBeGreaterThan(0);
        }
    }, 60_000);

    it('resolves with empty array when socket path does not exist', async () => {
        const missingSock = path.join(stateDir, 'does-not-exist.sock');
        const lenses = await fetchCodeLenses(missingSock, SAMPLE_FILE);
        expect(lenses).toEqual([]);
    }, 10_000);

    it('resolves with empty array when the file does not exist', async () => {
        proxyProc = spawnLspProxy(stateDir);
        const sockPath = await waitForSocket(stateDir);

        const lenses = await fetchCodeLenses(sockPath, '/nonexistent/path.py');
        expect(lenses).toEqual([]);
    }, 30_000);

    it('resolves with empty array when the socket accepts but never responds (inner timeout)', async () => {
        const net = require('net') as typeof import('net');
        const serverSockets = new Set<import('net').Socket>();
        const sockPath = path.join(stateDir, 'silent.sock');
        const srv = await new Promise<import('net').Server>((resolve) => {
            const server = net.createServer((c) => {
                serverSockets.add(c);
                c.on('close', () => serverSockets.delete(c));
                // Accept; never write.
            });
            server.listen(sockPath, () => resolve(server));
        });

        try {
            const start = Date.now();
            const lenses = await fetchCodeLenses(sockPath, SAMPLE_FILE);
            const elapsed = Date.now() - start;
            expect(lenses).toEqual([]);
            expect(elapsed).toBeLessThan(8500);
        } finally {
            for (const s of serverSockets) s.destroy();
            srv.close();
            srv.unref();
        }
    }, 15_000);
});
