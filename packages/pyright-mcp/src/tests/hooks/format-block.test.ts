import { formatFileIntelligence, ResolvedLens } from '../../hooks/format-block';

function bodyLines(out: string): string[] {
    return out
        .split('\n')
        .filter((l: string) => !l.startsWith('<file-intelligence') && !l.startsWith('</file-intelligence'))
        .filter((l: string) => l.length > 0);
}

describe('formatFileIntelligence', () => {
    it('wraps output in <file-intelligence path="..."> tags', () => {
        const out = formatFileIntelligence('/a/b/c.py', []);
        expect(out.startsWith('<file-intelligence path="/a/b/c.py">')).toBe(true);
        expect(out.trimEnd().endsWith('</file-intelligence>')).toBe(true);
    });

    it('emits one line per lens with line, symbol, refs and impls', () => {
        const lenses: ResolvedLens[] = [
            { line: 23, symbol: 'Foo', references: 12, implementations: 3 },
        ];
        const out = formatFileIntelligence('/x.py', lenses);
        const body = bodyLines(out);
        expect(body).toHaveLength(1);
        expect(body[0]).toMatch(/L23\b/);
        expect(body[0]).toMatch(/\bFoo\b/);
        expect(body[0]).toMatch(/refs=12/);
        expect(body[0]).toMatch(/impls=3/);
    });

    it('omits impls= when implementations count is undefined', () => {
        const lenses: ResolvedLens[] = [{ line: 5, symbol: 'helper', references: 7 }];
        const out = formatFileIntelligence('/x.py', lenses);
        expect(out).toMatch(/refs=7/);
        expect(out).not.toMatch(/impls=/);
    });

    it('omits refs= when references count is undefined', () => {
        const lenses: ResolvedLens[] = [{ line: 5, symbol: 'Bar', implementations: 2 }];
        const out = formatFileIntelligence('/x.py', lenses);
        expect(out).toMatch(/impls=2/);
        expect(out).not.toMatch(/refs=/);
    });

    it('produces empty body when lens list is empty', () => {
        const out = formatFileIntelligence('/x.py', []);
        expect(bodyLines(out)).toHaveLength(0);
    });

    it('escapes double-quote and less-than in path attribute', () => {
        const out = formatFileIntelligence('/weird"<path.py', []);
        expect(out).toContain('/weird&quot;&lt;path.py');
        expect(out).not.toMatch(/path="[^"]*"[^<]*<path/); // no raw quote in attribute
    });

    it('escapes double-quote and less-than in symbol names', () => {
        const lenses: ResolvedLens[] = [{ line: 1, symbol: 'weird"<name', references: 1 }];
        const out = formatFileIntelligence('/x.py', lenses);
        expect(out).toContain('weird&quot;&lt;name');
        expect(out).not.toMatch(/weird"</);
    });

    it('caps output at 100 lines and appends truncation note', () => {
        const lenses: ResolvedLens[] = Array.from({ length: 250 }, (_, i) => ({
            line: i + 1,
            symbol: `Sym${i}`,
            references: i,
        }));
        const out = formatFileIntelligence('/x.py', lenses);
        const body = bodyLines(out);
        // 100 symbol lines + 1 truncation line
        expect(body.length).toBeLessThanOrEqual(101);
        expect(body.length).toBeGreaterThan(100);
        expect(body[body.length - 1]).toMatch(/150 more/);
    });

    it('sorts lenses by refs+impls descending when truncating', () => {
        const lenses: ResolvedLens[] = Array.from({ length: 150 }, (_, i) => ({
            line: i + 1,
            symbol: `Sym${i}`,
            references: i,
        }));
        const out = formatFileIntelligence('/x.py', lenses);
        // Highest-count symbol (Sym149) must survive truncation
        expect(out).toContain('Sym149');
        // Lowest-count symbol (Sym0) must be truncated away
        expect(out).not.toMatch(/\bSym0\b/);
    });

    // Adversarial: empty symbol name — an edge case the LSP layer theoretically
    // filters out (enrich-file's socket-lsp-client skips lenses with no symbol),
    // but the formatter must stay well-formed regardless of input.
    it('emits a well-formed line for an empty symbol string', () => {
        const out = formatFileIntelligence('/x.py', [{ line: 7, symbol: '', references: 1 }]);
        expect(bodyLines(out)).toHaveLength(1);
        expect(out).toContain('L7');
        expect(out).toContain('refs=1');
    });

    // Adversarial: Unicode identifiers. Python permits non-ASCII identifiers.
    it('preserves multi-byte Unicode symbol names without corruption', () => {
        const out = formatFileIntelligence('/x.py', [
            { line: 1, symbol: 'Überklass', references: 2 },
            { line: 2, symbol: '변수', references: 1 },
        ]);
        expect(out).toContain('Überklass');
        expect(out).toContain('변수');
    });

    // Adversarial: negative / zero line numbers (unexpected LSP input).
    it('does not crash on negative or zero line numbers', () => {
        const out = formatFileIntelligence('/x.py', [
            { line: 0, symbol: 'at_zero', references: 1 },
            { line: -1, symbol: 'negative', references: 1 },
        ]);
        // We don't guarantee how they render — just that the formatter returns a string
        expect(typeof out).toBe('string');
        expect(out).toContain('<file-intelligence');
        expect(out).toContain('</file-intelligence>');
    });
});
