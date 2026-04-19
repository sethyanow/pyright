/**
 * Unit + integration tests for the PostToolUse enrichment hook (pyr-smw).
 *
 * Unit-level: shouldEnrich() gating logic.
 * Integration-level: spawns the built dist/hooks/enrich-file.js and feeds it
 * a synthetic PostToolUse JSON payload.
 */
import { spawn } from 'child_process';
import { existsSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { shouldEnrich } from '../hooks/enrich-file';

const HOOK_PATH = path.resolve(__dirname, '../../dist/hooks/enrich-file.js');
const FIXTURES_DIR = path.resolve(__dirname, 'fixtures');
const SAMPLE_PY = path.resolve(FIXTURES_DIR, 'sample.py');

describe('shouldEnrich (gating)', () => {
    const absPyPath = '/abs/path/to/file.py';

    it('accepts Read with absolute .py path', () => {
        expect(
            shouldEnrich({
                tool_name: 'Read',
                tool_input: { file_path: absPyPath },
            })
        ).toBe(true);
    });

    it('accepts Edit with absolute .py path', () => {
        expect(
            shouldEnrich({
                tool_name: 'Edit',
                tool_input: { file_path: absPyPath },
            })
        ).toBe(true);
    });

    it('accepts Write with absolute .py path', () => {
        expect(
            shouldEnrich({
                tool_name: 'Write',
                tool_input: { file_path: absPyPath },
            })
        ).toBe(true);
    });

    it('rejects Bash tool', () => {
        expect(
            shouldEnrich({
                tool_name: 'Bash',
                tool_input: { file_path: absPyPath },
            })
        ).toBe(false);
    });

    it('rejects Grep tool', () => {
        expect(
            shouldEnrich({
                tool_name: 'Grep',
                tool_input: { file_path: absPyPath },
            })
        ).toBe(false);
    });

    it('rejects relative .py path', () => {
        expect(
            shouldEnrich({
                tool_name: 'Read',
                tool_input: { file_path: 'relative/path.py' },
            })
        ).toBe(false);
    });

    it('rejects .pyi file (out of scope for Sub-task B)', () => {
        expect(
            shouldEnrich({
                tool_name: 'Read',
                tool_input: { file_path: '/abs/path/stub.pyi' },
            })
        ).toBe(false);
    });

    it('rejects non-.py extension', () => {
        expect(
            shouldEnrich({
                tool_name: 'Read',
                tool_input: { file_path: '/abs/path/config.toml' },
            })
        ).toBe(false);
    });

    it('rejects missing file_path', () => {
        expect(
            shouldEnrich({
                tool_name: 'Read',
                tool_input: {},
            })
        ).toBe(false);
    });

    it('rejects non-string file_path', () => {
        expect(
            shouldEnrich({
                tool_name: 'Read',
                tool_input: { file_path: 42 as unknown as string },
            })
        ).toBe(false);
    });
});

interface RunHookOpts {
    stdin: string;
    env?: Record<string, string | undefined>;
    mergeEnv?: boolean; // defaults true — spread process.env first
}

function runHook(opts: RunHookOpts): Promise<{ stdout: string; exitCode: number | null }> {
    return new Promise((resolve, reject) => {
        const baseEnv = opts.mergeEnv === false ? {} : process.env;
        const env: NodeJS.ProcessEnv = { ...baseEnv };
        for (const [k, v] of Object.entries(opts.env ?? {})) {
            if (v === undefined) delete env[k];
            else env[k] = v;
        }

        const proc = spawn('node', [HOOK_PATH], {
            cwd: FIXTURES_DIR,
            stdio: ['pipe', 'pipe', 'pipe'],
            env,
        });

        let stdout = '';
        proc.stdout!.on('data', (chunk) => {
            stdout += String(chunk);
        });
        proc.stderr!.resume();

        proc.on('error', reject);
        proc.on('close', (exitCode) => {
            resolve({ stdout, exitCode });
        });

        proc.stdin!.write(opts.stdin);
        proc.stdin!.end();
    });
}

describe('enrich-file hook (integration)', () => {
    it('emits hookSpecificOutput.additionalContext with file-intelligence block for .py Read', async () => {
        expect(existsSync(HOOK_PATH)).toBe(true);
        const stateDir = mkdtempSync(path.join(tmpdir(), 'pyright-hook-test-'));
        const payload = {
            session_id: 'test',
            transcript_path: '/tmp/transcript.jsonl',
            cwd: FIXTURES_DIR,
            permission_mode: 'default',
            hook_event_name: 'PostToolUse',
            tool_name: 'Read',
            tool_input: { file_path: SAMPLE_PY },
            tool_response: { success: true },
            tool_use_id: 'toolu_test',
        };
        const { stdout, exitCode } = await runHook({
            stdin: JSON.stringify(payload),
            env: { PYRIGHT_PROXY_STATE_DIR: stateDir },
        });
        expect(exitCode).toBe(0);
        const parsed = JSON.parse(stdout);
        expect(parsed.hookSpecificOutput).toBeDefined();
        expect(parsed.hookSpecificOutput.hookEventName).toBe('PostToolUse');
        expect(parsed.hookSpecificOutput.additionalContext).toContain('<file-intelligence');
        expect(parsed.hookSpecificOutput.additionalContext).toContain('class Greeter');
    }, 60_000);
});

describe('enrich-file hook (error paths — silent fail contract)', () => {
    it('invalid JSON on stdin → {} + exit 0', async () => {
        const { stdout, exitCode } = await runHook({
            stdin: 'not valid json',
            env: { PYRIGHT_PROXY_STATE_DIR: '/tmp/does-not-matter' },
        });
        expect(exitCode).toBe(0);
        expect(stdout.trim()).toBe('{}');
    }, 15_000);

    it('PYRIGHT_PROXY_STATE_DIR and CLAUDE_PLUGIN_DATA unset → {} + exit 0', async () => {
        const payload = {
            tool_name: 'Read',
            tool_input: { file_path: SAMPLE_PY },
        };
        const { stdout, exitCode } = await runHook({
            stdin: JSON.stringify(payload),
            env: {
                PYRIGHT_PROXY_STATE_DIR: undefined,
                CLAUDE_PLUGIN_DATA: undefined,
            },
        });
        expect(exitCode).toBe(0);
        expect(stdout.trim()).toBe('{}');
    }, 15_000);

    it('non-gated tool (Bash) → {} + exit 0 (without spawning Pyright)', async () => {
        const payload = {
            tool_name: 'Bash',
            tool_input: { command: 'ls' },
        };
        const { stdout, exitCode } = await runHook({
            stdin: JSON.stringify(payload),
            env: { PYRIGHT_PROXY_STATE_DIR: '/tmp/unused' },
        });
        expect(exitCode).toBe(0);
        expect(stdout.trim()).toBe('{}');
    }, 15_000);
});
