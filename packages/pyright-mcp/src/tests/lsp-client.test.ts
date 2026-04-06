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

    it('throws on unsupported method', async () => {
        await expect(
            queryLsp(LANGSERVER_PATH, FIXTURES_DIR, 'textDocument/nonexistent', {})
        ).rejects.toThrow();
    }, 30_000);
});
