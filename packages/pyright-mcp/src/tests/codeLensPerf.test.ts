// Cold-cache codeLens/resolve perf verification.
//
// Exercises the full Pyright LSP stack against the pyright-internal test samples
// workspace (1,200+ .py files, no pyrightconfig at root — all files are user code).
// Verifies that codeLens/resolve with both "implementations" and "references" kinds
// completes within the 30s timeout the MCP server enforces on LSP requests
// (see mcp-server.ts:70).
//
// Opt-in: runs only when PYRIGHT_MCP_PERF=1 to avoid slowing default CI.
//
//   PYRIGHT_MCP_PERF=1 npx jest --testPathPattern=codeLensPerf --forceExit

import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';
import {
    createMessageConnection,
    StreamMessageReader,
    StreamMessageWriter,
    MessageConnection,
} from 'vscode-jsonrpc/node';

const LANGSERVER_PATH = path.resolve(__dirname, '../../../pyright/dist/pyright-langserver.js');
const SAMPLES_DIR = path.resolve(__dirname, '../../../pyright-internal/src/tests/samples');
const TARGET_FILE = path.join(SAMPLES_DIR, 'abstractClass1.py');
const TARGET_URI = `file://${TARGET_FILE}`;
// AbstractClassA declared at line 7 (1-indexed). LSP positions are 0-indexed.
const TARGET_LINE = 6;

// Matches mcp-server.ts:70 — this is the window within which resolve MUST complete
// for the MCP request to succeed.
const MCP_TIMEOUT_MS = 30_000;

interface Lens {
    range: { start: { line: number; character: number }; end: { line: number; character: number } };
    data?: { uri?: string; position?: { line: number; character: number }; kind?: string };
    command?: { title: string; command: string };
}

interface Session {
    proc: ReturnType<typeof spawn>;
    conn: MessageConnection;
}

function openSession(): Session {
    const proc = spawn('node', [LANGSERVER_PATH, '--stdio'], {
        cwd: SAMPLES_DIR,
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    proc.stdin!.on('error', () => {});
    proc.stdout!.on('error', () => {});
    proc.stderr!.on('error', () => {});
    proc.stderr!.resume();

    const conn = createMessageConnection(
        new StreamMessageReader(proc.stdout!),
        new StreamMessageWriter(proc.stdin!)
    );
    conn.listen();
    return { proc, conn };
}

async function initializeWorkspace(conn: MessageConnection): Promise<void> {
    const rootUri = `file://${SAMPLES_DIR}`;
    await conn.sendRequest('initialize', {
        processId: process.pid,
        rootUri,
        rootPath: SAMPLES_DIR,
        workspaceFolders: [{ uri: rootUri, name: 'samples' }],
        capabilities: {
            textDocument: {
                codeLens: { dynamicRegistration: false },
                implementation: { dynamicRegistration: false },
            },
            workspace: { workspaceFolders: true },
        },
    });
    conn.sendNotification('initialized', {});
}

async function openTargetFile(conn: MessageConnection): Promise<void> {
    const text = readFileSync(TARGET_FILE, 'utf-8');
    conn.sendNotification('textDocument/didOpen', {
        textDocument: { uri: TARGET_URI, languageId: 'python', version: 1, text },
    });
}

async function closeSession(session: Session): Promise<void> {
    try {
        await session.conn.sendRequest('shutdown');
        session.conn.sendNotification('exit');
    } catch {
        // ignore
    }
    session.conn.dispose();
    await new Promise((r) => setImmediate(r));
    session.proc.kill();
}

function findLens(lenses: Lens[], kind: 'references' | 'implementations', line: number): Lens | undefined {
    return lenses.find((l) => l.data?.kind === kind && l.range.start.line === line);
}

async function resolveWithTimeout(conn: MessageConnection, lens: Lens): Promise<Lens> {
    return Promise.race<Lens>([
        conn.sendRequest('codeLens/resolve', lens) as Promise<Lens>,
        new Promise<never>((_, reject) =>
            setTimeout(
                () => reject(new Error(`codeLens/resolve exceeded MCP timeout of ${MCP_TIMEOUT_MS}ms`)),
                MCP_TIMEOUT_MS
            )
        ),
    ]);
}

const runTests = process.env.PYRIGHT_MCP_PERF === '1' ? describe : describe.skip;

runTests('codeLens/resolve cold-cache perf (PYRIGHT_MCP_PERF=1)', () => {
    it('implementations kind resolves within MCP timeout against samples workspace', async () => {
        const session = openSession();
        try {
            await initializeWorkspace(session.conn);
            await openTargetFile(session.conn);

            const lenses = (await session.conn.sendRequest('textDocument/codeLens', {
                textDocument: { uri: TARGET_URI },
            })) as Lens[];
            expect(Array.isArray(lenses)).toBe(true);

            const implLens = findLens(lenses, 'implementations', TARGET_LINE);
            expect(implLens).toBeDefined();

            const t0 = Date.now();
            const resolved = await resolveWithTimeout(session.conn, implLens!);
            const elapsed = Date.now() - t0;

            process.stderr.write(
                `[perf] codeLens/resolve implementations cold-cache: ${elapsed}ms\n`
            );

            expect(resolved.command).toBeDefined();
            // AbstractClassA has 2 subclasses (AbstractClassB, AbstractClassC) in the same file.
            expect(resolved.command?.title).toMatch(/^\d+ implementation/);
        } finally {
            await closeSession(session);
        }
    }, 90_000);

    it('references kind resolves within MCP timeout against samples workspace', async () => {
        const session = openSession();
        try {
            await initializeWorkspace(session.conn);
            await openTargetFile(session.conn);

            const lenses = (await session.conn.sendRequest('textDocument/codeLens', {
                textDocument: { uri: TARGET_URI },
            })) as Lens[];
            expect(Array.isArray(lenses)).toBe(true);

            const refLens = findLens(lenses, 'references', TARGET_LINE);
            expect(refLens).toBeDefined();

            const t0 = Date.now();
            const resolved = await resolveWithTimeout(session.conn, refLens!);
            const elapsed = Date.now() - t0;

            process.stderr.write(
                `[perf] codeLens/resolve references cold-cache: ${elapsed}ms\n`
            );

            expect(resolved.command).toBeDefined();
            expect(resolved.command?.title).toMatch(/^\d+ reference/);
        } finally {
            await closeSession(session);
        }
    }, 90_000);
});
