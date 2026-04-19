import path from 'path';
import { fetchCodeLenses } from './socket-lsp-client';
import { formatFileIntelligence } from './format-block';

export interface PostToolUseInput {
    session_id: string;
    transcript_path: string;
    cwd: string;
    permission_mode: string;
    hook_event_name: 'PostToolUse';
    tool_name: string;
    tool_input: { file_path?: string; [key: string]: unknown };
    tool_response: unknown;
    tool_use_id: string;
}

export interface HookOutput {
    continue?: boolean;
    suppressOutput?: boolean;
    hookSpecificOutput?: {
        hookEventName: 'PostToolUse';
        additionalContext: string;
    };
}

function isPythonFile(p: string): boolean {
    return p.endsWith('.py') || p.endsWith('.pyi');
}

function resolveSocketPath(): string | null {
    const dir = process.env.PYRIGHT_PROXY_STATE_DIR || process.env.CLAUDE_PLUGIN_DATA;
    if (!dir) return null;
    return path.join(dir, 'pyright.sock');
}

export async function enrichFile(input: PostToolUseInput): Promise<HookOutput> {
    if (input.tool_name !== 'Read') return {};
    const rawPath = input.tool_input?.file_path;
    if (typeof rawPath !== 'string' || !rawPath) return {};
    if (!isPythonFile(rawPath)) return {};

    const filePath = path.isAbsolute(rawPath) ? rawPath : path.resolve(input.cwd || process.cwd(), rawPath);

    const socketPath = resolveSocketPath();
    if (!socketPath) return {};

    const lenses = await fetchCodeLenses(socketPath, filePath);
    if (lenses.length === 0) return {};

    const block = formatFileIntelligence(filePath, lenses);
    return {
        hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            additionalContext: block,
        },
    };
}

async function readStdinJson<T>(): Promise<T> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(chunk as Buffer);
    }
    const raw = Buffer.concat(chunks).toString('utf-8').trim();
    if (!raw) return {} as T;
    return JSON.parse(raw) as T;
}

if (require.main === module) {
    readStdinJson<PostToolUseInput>()
        .then(enrichFile)
        .then((output) => {
            process.stdout.write(JSON.stringify(output));
        })
        .catch((err) => {
            process.stderr.write(`enrich-file error: ${(err as Error).message}\n`);
        })
        .finally(() => {
            process.exit(0);
        });
}
