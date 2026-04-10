import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import path from 'path';
import { createMcpServer } from '../mcp-server';

const LANGSERVER_PATH = path.resolve(
    __dirname,
    '../../../pyright/dist/pyright-langserver.js'
);

const FIXTURES_DIR = path.resolve(__dirname, 'fixtures');

describe('pyright MCP server', () => {
    let client: Client;
    let mcpServer: Awaited<ReturnType<typeof createMcpServer>>;

    beforeAll(async () => {
        const [clientTransport, serverTransport] =
            InMemoryTransport.createLinkedPair();

        mcpServer = await createMcpServer(LANGSERVER_PATH, FIXTURES_DIR);
        await mcpServer.server.connect(serverTransport);

        client = new Client({ name: 'test-client', version: '1.0.0' });
        await client.connect(clientTransport);

        // Wait for Pyright to finish analyzing the fixtures
        // Poll workspace/symbol until results appear (Pyright needs time for background analysis)
        for (let i = 0; i < 50; i++) {
            const probe = await client.callTool({
                name: 'lsp',
                arguments: {
                    method: 'workspace/symbol',
                    params: { query: 'Greeter' },
                },
            });
            const content = probe.content as Array<{
                type: string;
                text: string;
            }>;
            if (
                !probe.isError &&
                content.length > 0 &&
                JSON.parse(content[0].text).length > 0
            ) {
                break;
            }
            await new Promise((r) => setTimeout(r, 500));
        }
    }, 30_000);

    afterAll(async () => {
        await client.close();
        await mcpServer.shutdown();
    });

    it('lists the lsp tool', async () => {
        const result = await client.listTools();
        const toolNames = result.tools.map((t) => t.name);
        expect(toolNames).toContain('lsp');
    });

    it('returns symbols via workspace/symbol with empty query', async () => {
        const result = await client.callTool({
            name: 'lsp',
            arguments: {
                method: 'workspace/symbol',
                params: { query: '' },
            },
        });
        expect(result.isError).not.toBe(true);
        const content = result.content as Array<{ type: string; text: string }>;
        expect(content.length).toBeGreaterThan(0);
        const symbols = JSON.parse(content[0].text);
        expect(Array.isArray(symbols)).toBe(true);
        expect(symbols.length).toBeGreaterThan(0);
        // Each symbol should have name and kind
        expect(symbols[0]).toHaveProperty('name');
        expect(symbols[0]).toHaveProperty('kind');
    }, 30_000);

    it('filters symbols via workspace/symbol with query', async () => {
        const result = await client.callTool({
            name: 'lsp',
            arguments: {
                method: 'workspace/symbol',
                params: { query: 'Greeter' },
            },
        });
        expect(result.isError).not.toBe(true);
        const content = result.content as Array<{ type: string; text: string }>;
        const symbols = JSON.parse(content[0].text);
        expect(symbols.length).toBeGreaterThan(0);
        // All returned symbols should match the query
        for (const sym of symbols) {
            expect(sym.name.toLowerCase()).toContain('greeter');
        }
    }, 30_000);

    it('returns implementations for an ABC via textDocument/implementation', async () => {
        const sampleUri = `file://${path.resolve(FIXTURES_DIR, 'sample.py')}`;
        // Greeter ABC is at line 3 (0-based), character 6
        const result = await client.callTool({
            name: 'lsp',
            arguments: {
                method: 'textDocument/implementation',
                params: {
                    textDocument: { uri: sampleUri },
                    position: { line: 3, character: 6 },
                },
            },
        });
        expect(result.isError).not.toBe(true);
        const content = result.content as Array<{ type: string; text: string }>;
        const locations = JSON.parse(content[0].text);
        expect(Array.isArray(locations)).toBe(true);
        // Should find EnglishGreeter and SpanishGreeter
        expect(locations.length).toBe(2);
        const lines = locations
            .map(
                (loc: { range: { start: { line: number } } }) =>
                    loc.range.start.line
            )
            .sort((a: number, b: number) => a - b);
        // EnglishGreeter at line 8 (0-based), SpanishGreeter at line 13 (0-based)
        expect(lines).toEqual([8, 13]);
    }, 30_000);

    it('returns decoded semantic tokens for textDocument/semanticTokens/full', async () => {
        const sampleUri = `file://${path.resolve(FIXTURES_DIR, 'sample.py')}`;
        const result = await client.callTool({
            name: 'lsp',
            arguments: {
                method: 'textDocument/semanticTokens/full',
                params: {
                    textDocument: { uri: sampleUri },
                },
            },
        });
        expect(result.isError).not.toBe(true);
        const content = result.content as Array<{ type: string; text: string }>;
        const tokens = JSON.parse(content[0].text);
        expect(Array.isArray(tokens)).toBe(true);
        expect(tokens.length).toBeGreaterThan(0);
        // Each token should be a decoded object with human-readable type names
        for (const token of tokens) {
            expect(token).toHaveProperty('line');
            expect(token).toHaveProperty('character');
            expect(token).toHaveProperty('length');
            expect(token).toHaveProperty('tokenType');
            expect(token).toHaveProperty('tokenModifiers');
            expect(typeof token.line).toBe('number');
            expect(typeof token.character).toBe('number');
            expect(typeof token.length).toBe('number');
            // tokenType should be a string name, not a number
            expect(typeof token.tokenType).toBe('string');
            expect(Array.isArray(token.tokenModifiers)).toBe(true);
        }
        // Should find class tokens (Greeter, EnglishGreeter, SpanishGreeter)
        const classTokens = tokens.filter((t: { tokenType: string }) => t.tokenType === 'class');
        expect(classTokens.length).toBeGreaterThanOrEqual(3);
        // Should find function/method tokens
        const funcTokens = tokens.filter(
            (t: { tokenType: string }) => t.tokenType === 'function' || t.tokenType === 'method'
        );
        expect(funcTokens.length).toBeGreaterThanOrEqual(1);
    }, 30_000);

    it('returns decoded semantic tokens for textDocument/semanticTokens/range', async () => {
        const sampleUri = `file://${path.resolve(FIXTURES_DIR, 'sample.py')}`;
        // Request tokens only for the first class (lines 0-6, covering Greeter ABC)
        const result = await client.callTool({
            name: 'lsp',
            arguments: {
                method: 'textDocument/semanticTokens/range',
                params: {
                    textDocument: { uri: sampleUri },
                    range: {
                        start: { line: 0, character: 0 },
                        end: { line: 6, character: 0 },
                    },
                },
            },
        });
        expect(result.isError).not.toBe(true);
        const content = result.content as Array<{ type: string; text: string }>;
        const tokens = JSON.parse(content[0].text);
        expect(Array.isArray(tokens)).toBe(true);
        // Should have tokens but fewer than full file
        expect(tokens.length).toBeGreaterThan(0);
        // All tokens should be decoded objects
        for (const token of tokens) {
            expect(typeof token.tokenType).toBe('string');
        }
    }, 30_000);

    it('returns inlay hints for unannotated code via textDocument/inlayHint', async () => {
        const sampleUri = `file://${path.resolve(FIXTURES_DIR, 'sample.py')}`;
        // Request hints for the unannotated section (lines 22-26: add function + result variable)
        const result = await client.callTool({
            name: 'lsp',
            arguments: {
                method: 'textDocument/inlayHint',
                params: {
                    textDocument: { uri: sampleUri },
                    range: {
                        start: { line: 22, character: 0 },
                        end: { line: 27, character: 0 },
                    },
                },
            },
        });
        expect(result.isError).not.toBe(true);
        const content = result.content as Array<{ type: string; text: string }>;
        const hints = JSON.parse(content[0].text);
        expect(Array.isArray(hints)).toBe(true);
        expect(hints.length).toBeGreaterThan(0);
        // Each hint should have position, label, and kind
        for (const hint of hints) {
            expect(hint).toHaveProperty('position');
            expect(hint.position).toHaveProperty('line');
            expect(hint.position).toHaveProperty('character');
            expect(hint).toHaveProperty('label');
            expect(hint).toHaveProperty('kind');
        }
        // Should have Type hints (kind 1) for return type or variable type
        const typeHints = hints.filter((h: { kind: number }) => h.kind === 1);
        expect(typeHints.length).toBeGreaterThanOrEqual(1);
        // Should have Parameter hints (kind 2) for call site parameter names
        const paramHints = hints.filter((h: { kind: number }) => h.kind === 2);
        expect(paramHints.length).toBeGreaterThanOrEqual(1);
    }, 30_000);

    it('returns error for unsupported method', async () => {
        const result = await client.callTool({
            name: 'lsp',
            arguments: {
                method: 'textDocument/nonexistentMethod',
                params: {},
            },
        });
        expect(result.isError).toBe(true);
    }, 10_000);
});
