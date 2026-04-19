import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createMcpServer, type TokenLegend } from '../mcp-server';

/**
 * Minimal MessageConnection-shaped stub. Routes sendRequest by method name so
 * individual LSP branches can be forced to succeed or reject independently.
 *
 * We use `as any` casts rather than importing the full MessageConnection type
 * because we only implement the two methods the file_intelligence handler uses
 * (sendRequest, sendNotification), and Bob-the-builder-ing the whole interface
 * would bury the test intent in unused scaffolding.
 */
type RequestType = { method: string } | string;
type Responder = (params: unknown) => unknown | Promise<unknown>;

function buildFakeConnection(responders: Record<string, Responder>) {
    return {
        sendRequest: (requestType: RequestType, params: unknown) => {
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

async function connectClient(responders: Record<string, Responder>) {
    const fakeConn = buildFakeConnection(responders);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mcp = createMcpServer(fakeConn as any);
    mcp.setTokenLegend(FAKE_LEGEND);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await mcp.server.connect(serverT);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientT);
    return { client, mcp };
}

describe('file_intelligence partial-failure resilience', () => {
    let tmpFile: string;

    beforeAll(() => {
        tmpFile = join(tmpdir(), `pyright-mcp-fi-${process.pid}.py`);
        writeFileSync(tmpFile, 'class Foo:\n    pass\n', 'utf-8');
    });

    afterAll(() => {
        try {
            unlinkSync(tmpFile);
        } catch {
            /* best-effort */
        }
    });

    it('returns a valid block when semanticTokens fails but codeLens + inlayHint succeed', async () => {
        const { client } = await connectClient({
            'textDocument/codeLens': () => [
                {
                    range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } },
                    data: { kind: 'references' },
                },
            ],
            'codeLens/resolve': (params) => ({
                ...(params as Record<string, unknown>),
                command: { title: '2 references', command: '' },
            }),
            'textDocument/inlayHint': () => [],
            'textDocument/semanticTokens/full': () => Promise.reject(new Error('boom')),
        });

        const result = await client.callTool({
            name: 'file_intelligence',
            arguments: { path: tmpFile },
        });
        expect(result.isError).not.toBe(true);
        const content = result.content as Array<{ type: string; text: string }>;
        const block = content[0].text;
        expect(block).toContain('<file-intelligence');
        expect(block).toContain('</file-intelligence>');
        // semanticTokens failed → no class token seeded → no symbol lines.
        // That's the expected partial-success outcome: block is well-formed, just
        // without semantic-token-derived entries.
        expect(block).toContain(tmpFile);
    });

    it('returns a valid block when codeLens fails but inlayHint + semanticTokens succeed', async () => {
        const { client } = await connectClient({
            'textDocument/codeLens': () => Promise.reject(new Error('codeLens boom')),
            'textDocument/inlayHint': () => [],
            // Encode a single class token at line 0, char 6, length 3, type index 0 (class), no modifiers
            'textDocument/semanticTokens/full': () => ({ data: [0, 6, 3, 0, 0] }),
        });

        const result = await client.callTool({
            name: 'file_intelligence',
            arguments: { path: tmpFile },
        });
        expect(result.isError).not.toBe(true);
        const content = result.content as Array<{ type: string; text: string }>;
        const block = content[0].text;
        expect(block).toContain('<file-intelligence');
        // Without codeLens, there are no definition positions → no modifier-only
        // emissions. The class token has no modifiers, no lens, no inlay → skipped.
        // The point is the block is valid, not erroring.
        expect(block.trimEnd().endsWith('</file-intelligence>')).toBe(true);
    });

    it('returns isError when all three LSP branches fail', async () => {
        const { client } = await connectClient({
            'textDocument/codeLens': () => Promise.reject(new Error('a')),
            'textDocument/inlayHint': () => Promise.reject(new Error('b')),
            'textDocument/semanticTokens/full': () => Promise.reject(new Error('c')),
        });

        const result = await client.callTool({
            name: 'file_intelligence',
            arguments: { path: tmpFile },
        });
        expect(result.isError).toBe(true);
        const content = result.content as Array<{ type: string; text: string }>;
        expect(content[0].text).toContain('all LSP requests failed');
    });

    it('adversarial empty — handles a zero-byte .py file (no symbols) without error', async () => {
        const emptyPath = join(tmpdir(), `pyright-mcp-empty-${process.pid}.py`);
        writeFileSync(emptyPath, '', 'utf-8');
        const { client } = await connectClient({
            'textDocument/codeLens': () => [],
            'textDocument/inlayHint': () => [],
            'textDocument/semanticTokens/full': () => ({ data: [] }),
        });
        try {
            const result = await client.callTool({
                name: 'file_intelligence',
                arguments: { path: emptyPath },
            });
            expect(result.isError).not.toBe(true);
            const content = result.content as Array<{ type: string; text: string }>;
            const block = content[0].text;
            expect(block).toContain('<file-intelligence');
            expect(block.trimEnd().endsWith('</file-intelligence>')).toBe(true);
            // Body should be empty — no L<n>:<c> lines
            expect(block.split('\n').filter((l) => l.startsWith('L'))).toHaveLength(0);
        } finally {
            try {
                unlinkSync(emptyPath);
            } catch {
                /* best-effort */
            }
        }
    });

    it('adversarial second-run — calling twice returns the same block (openedUris reuse)', async () => {
        let didOpenCalls = 0;
        const fakeConn = {
            sendRequest: (req: RequestType, _params: unknown) => {
                const method = typeof req === 'string' ? req : req.method;
                if (method === 'textDocument/codeLens') return Promise.resolve([]);
                if (method === 'textDocument/inlayHint') return Promise.resolve([]);
                if (method === 'textDocument/semanticTokens/full')
                    return Promise.resolve({ data: [0, 0, 3, 0, 0] });
                return Promise.reject(new Error(`unmocked: ${method}`));
            },
            sendNotification: (method: string) => {
                if (method === 'textDocument/didOpen') didOpenCalls++;
            },
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mcp = createMcpServer(fakeConn as any);
        mcp.setTokenLegend(FAKE_LEGEND);
        const [ct, st] = InMemoryTransport.createLinkedPair();
        await mcp.server.connect(st);
        const client = new Client({ name: 't', version: '1' });
        await client.connect(ct);

        const r1 = await client.callTool({
            name: 'file_intelligence',
            arguments: { path: tmpFile },
        });
        const r2 = await client.callTool({
            name: 'file_intelligence',
            arguments: { path: tmpFile },
        });
        expect(r1.isError).not.toBe(true);
        expect(r2.isError).not.toBe(true);
        const text1 = (r1.content as Array<{ text: string }>)[0].text;
        const text2 = (r2.content as Array<{ text: string }>)[0].text;
        expect(text1).toBe(text2);
        // didOpen should fire exactly once across the two calls (openedUris dedupe)
        expect(didOpenCalls).toBe(1);
    });

    it('adversarial encoding — tolerates a file path containing & and spaces', async () => {
        const weirdPath = join(tmpdir(), `pyright mcp & weird-${process.pid}.py`);
        writeFileSync(weirdPath, 'x = 1\n', 'utf-8');
        const { client } = await connectClient({
            'textDocument/codeLens': () => [],
            'textDocument/inlayHint': () => [],
            'textDocument/semanticTokens/full': () => ({ data: [] }),
        });
        try {
            const result = await client.callTool({
                name: 'file_intelligence',
                arguments: { path: weirdPath },
            });
            expect(result.isError).not.toBe(true);
            const block = (result.content as Array<{ text: string }>)[0].text;
            // `&` must be XML-escaped in the attribute
            expect(block).toContain('&amp;');
            // Raw `&` with a space after must not leak through
            expect(block).not.toMatch(/path="[^"]*& weird/);
        } finally {
            try {
                unlinkSync(weirdPath);
            } catch {
                /* best-effort */
            }
        }
    });

    it('skips individual codeLens resolves that fail (allSettled)', async () => {
        let resolveCalls = 0;
        const { client } = await connectClient({
            'textDocument/codeLens': () => [
                {
                    range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } },
                    data: { kind: 'references' },
                },
                {
                    range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } },
                    data: { kind: 'implementations' },
                },
            ],
            'codeLens/resolve': (params) => {
                resolveCalls++;
                // Reject the second resolve attempt; the first one succeeds.
                if (resolveCalls === 2) {
                    return Promise.reject(new Error('resolve boom'));
                }
                return {
                    ...(params as Record<string, unknown>),
                    command: { title: '5 references', command: '' },
                };
            },
            'textDocument/inlayHint': () => [],
            'textDocument/semanticTokens/full': () => ({ data: [0, 6, 3, 0, 0] }), // class Foo
        });

        const result = await client.callTool({
            name: 'file_intelligence',
            arguments: { path: tmpFile },
        });
        expect(result.isError).not.toBe(true);
        const content = result.content as Array<{ type: string; text: string }>;
        const block = content[0].text;
        // First resolve succeeded → refs=5 attached. Second resolve failed → no impls.
        expect(block).toContain('refs=5');
        expect(block).not.toContain('impls=');
    });
});
