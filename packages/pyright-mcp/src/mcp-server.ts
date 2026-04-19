import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { existsSync, readFileSync } from 'fs';
import { isAbsolute } from 'path';
import { MessageConnection, RequestType } from 'vscode-jsonrpc/node';
import { z } from 'zod';
import { decodeSemanticTokens, type TokenLegend } from './decode-semantic-tokens';
import { fetchFileIntelligence } from './fetch-file-intelligence';

export type { TokenLegend } from './decode-semantic-tokens';

/**
 * Create an MCP server that bridges to an already-initialized LSP connection.
 * The caller owns the LSP connection lifecycle (spawn, initialize, shutdown).
 */
export function createMcpServer(lspConnection: MessageConnection) {
    const server = new McpServer({
        name: 'pyright',
        version: '0.1.0',
    });

    let tokenLegend: TokenLegend | null = null;
    const openedUris = new Set<string>();

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
            if (!lspConnection) {
                return {
                    content: [{ type: 'text' as const, text: 'Pyright langserver is not running' }],
                    isError: true,
                };
            }

            try {
                // For document queries, send didOpen to trigger full type checking.
                // Without this, Pyright only parses/binds — the type evaluator won't
                // infer return types until the file is opened for editing.
                let justOpened = false;
                if (
                    method.startsWith('textDocument/') &&
                    !method.startsWith('textDocument/did')
                ) {
                    const uri = (params as { textDocument?: { uri?: string } }).textDocument?.uri;
                    if (uri && uri.startsWith('file://') && !openedUris.has(uri)) {
                        const filePath = decodeURIComponent(new URL(uri).pathname);
                        const text = readFileSync(filePath, 'utf-8');
                        lspConnection.sendNotification('textDocument/didOpen', {
                            textDocument: { uri, languageId: 'python', version: 1, text },
                        });
                        openedUris.add(uri);
                        justOpened = true;
                    }
                }

                // If we just opened a file, wait for Pyright to analyze it
                if (justOpened) {
                    await new Promise((r) => setTimeout(r, 500));
                }

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

    // Register file_intelligence() tool
    server.registerTool(
        'file_intelligence',
        {
            description:
                'Return a <file-intelligence> block for a .py file combining codeLens counts, ' +
                'semantic classifications (abstract/protocol/override), and inlay Type hints.',
            inputSchema: {
                path: z.string().describe('Absolute path to a .py file'),
            },
        },
        async ({ path: filePath }) => {
            const errorResult = (msg: string) => ({
                content: [{ type: 'text' as const, text: msg }],
                isError: true,
            });

            if (!lspConnection) {
                return errorResult('Pyright langserver is not running');
            }
            if (!isAbsolute(filePath)) {
                return errorResult(`file_intelligence requires an absolute path, got: ${filePath}`);
            }
            if (!filePath.endsWith('.py')) {
                return errorResult(`file_intelligence only accepts .py files, got: ${filePath}`);
            }
            if (!existsSync(filePath)) {
                return errorResult(`file does not exist: ${filePath}`);
            }
            if (!tokenLegend) {
                return errorResult('tokenLegend not set — MCP server not fully initialized');
            }

            const result = await fetchFileIntelligence(
                lspConnection,
                filePath,
                tokenLegend,
                openedUris
            );
            if ('error' in result) {
                return errorResult(result.error);
            }
            return {
                content: [{ type: 'text' as const, text: result.block }],
            };
        }
    );

    return {
        server,
        setTokenLegend: (legend: TokenLegend) => {
            tokenLegend = legend;
        },
    };
}
