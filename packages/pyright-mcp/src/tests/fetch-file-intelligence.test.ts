/**
 * Direct unit tests for fetchFileIntelligence — the shared helper used by both
 * the MCP handler (`file_intelligence` tool) and the PostToolUse enrichment
 * hook (pyr-smw). The existing file-intelligence-partial-failure.test.ts
 * exercises the same logic through the MCP client; this file exercises the
 * function directly for a tighter feedback loop.
 */
import {
    fetchFileIntelligence,
    type TokenLegend,
} from '../fetch-file-intelligence';

type Responder = (params: unknown) => unknown | Promise<unknown>;

function buildFakeConnection(responders: Record<string, Responder>) {
    return {
        sendRequest: (requestType: { method: string } | string, params: unknown) => {
            const method = typeof requestType === 'string' ? requestType : requestType.method;
            const responder = responders[method];
            if (!responder) {
                return Promise.reject(new Error(`unmocked method: ${method}`));
            }
            return Promise.resolve(responder(params));
        },
        sendNotification: () => undefined,
    };
}

const FAKE_LEGEND: TokenLegend = {
    tokenTypes: ['class', 'function'],
    tokenModifiers: ['abstract'],
};

describe('fetchFileIntelligence', () => {
    it('returns {block} when all three LSP branches succeed with empty results', async () => {
        const responders: Record<string, Responder> = {
            'textDocument/codeLens': () => [],
            'textDocument/inlayHint': () => [],
            'textDocument/semanticTokens/full': () => ({ data: [] }),
        };
        const fakeConn = buildFakeConnection(responders);
        const filePath = require('path').resolve(
            __dirname,
            'fixtures/sample.py'
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await fetchFileIntelligence(
            fakeConn as any,
            filePath,
            FAKE_LEGEND,
            new Set<string>()
        );
        expect('block' in result).toBe(true);
        if ('block' in result) {
            expect(result.block).toContain('<file-intelligence');
        }
    });

    it('returns {error} when all three LSP branches fail', async () => {
        const responders: Record<string, Responder> = {
            'textDocument/codeLens': () => Promise.reject(new Error('lens-fail')),
            'textDocument/inlayHint': () => Promise.reject(new Error('hint-fail')),
            'textDocument/semanticTokens/full': () =>
                Promise.reject(new Error('token-fail')),
        };
        const fakeConn = buildFakeConnection(responders);
        const filePath = require('path').resolve(
            __dirname,
            'fixtures/sample.py'
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await fetchFileIntelligence(
            fakeConn as any,
            filePath,
            FAKE_LEGEND,
            new Set<string>()
        );
        expect('error' in result).toBe(true);
    });
});
