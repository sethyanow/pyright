import path from 'path';

describe('resolveLangserverPath', () => {
    const originalEnv = process.env.PYRIGHT_LANGSERVER_PATH;

    afterEach(() => {
        if (originalEnv === undefined) {
            delete process.env.PYRIGHT_LANGSERVER_PATH;
        } else {
            process.env.PYRIGHT_LANGSERVER_PATH = originalEnv;
        }
    });

    it('returns __dirname-relative path when env var is not set', () => {
        delete process.env.PYRIGHT_LANGSERVER_PATH;
        // Import must be inline so __dirname in the module is the source dir
        const { resolveLangserverPath } = require('../resolve-langserver-path');
        const result = resolveLangserverPath();
        // Should resolve relative to the module's directory, not cwd
        expect(path.isAbsolute(result)).toBe(true);
        expect(result).toBe(
            path.resolve(path.dirname(require.resolve('../resolve-langserver-path')), 'pyright-langserver.js')
        );
    });

    it('returns env var value when PYRIGHT_LANGSERVER_PATH is set', () => {
        process.env.PYRIGHT_LANGSERVER_PATH = '/custom/path/to/langserver.js';
        // Clear module cache to pick up new env var
        delete require.cache[require.resolve('../resolve-langserver-path')];
        const { resolveLangserverPath } = require('../resolve-langserver-path');
        const result = resolveLangserverPath();
        expect(result).toBe('/custom/path/to/langserver.js');
    });

    it('ignores empty string env var (falls through to default)', () => {
        process.env.PYRIGHT_LANGSERVER_PATH = '';
        delete require.cache[require.resolve('../resolve-langserver-path')];
        const { resolveLangserverPath } = require('../resolve-langserver-path');
        const result = resolveLangserverPath();
        expect(path.isAbsolute(result)).toBe(true);
        expect(result).toContain('pyright-langserver.js');
        expect(result).not.toBe('');
    });
});
