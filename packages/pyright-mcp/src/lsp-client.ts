import { spawn } from 'child_process';
import {
    createMessageConnection,
    StreamMessageReader,
    StreamMessageWriter,
    MessageConnection,
} from 'vscode-jsonrpc/node';

/**
 * One-shot LSP query: spawns Pyright, initializes, sends one request, shuts down.
 * For agents that don't have MCP access — call this from the CLI entry point.
 */
export async function queryLsp(
    langserverPath: string,
    workspaceRoot: string,
    method: string,
    params: Record<string, unknown>
): Promise<unknown> {
    const proc = spawn('node', [langserverPath, '--stdio'], {
        cwd: workspaceRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Prevent unhandled stream errors from crashing
    proc.stdin!.on('error', () => {});
    proc.stdout!.on('error', () => {});
    proc.stderr!.on('error', () => {});
    proc.stderr!.resume();

    let conn: MessageConnection | null = null;

    try {
        conn = createMessageConnection(
            new StreamMessageReader(proc.stdout!),
            new StreamMessageWriter(proc.stdin!)
        );
        conn.listen();

        const rootUri = `file://${workspaceRoot}`;
        const workspaceName = workspaceRoot.split('/').pop() || 'workspace';

        await conn.sendRequest('initialize', {
            processId: process.pid,
            rootUri,
            rootPath: workspaceRoot,
            workspaceFolders: [{ uri: rootUri, name: workspaceName }],
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
        conn.sendNotification('initialized', {});

        // For workspace queries, poll until analysis produces results
        if (method === 'workspace/symbol') {
            for (let i = 0; i < 50; i++) {
                const probe = await conn.sendRequest(method, params);
                if (Array.isArray(probe) && probe.length > 0) {
                    return probe;
                }
                await new Promise((r) => setTimeout(r, 200));
            }
            return [];
        }

        // For document queries, wait for analysis first
        for (let i = 0; i < 50; i++) {
            const probe = await conn.sendRequest('workspace/symbol', { query: '' });
            if (Array.isArray(probe) && probe.length > 0) break;
            await new Promise((r) => setTimeout(r, 200));
        }

        const result = await Promise.race([
            conn.sendRequest(method, params),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(`LSP request timed out: ${method}`)), 30_000)
            ),
        ]);

        return result;
    } finally {
        if (conn) {
            try {
                await conn.sendRequest('shutdown');
                conn.sendNotification('exit');
            } catch {
                // ignore
            }
            conn.dispose();
        }
        proc.kill();
    }
}

// CLI entry point
if (require.main === module) {
    const method = process.argv[2];
    const paramsJson = process.argv[3] || '{}';

    if (!method) {
        console.error('Usage: lsp-client <method> [params_json]');
        console.error('  lsp-client workspace/symbol \'{"query": "MyClass"}\'');
        console.error('  lsp-client textDocument/implementation \'{"textDocument":{"uri":"file:///..."},"position":{"line":0,"character":0}}\'');
        process.exit(1);
    }

    const langserverPath = process.env.PYRIGHT_LANGSERVER_PATH
        || `${process.env.CLAUDE_PLUGIN_ROOT || '.'}/packages/pyright/dist/pyright-langserver.js`;

    let params: Record<string, unknown>;
    try {
        params = JSON.parse(paramsJson);
    } catch {
        console.error(`Invalid JSON: ${paramsJson}`);
        process.exit(1);
    }

    queryLsp(langserverPath, process.cwd(), method, params)
        .then((result) => {
            console.log(JSON.stringify(result, null, 2));
        })
        .catch((err) => {
            console.error(`Error: ${(err as Error).message}`);
            process.exit(1);
        });
}
