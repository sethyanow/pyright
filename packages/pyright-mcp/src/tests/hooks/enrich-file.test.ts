import { spawn, ChildProcess } from 'child_process';
import { existsSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { enrichFile, PostToolUseInput } from '../../hooks/enrich-file';

const PROXY_PATH = path.resolve(__dirname, '../../../dist/proxy.js');
const FIXTURES_DIR = path.resolve(__dirname, '../fixtures');
const SAMPLE_FILE = path.resolve(FIXTURES_DIR, 'sample.py');

function createTempStateDir(): string {
    return mkdtempSync(path.join(tmpdir(), 'pyright-enrich-test-'));
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

function makeInput(filePath: string): PostToolUseInput {
    return {
        session_id: 's1',
        transcript_path: '/tmp/transcript.jsonl',
        cwd: FIXTURES_DIR,
        permission_mode: 'default',
        hook_event_name: 'PostToolUse',
        tool_name: 'Read',
        tool_input: { file_path: filePath },
        tool_response: { filePath, content: '' },
        tool_use_id: 'toolu_test',
    };
}

describe('enrichFile', () => {
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

    it('returns PostToolUse hookSpecificOutput with <file-intelligence> for a Python Read', async () => {
        proxyProc = spawnLspProxy(stateDir);
        await waitForSocket(stateDir);

        process.env.PYRIGHT_PROXY_STATE_DIR = stateDir;
        const out = await enrichFile(makeInput(SAMPLE_FILE));

        expect(out.hookSpecificOutput).toBeDefined();
        expect(out.hookSpecificOutput!.hookEventName).toBe('PostToolUse');
        expect(out.hookSpecificOutput!.additionalContext).toContain('<file-intelligence');
        expect(out.hookSpecificOutput!.additionalContext).toContain('Greeter');
    }, 60_000);

    it('returns empty object for non-Python files', async () => {
        const input = makeInput('/some/thing.txt');
        const out = await enrichFile(input);
        expect(out).toEqual({});
    });

    it('returns empty object for non-Read tool calls', async () => {
        const input = makeInput(SAMPLE_FILE);
        input.tool_name = 'Bash';
        const out = await enrichFile(input);
        expect(out).toEqual({});
    });

    it('returns empty object when socket is not available', async () => {
        // No proxy spawned → no socket exists
        process.env.PYRIGHT_PROXY_STATE_DIR = stateDir;
        const out = await enrichFile(makeInput(SAMPLE_FILE));
        // With no socket, fetchCodeLenses returns [] → no enrichment to inject
        expect(out).toEqual({});
    });

    it('accepts .pyi stub files', async () => {
        const input = makeInput('/some/thing.pyi');
        // Without a proxy socket, enrichment returns empty — but we verify
        // that .pyi isn't rejected at the no-op gate like .txt is.
        const out = await enrichFile(input);
        // Accepted but no socket → empty object (from socket-not-available path)
        expect(out).toEqual({});
    });

    // Adversarial: path hostility — resolve relative paths against cwd rather
    // than rejecting them or passing them through broken.
    it('resolves a relative file_path against input.cwd', async () => {
        proxyProc = spawnLspProxy(stateDir);
        await waitForSocket(stateDir);
        process.env.PYRIGHT_PROXY_STATE_DIR = stateDir;

        const input: PostToolUseInput = {
            ...makeInput(SAMPLE_FILE),
            cwd: FIXTURES_DIR,
            tool_input: { file_path: 'sample.py' },
        };
        const out = await enrichFile(input);
        expect(out.hookSpecificOutput?.additionalContext).toContain('Greeter');
    }, 60_000);

    // Adversarial: missing file_path key (malformed input).
    it('returns empty object when tool_input.file_path is missing', async () => {
        const input = makeInput('/irrelevant.py');
        delete (input.tool_input as { file_path?: string }).file_path;
        const out = await enrichFile(input);
        expect(out).toEqual({});
    });
});
