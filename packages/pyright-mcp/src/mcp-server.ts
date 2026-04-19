import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { existsSync, readFileSync } from 'fs';
import { isAbsolute } from 'path';
import { MessageConnection, RequestType } from 'vscode-jsonrpc/node';
import { z } from 'zod';
import { decodeSemanticTokens, type TokenLegend } from './decode-semantic-tokens';
import {
    formatFileIntelligence,
    type ResolvedCodeLens,
    type TypeInlay,
} from './format-file-intelligence';

export type { TokenLegend } from './decode-semantic-tokens';

type LspRange = { start: { line: number; character: number }; end: { line: number; character: number } };
type LspPosition = { line: number; character: number };
type LspCodeLens = {
    range: LspRange;
    // Lens action object (populated by codeLens/resolve). We only read .title.
    [key: string]: unknown;
};
type LspInlayHint = {
    position: LspPosition;
    label: string | Array<{ value: string }>;
    kind?: number; // 1 = Type, 2 = Parameter
};

function extractCount(title: string | undefined): number {
    if (!title) return 0;
    const m = /^(\d+)\s+/.exec(title);
    return m ? Number(m[1]) : 0;
}

function inlayLabelString(label: string | Array<{ value: string }>): string {
    if (typeof label === 'string') return label;
    return label.map((p) => p.value).join('');
}

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

            let sourceText: string;
            try {
                sourceText = readFileSync(filePath, 'utf-8');
            } catch (err) {
                return errorResult(`failed to read file: ${(err as Error).message}`);
            }

            const uri = `file://${filePath}`;
            if (!openedUris.has(uri)) {
                lspConnection.sendNotification('textDocument/didOpen', {
                    textDocument: { uri, languageId: 'python', version: 1, text: sourceText },
                });
                openedUris.add(uri);
                await new Promise((r) => setTimeout(r, 500));
            }

            const totalLines = sourceText.split('\n').length;
            const timeoutMs = 30_000;
            const withTimeout = <T>(p: Promise<T>, label: string): Promise<T> =>
                Promise.race([
                    p,
                    new Promise<T>((_, reject) =>
                        setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
                    ),
                ]);

            const codeLensReq = new RequestType<{ textDocument: { uri: string } }, LspCodeLens[] | null, void>(
                'textDocument/codeLens'
            );
            const inlayHintReq = new RequestType<
                { textDocument: { uri: string }; range: LspRange },
                LspInlayHint[] | null,
                void
            >('textDocument/inlayHint');
            const semanticTokensReq = new RequestType<
                { textDocument: { uri: string } },
                { data?: number[] } | null,
                void
            >('textDocument/semanticTokens/full');
            const codeLensResolveReq = new RequestType<LspCodeLens, LspCodeLens, void>('codeLens/resolve');

            const [lensesRes, hintsRes, tokensRes] = await Promise.allSettled([
                withTimeout(lspConnection.sendRequest(codeLensReq, { textDocument: { uri } }), 'codeLens'),
                withTimeout(
                    lspConnection.sendRequest(inlayHintReq, {
                        textDocument: { uri },
                        range: {
                            start: { line: 0, character: 0 },
                            end: { line: totalLines, character: 0 },
                        },
                    }),
                    'inlayHint'
                ),
                withTimeout(
                    lspConnection.sendRequest(semanticTokensReq, { textDocument: { uri } }),
                    'semanticTokens'
                ),
            ]);

            // Resolve code lenses (if we got any). Partial failure tolerated.
            let resolvedLenses: ResolvedCodeLens[] = [];
            if (lensesRes.status === 'fulfilled') {
                const rawLenses = lensesRes.value ?? [];
                const resolveResults = await Promise.allSettled(
                    rawLenses.map((lens) =>
                        withTimeout(lspConnection.sendRequest(codeLensResolveReq, lens), 'codeLensResolve')
                    )
                );
                for (let i = 0; i < resolveResults.length; i++) {
                    const r = resolveResults[i];
                    if (r.status !== 'fulfilled') continue;
                    const resolved = r.value;
                    const lensData = resolved.data as
                        | { kind?: 'references' | 'implementations' }
                        | undefined;
                    if (!lensData?.kind) continue;
                    const cmd = resolved['command'] as { title?: string } | undefined;
                    const count = extractCount(cmd?.title);
                    // Pass even zero-count lenses — the formatter uses lens
                    // positions to gate modifier-only emissions to definition
                    // sites (suppresses reference-site modifier noise).
                    resolvedLenses.push({
                        range: resolved.range,
                        count,
                        kind: lensData.kind,
                    });
                }
            }

            let typeInlays: TypeInlay[] = [];
            if (hintsRes.status === 'fulfilled') {
                const rawHints = hintsRes.value ?? [];
                for (const h of rawHints) {
                    if (h.kind !== 1) continue; // Type hints only
                    typeInlays.push({
                        position: h.position,
                        label: inlayLabelString(h.label),
                    });
                }
            }

            let decodedTokens: Array<{
                line: number;
                character: number;
                length: number;
                tokenType: string;
                tokenModifiers: string[];
            }> = [];
            if (tokensRes.status === 'fulfilled' && tokensRes.value?.data) {
                decodedTokens = decodeSemanticTokens(tokensRes.value.data, tokenLegend);
            }

            // If all three branches failed, surface an error instead of an empty block.
            if (
                lensesRes.status === 'rejected' &&
                hintsRes.status === 'rejected' &&
                tokensRes.status === 'rejected'
            ) {
                return errorResult(
                    `all LSP requests failed: codeLens=${String((lensesRes as PromiseRejectedResult).reason)}; ` +
                        `inlayHint=${String((hintsRes as PromiseRejectedResult).reason)}; ` +
                        `semanticTokens=${String((tokensRes as PromiseRejectedResult).reason)}`
                );
            }

            const block = formatFileIntelligence({
                path: filePath,
                source: sourceText,
                codeLens: resolvedLenses,
                inlays: typeInlays,
                tokens: decodedTokens,
            });

            return {
                content: [{ type: 'text' as const, text: block }],
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
