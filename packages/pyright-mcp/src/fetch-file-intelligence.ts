/**
 * Shared helper used by the MCP file_intelligence tool and the PostToolUse
 * enrichment hook. Given a validated .py path and an initialized LSP
 * connection, fetches codeLens + inlayHint + semanticTokens from Pyright,
 * resolves and decodes the responses, and returns a formatted
 * <file-intelligence> block.
 *
 * The caller is responsible for:
 *   - Path validation (absolute, .py suffix, existence) — helper assumes valid input.
 *   - LSP handshake (initialize + initialized notification) — helper assumes a ready connection.
 *   - Providing the tokenLegend captured from the initialize response.
 *   - Tracking openedUris across calls to avoid redundant didOpen notifications.
 *
 * On all-three-branch failure, returns { error } so the caller can decide
 * whether to surface or swallow. Partial failures return { block } with the
 * successful subset — matches existing handler behavior.
 */
import { readFileSync } from 'fs';
import { MessageConnection, RequestType } from 'vscode-jsonrpc/node';
import { decodeSemanticTokens, type TokenLegend } from './decode-semantic-tokens';
import {
    formatFileIntelligence,
    type ResolvedCodeLens,
    type TypeInlay,
} from './format-file-intelligence';

export type { TokenLegend } from './decode-semantic-tokens';

type LspRange = {
    start: { line: number; character: number };
    end: { line: number; character: number };
};
type LspPosition = { line: number; character: number };
type LspCodeLens = {
    range: LspRange;
    [key: string]: unknown;
};
type LspInlayHint = {
    position: LspPosition;
    label: string | Array<{ value: string }>;
    kind?: number;
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

export async function fetchFileIntelligence(
    lspConnection: MessageConnection,
    filePath: string,
    tokenLegend: TokenLegend,
    openedUris: Set<string>
): Promise<{ block: string } | { error: string }> {
    let sourceText: string;
    try {
        sourceText = readFileSync(filePath, 'utf-8');
    } catch (err) {
        return { error: `failed to read file: ${(err as Error).message}` };
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
                setTimeout(
                    () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
                    timeoutMs
                )
            ),
        ]);

    const codeLensReq = new RequestType<
        { textDocument: { uri: string } },
        LspCodeLens[] | null,
        void
    >('textDocument/codeLens');
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
    const codeLensResolveReq = new RequestType<LspCodeLens, LspCodeLens, void>(
        'codeLens/resolve'
    );

    const [lensesRes, hintsRes, tokensRes] = await Promise.allSettled([
        withTimeout(
            lspConnection.sendRequest(codeLensReq, { textDocument: { uri } }),
            'codeLens'
        ),
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

    const resolvedLenses: ResolvedCodeLens[] = [];
    if (lensesRes.status === 'fulfilled') {
        const rawLenses = lensesRes.value ?? [];
        const resolveResults = await Promise.allSettled(
            rawLenses.map((lens) =>
                withTimeout(
                    lspConnection.sendRequest(codeLensResolveReq, lens),
                    'codeLensResolve'
                )
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
            resolvedLenses.push({
                range: resolved.range,
                count,
                kind: lensData.kind,
            });
        }
    }

    const typeInlays: TypeInlay[] = [];
    if (hintsRes.status === 'fulfilled') {
        const rawHints = hintsRes.value ?? [];
        for (const h of rawHints) {
            if (h.kind !== 1) continue;
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

    if (
        lensesRes.status === 'rejected' &&
        hintsRes.status === 'rejected' &&
        tokensRes.status === 'rejected'
    ) {
        return {
            error:
                `all LSP requests failed: codeLens=${String((lensesRes as PromiseRejectedResult).reason)}; ` +
                `inlayHint=${String((hintsRes as PromiseRejectedResult).reason)}; ` +
                `semanticTokens=${String((tokensRes as PromiseRejectedResult).reason)}`,
        };
    }

    const block = formatFileIntelligence({
        path: filePath,
        source: sourceText,
        codeLens: resolvedLenses,
        inlays: typeInlays,
        tokens: decodedTokens,
    });

    return { block };
}
