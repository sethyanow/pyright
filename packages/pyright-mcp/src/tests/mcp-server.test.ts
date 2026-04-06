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
