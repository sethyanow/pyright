import path from 'path';
import { queryLsp } from '../lsp-client';

const LANGSERVER_PATH = path.resolve(
    __dirname,
    '../../../pyright/dist/pyright-langserver.js'
);
const FIXTURES_DIR = path.resolve(__dirname, 'fixtures');

describe('queryLsp', () => {
    it('returns symbols for workspace/symbol', async () => {
        const result = await queryLsp(LANGSERVER_PATH, FIXTURES_DIR, 'workspace/symbol', {
            query: 'Greeter',
        });
        expect(Array.isArray(result)).toBe(true);
        expect((result as Array<{ name: string }>).length).toBeGreaterThan(0);
        expect((result as Array<{ name: string }>)[0]).toHaveProperty('name');
    }, 30_000);

    it('returns implementations for textDocument/implementation', async () => {
        const sampleUri = `file://${path.resolve(FIXTURES_DIR, 'sample.py')}`;
        const result = await queryLsp(LANGSERVER_PATH, FIXTURES_DIR, 'textDocument/implementation', {
            textDocument: { uri: sampleUri },
            position: { line: 3, character: 6 },
        });
        expect(Array.isArray(result)).toBe(true);
        expect((result as unknown[]).length).toBe(2);
    }, 30_000);

    it('returns null when no results', async () => {
        const sampleUri = `file://${path.resolve(FIXTURES_DIR, 'sample.py')}`;
        const result = await queryLsp(LANGSERVER_PATH, FIXTURES_DIR, 'textDocument/implementation', {
            textDocument: { uri: sampleUri },
            position: { line: 18, character: 4 },
        });
        expect(result).toBeNull();
    }, 30_000);

    it('returns decoded semantic tokens for textDocument/semanticTokens/full', async () => {
        const sampleUri = `file://${path.resolve(FIXTURES_DIR, 'sample.py')}`;
        const result = await queryLsp(LANGSERVER_PATH, FIXTURES_DIR, 'textDocument/semanticTokens/full', {
            textDocument: { uri: sampleUri },
        });
        expect(Array.isArray(result)).toBe(true);
        const tokens = result as Array<{ line: number; character: number; length: number; tokenType: string; tokenModifiers: string[] }>;
        expect(tokens.length).toBeGreaterThan(0);
        // Each token should be a decoded object
        for (const token of tokens) {
            expect(typeof token.tokenType).toBe('string');
            expect(typeof token.line).toBe('number');
            expect(Array.isArray(token.tokenModifiers)).toBe(true);
        }
        // Should find class tokens
        const classTokens = tokens.filter(t => t.tokenType === 'class');
        expect(classTokens.length).toBeGreaterThanOrEqual(3);
    }, 30_000);

    it('returns inlay hints including return type on multiply def', async () => {
        const sampleUri = `file://${path.resolve(FIXTURES_DIR, 'sample.py')}`;
        const result = await queryLsp(LANGSERVER_PATH, FIXTURES_DIR, 'textDocument/inlayHint', {
            textDocument: { uri: sampleUri },
            range: {
                start: { line: 22, character: 0 },
                end: { line: 34, character: 0 },
            },
        });
        expect(Array.isArray(result)).toBe(true);
        const hints = result as Array<{
            position: { line: number; character: number };
            label: string;
            kind: number;
        }>;
        expect(hints.length).toBeGreaterThan(0);

        // Must have a return type hint (kind 1) on the multiply function def (line 27, 0-indexed)
        const multiplyReturnHint = hints.find(
            (h) => h.kind === 1 && h.position.line === 27
        );
        expect(multiplyReturnHint).toBeDefined();
        expect(multiplyReturnHint!.label).toContain('int');

        // Should also have parameter hints (kind 2) at call sites
        const paramHints = hints.filter((h) => h.kind === 2);
        expect(paramHints.length).toBeGreaterThanOrEqual(1);
    }, 30_000);

    it('throws on unsupported method', async () => {
        await expect(
            queryLsp(LANGSERVER_PATH, FIXTURES_DIR, 'textDocument/nonexistent', {})
        ).rejects.toThrow();
    }, 30_000);
});
