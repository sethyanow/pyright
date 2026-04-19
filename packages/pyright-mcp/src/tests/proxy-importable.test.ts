/**
 * Regression test: proxy.ts must be import-safe. The module is the CLI entry
 * point for the proxy binary (`node proxy.js --lsp|--mcp`), but other modules
 * — notably the PostToolUse enrichment hook (pyr-smw) — need to import
 * `ensurePyrightRunning` as a library.
 *
 * Without a `require.main === module` guard, importing proxy.ts would trigger
 * the top-level argv parse, call `process.exit(1)` on no mode flag, and kill
 * the jest worker. If this test file fails to load, the guard is missing.
 */
import { ensurePyrightRunning } from '../proxy';

describe('proxy.ts module safety', () => {
    it('exposes ensurePyrightRunning without running CLI dispatch', () => {
        expect(typeof ensurePyrightRunning).toBe('function');
    });
});
