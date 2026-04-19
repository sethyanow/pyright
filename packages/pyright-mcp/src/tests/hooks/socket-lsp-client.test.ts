import { spawn, ChildProcess } from 'child_process';
import { existsSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fetchCodeLenses, fetchFileIntelligence } from '../../hooks/socket-lsp-client';

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

    it('does not throw when the socket is destroyed mid-request (combined fetch still resolves)', async () => {
        // Simulates a proxy crash mid-session. Whatever data had already arrived must be returned;
        // the combined fetch must resolve to an object shape, never reject.
        proxyProc = spawnLspProxy(stateDir);
        const sockPath = await waitForSocket(stateDir);

        // Fire fetch and destroy the proxy shortly after to simulate mid-request collapse.
        const fetchPromise = fetchFileIntelligence(sockPath, SAMPLE_FILE);
        setTimeout(() => {
            if (proxyProc && proxyProc.exitCode === null) proxyProc.kill('SIGKILL');
        }, 500);

        const intel = await fetchPromise;
        expect(intel).toEqual(expect.objectContaining({
            codeLenses: expect.any(Array),
            inlayHints: expect.any(Array),
        }));
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

describe('fetchFileIntelligence', () => {
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

    it('returns codeLenses and Type inlayHints from the same socket session', async () => {
        proxyProc = spawnLspProxy(stateDir);
        const sockPath = await waitForSocket(stateDir);

        const intel = await fetchFileIntelligence(sockPath, SAMPLE_FILE);

        // CodeLens anchor — Greeter ABC has two concrete subclasses.
        expect(Array.isArray(intel.codeLenses)).toBe(true);
        const greeter = intel.codeLenses.find((l) => l.symbol === 'Greeter');
        expect(greeter).toBeDefined();
        expect(greeter!.implementations).toBeGreaterThanOrEqual(2);

        // Inlay anchor — sample.py's unannotated functions/vars return int,
        // so at least one inlay label must contain 'int'.
        expect(Array.isArray(intel.inlayHints)).toBe(true);
        expect(intel.inlayHints.length).toBeGreaterThan(0);
        expect(intel.inlayHints.some((h) => /int/.test(h.label))).toBe(true);

        // Every inlay entry has numeric line and non-empty string label.
        for (const h of intel.inlayHints) {
            expect(typeof h.line).toBe('number');
            expect(typeof h.label).toBe('string');
            expect(h.label.length).toBeGreaterThan(0);
        }

        // Parameter hints (InlayHintKind.Parameter, 2) must be filtered.
        // Parameter hints are labels like `x=` or `y=` appearing at call-site arguments.
        // Type hints start with `:` or `->` (from sample.py's return-type / variable-type positions).
        for (const h of intel.inlayHints) {
            const looksLikeParamName = /^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(h.label.trim());
            expect(looksLikeParamName).toBe(false);
        }
    }, 60_000);

    it('returns { codeLenses: [], inlayHints: [] } when socket does not exist', async () => {
        const missingSock = path.join(stateDir, 'does-not-exist.sock');
        const intel = await fetchFileIntelligence(missingSock, SAMPLE_FILE);
        expect(intel).toEqual({ codeLenses: [], inlayHints: [] });
    }, 10_000);
});
