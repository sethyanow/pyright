import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import {
    createMessageConnection,
    StreamMessageReader,
    StreamMessageWriter,
    MessageConnection,
} from 'vscode-jsonrpc/node';
import { createMcpServer, type TokenLegend } from '../mcp-server';

const LANGSERVER_PATH = path.resolve(
    __dirname,
    '../../../pyright/dist/pyright-langserver.js'
);

const FIXTURES_DIR = path.resolve(__dirname, 'fixtures');

/**
 * Spawn Pyright langserver, create a MessageConnection, and run LSP initialize.
 * Returns the connection and the child process (caller owns cleanup).
 */
async function spawnAndInitPyright(
    langserverPath: string,
    workspaceRoot: string
): Promise<{ connection: MessageConnection; process: ChildProcess; tokenLegend?: TokenLegend }> {
    const pyrightProcess = spawn('node', [langserverPath, '--stdio'], {
        cwd: workspaceRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
    });

    pyrightProcess.stdin!.on('error', () => {});
    pyrightProcess.stdout!.on('error', () => {});
    pyrightProcess.stderr!.on('error', () => {});
    pyrightProcess.stderr!.resume();

    const connection = createMessageConnection(
        new StreamMessageReader(pyrightProcess.stdout!),
        new StreamMessageWriter(pyrightProcess.stdin!)
    );
    connection.listen();

    const rootUri = `file://${workspaceRoot}`;
    const workspaceName = workspaceRoot.split('/').pop() || 'workspace';

    const initResult: Record<string, any> = await connection.sendRequest('initialize', {
        processId: process.pid,
        rootUri,
        rootPath: workspaceRoot,
        workspaceFolders: [{ uri: rootUri, name: workspaceName }],
        capabilities: {
            textDocument: {
                implementation: { dynamicRegistration: false },
                semanticTokens: {
                    dynamicRegistration: false,
                    requests: { full: true, range: true },
                    tokenTypes: [],
                    tokenModifiers: [],
                },
                inlayHint: { dynamicRegistration: false },
                codeLens: { dynamicRegistration: false },
            },
            workspace: {
                symbol: { dynamicRegistration: false },
                workspaceFolders: true,
            },
        },
    });
    connection.sendNotification('initialized', {});

    const legend = initResult?.capabilities?.semanticTokensProvider?.legend;
    return { connection, process: pyrightProcess, tokenLegend: legend };
}

describe('pyright MCP server', () => {
    let client: Client;
    let mcpServer: ReturnType<typeof createMcpServer>;
    let pyrightProcess: ChildProcess;

    beforeAll(async () => {
        // Spawn Pyright and get an initialized LSP connection
        const pyright = await spawnAndInitPyright(LANGSERVER_PATH, FIXTURES_DIR);
        pyrightProcess = pyright.process;

        // Create MCP server with the external connection
        const [clientTransport, serverTransport] =
            InMemoryTransport.createLinkedPair();

        mcpServer = createMcpServer(pyright.connection);
        if (pyright.tokenLegend) {
            mcpServer.setTokenLegend(pyright.tokenLegend);
        }
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
        // Kill Pyright child process (lifecycle owned by caller now)
        if (pyrightProcess) {
            pyrightProcess.kill();
            await new Promise<void>((resolve) => {
                if (pyrightProcess.exitCode !== null) {
                    resolve();
                } else {
                    pyrightProcess.on('close', () => resolve());
                    setTimeout(() => {
                        pyrightProcess.kill('SIGKILL');
                        resolve();
                    }, 2000);
                }
            });
        }
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

    it('returns inlay hints including return type on multiply def', async () => {
        const sampleUri = `file://${path.resolve(FIXTURES_DIR, 'sample.py')}`;
        const result = await client.callTool({
            name: 'lsp',
            arguments: {
                method: 'textDocument/inlayHint',
                params: {
                    textDocument: { uri: sampleUri },
                    range: {
                        start: { line: 22, character: 0 },
                        end: { line: 34, character: 0 },
                    },
                },
            },
        });
        expect(result.isError).not.toBe(true);
        const content = result.content as Array<{ type: string; text: string }>;
        const hints = JSON.parse(content[0].text);
        expect(Array.isArray(hints)).toBe(true);
        expect(hints.length).toBeGreaterThan(0);

        // Must have a return type hint (kind 1) on the multiply function def (line 27, 0-indexed)
        const multiplyReturnHint = hints.find(
            (h: { kind: number; position: { line: number } }) =>
                h.kind === 1 && h.position.line === 27
        );
        expect(multiplyReturnHint).toBeDefined();
        expect(multiplyReturnHint.label).toContain('int');

        // Should also have parameter hints (kind 2) at call sites
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
