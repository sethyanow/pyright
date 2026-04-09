import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { spawn, ChildProcess } from 'child_process';
import {
    createMessageConnection,
    StreamMessageReader,
    StreamMessageWriter,
    MessageConnection,
    RequestType,
} from 'vscode-jsonrpc/node';
import { z } from 'zod';
import { decodeSemanticTokens, TokenLegend } from './decode-semantic-tokens';
import { resolveLangserverPath } from './resolve-langserver-path';

export async function createMcpServer(langserverPath: string, workspaceRoot: string) {
    const server = new McpServer({
        name: 'pyright',
        version: '0.1.0',
    });

    let pyrightProcess: ChildProcess | null = null;
    let lspConnection: MessageConnection | null = null;
    let initPromise: Promise<void> | null = null;
    let initError: string | null = null;
    let tokenLegend: TokenLegend | null = null;

    // Spawn Pyright and run LSP initialize
    function startPyright(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            try {
                pyrightProcess = spawn('node', [langserverPath, '--stdio'], {
                    cwd: workspaceRoot,
                    stdio: ['pipe', 'pipe', 'pipe'],
                });

                pyrightProcess.on('error', (err) => {
                    initError = `Pyright langserver failed to start: ${err.message}`;
                    reject(new Error(initError));
                });

                pyrightProcess.on('close', (code) => {
                    if (code !== null && code !== 0) {
                        initError = `Pyright langserver exited with code ${code}`;
                    }
                    lspConnection = null;
                    pyrightProcess = null;
                });

                if (!pyrightProcess.stdin || !pyrightProcess.stdout) {
                    const msg = 'Pyright langserver failed to start: no stdio streams';
                    initError = msg;
                    reject(new Error(msg));
                    return;
                }

                // Prevent unhandled stream errors from crashing the process
                pyrightProcess.stdin.on('error', () => {});
                pyrightProcess.stdout.on('error', () => {});
                if (pyrightProcess.stderr) {
                    pyrightProcess.stderr.on('error', () => {});
                    pyrightProcess.stderr.resume(); // drain stderr
                }

                lspConnection = createMessageConnection(
                    new StreamMessageReader(pyrightProcess.stdout),
                    new StreamMessageWriter(pyrightProcess.stdin)
                );

                lspConnection.listen();

                // Run LSP initialize handshake
                const rootUri = `file://${workspaceRoot}`;
                const workspaceName = workspaceRoot.split('/').pop() || 'workspace';

                lspConnection
                    .sendRequest('initialize', {
                        processId: process.pid,
                        rootUri,
                        rootPath: workspaceRoot,
                        workspaceFolders: [
                            { uri: rootUri, name: workspaceName },
                        ],
                        capabilities: {
                            textDocument: {
                                implementation: {
                                    dynamicRegistration: false,
                                },
                                semanticTokens: {
                                    dynamicRegistration: false,
                                    requests: { full: true, range: true },
                                    tokenTypes: [],
                                    tokenModifiers: [],
                                },
                            },
                            workspace: {
                                symbol: {
                                    dynamicRegistration: false,
                                },
                                workspaceFolders: true,
                            },
                        },
                    })
                    .then((initResult: unknown) => {
                        const result = initResult as Record<string, any> | undefined;
                        // Capture token legend from server capabilities
                        const legend = result?.capabilities?.semanticTokensProvider?.legend;
                        if (legend) {
                            tokenLegend = legend;
                        }
                        // Send initialized notification
                        lspConnection!.sendNotification('initialized', {});
                        resolve();
                    })
                    .catch((err: Error) => {
                        initError = `LSP initialize failed: ${err.message}`;
                        reject(new Error(initError));
                    });
            } catch (err) {
                const msg = `Pyright langserver failed to start: ${(err as Error).message}`;
                initError = msg;
                reject(new Error(msg));
            }
        });
    }

    initPromise = startPyright();

    // Register lsp() tool
    server.registerTool(
        'lsp',
        {
            description: 'Send an LSP request to the Pyright language server',
            inputSchema: {
                method: z.string().describe('LSP method name (e.g., "textDocument/implementation")'),
                params: z.record(z.string(), z.any()).describe('LSP request parameters'),
            },
        },
        async ({ method, params }) => {
            // Gate on init
            if (initPromise) {
                try {
                    await initPromise;
                } catch {
                    // initError is already set
                }
            }

            if (initError) {
                return {
                    content: [{ type: 'text' as const, text: initError }],
                    isError: true,
                };
            }

            if (!lspConnection) {
                return {
                    content: [{ type: 'text' as const, text: 'Pyright langserver is not running' }],
                    isError: true,
                };
            }

            try {
                const requestType = new RequestType<Record<string, unknown>, unknown, void>(method);
                const result = await Promise.race([
                    lspConnection.sendRequest(requestType, params as Record<string, unknown>),
                    new Promise<never>((_, reject) =>
                        setTimeout(() => reject(new Error(`LSP request timed out after 30s: ${method}`)), 30_000)
                    ),
                ]);

                // Decode semantic token responses into human-readable format
                if (method.startsWith('textDocument/semanticTokens/') && tokenLegend) {
                    const raw = result as { data?: number[] } | null;
                    if (raw?.data && Array.isArray(raw.data)) {
                        const decoded = decodeSemanticTokens(raw.data, tokenLegend);
                        return {
                            content: [{ type: 'text' as const, text: JSON.stringify(decoded, null, 2) }],
                        };
                    }
                    // Empty or null result → empty array
                    return {
                        content: [{ type: 'text' as const, text: JSON.stringify([]) }],
                    };
                }

                return {
                    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
                };
            } catch (err) {
                return {
                    content: [{ type: 'text' as const, text: `LSP error: ${(err as Error).message}` }],
                    isError: true,
                };
            }
        }
    );

    async function shutdown() {
        const conn = lspConnection;
        const proc = pyrightProcess;
        lspConnection = null;
        pyrightProcess = null;

        if (conn) {
            try {
                await conn.sendRequest('shutdown');
                conn.sendNotification('exit');
            } catch {
                // Ignore errors during shutdown
            }
            conn.dispose();
        }
        if (proc) {
            proc.kill();
            // Wait for process to actually exit
            await new Promise<void>((resolve) => {
                if (proc.exitCode !== null) {
                    resolve();
                } else {
                    proc.on('close', () => resolve());
                    // Force kill after 2s
                    setTimeout(() => {
                        proc.kill('SIGKILL');
                        resolve();
                    }, 2000);
                }
            });
        }
    }

    return { server, shutdown };
}

// When run directly as stdio MCP server
if (require.main === module) {
    const langserverPath = resolveLangserverPath();
    const workspaceRoot = process.cwd();

    createMcpServer(langserverPath, workspaceRoot).then(async ({ server }) => {
        const transport = new StdioServerTransport();
        await server.connect(transport);
    }).catch((err) => {
        console.error('Failed to start MCP server:', err);
        process.exit(1);
    });
}
