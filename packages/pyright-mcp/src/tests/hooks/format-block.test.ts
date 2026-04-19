import {
    formatFileIntelligence,
    formatFileIntelligenceBlock,
    FileIntelligence,
    InlayTypeHint,
    ResolvedLens,
} from '../../hooks/format-block';

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

describe('formatFileIntelligenceBlock', () => {
    const sampleIntel = (over: Partial<FileIntelligence> = {}): FileIntelligence => ({
        codeLenses: [],
        inlayHints: [],
        ...over,
    });

    it('emits codeLens and inlay lines sorted by line number', () => {
        const intel = sampleIntel({
            codeLenses: [
                { line: 4, symbol: 'Greeter', references: 3, implementations: 2 },
                { line: 24, symbol: 'add', references: 1 },
            ],
            inlayHints: [
                { line: 28, label: '-> int' },
                { line: 32, label: ': int' },
            ],
        });
        const out = formatFileIntelligenceBlock('/x.py', intel);
        const body = bodyLines(out);
        expect(body).toHaveLength(4);
        // All lines in ascending line order
        const linePrefixes = body.map((l) => l.match(/^L(-?\d+)/)?.[1]).map((s) => Number(s));
        const sortedCopy = [...linePrefixes].sort((a, b) => a - b);
        expect(linePrefixes).toEqual(sortedCopy);
    });

    it('renders inlay lines as L{line}  {label} with no symbol column', () => {
        const intel = sampleIntel({
            inlayHints: [{ line: 32, label: ': int' }],
        });
        const out = formatFileIntelligenceBlock('/x.py', intel);
        expect(out).toMatch(/L32\s{2,}: int/);
        // No refs=/impls= on an inlay-only line
        expect(out).not.toMatch(/L32[^\n]*refs=/);
        expect(out).not.toMatch(/L32[^\n]*impls=/);
    });

    it('keeps inlay label verbatim including arrow and colon', () => {
        const intel = sampleIntel({
            inlayHints: [
                { line: 24, label: '-> int' },
                { line: 32, label: ': list[str]' },
            ],
        });
        const out = formatFileIntelligenceBlock('/x.py', intel);
        expect(out).toContain('-> int');
        expect(out).toContain(': list[str]');
    });

    it('behaves identically to formatFileIntelligence when inlayHints is empty', () => {
        const codeLenses: ResolvedLens[] = [
            { line: 4, symbol: 'Greeter', references: 3, implementations: 2 },
            { line: 24, symbol: 'add', references: 1 },
        ];
        const blockOut = formatFileIntelligenceBlock('/x.py', sampleIntel({ codeLenses }));
        const lensOnlyOut = formatFileIntelligence('/x.py', codeLenses);
        expect(blockOut).toEqual(lensOnlyOut);
    });

    it('places codeLens before inlay when lines tie', () => {
        const intel = sampleIntel({
            codeLenses: [{ line: 24, symbol: 'add', references: 1 }],
            inlayHints: [{ line: 24, label: '-> int' }],
        });
        const out = formatFileIntelligenceBlock('/x.py', intel);
        const body = bodyLines(out);
        expect(body[0]).toContain('add');
        expect(body[1]).toContain('-> int');
    });

    it('escapes the tag-opening `<` in inlay labels so the container stays well-formed', () => {
        // `<` is the only hard escape requirement (it would start a new tag).
        // `>` stays verbatim so labels like "-> int" survive — see the next test.
        const intel = sampleIntel({
            inlayHints: [{ line: 10, label: ': <weird>' }],
        });
        const out = formatFileIntelligenceBlock('/x.py', intel);
        expect(out).toContain('&lt;weird>');
        expect(out).not.toMatch(/:\s+<weird>/);
    });

    it('applies codeLens score-sort and cap BEFORE merging inlay so inlay cannot evict high-score codeLens', () => {
        // 150 codeLens entries: Sym0..Sym149 with references 0..149
        const codeLenses: ResolvedLens[] = Array.from({ length: 150 }, (_, i) => ({
            line: i + 1,
            symbol: `Sym${i}`,
            references: i,
        }));
        // 200 inlay entries on lines 1..200 — a flood that would otherwise push high-score lenses out
        const inlayHints: InlayTypeHint[] = Array.from({ length: 200 }, (_, i) => ({
            line: i + 1,
            label: `: T${i}`,
        }));
        const out = formatFileIntelligenceBlock('/x.py', sampleIntel({ codeLenses, inlayHints }));
        // Highest-score codeLens (Sym149) must survive — inlay flood does NOT evict it
        expect(out).toContain('Sym149');
        // Lowest-score codeLens (Sym0) should have been truncated (score-based)
        expect(out).not.toMatch(/\bSym0\b/);
    });

    it('dedupes identical (line, label) inlay entries', () => {
        const intel = sampleIntel({
            inlayHints: [
                { line: 32, label: ': int' },
                { line: 32, label: ': int' },
                { line: 32, label: ': int' },
            ],
        });
        const out = formatFileIntelligenceBlock('/x.py', intel);
        const matches = out.match(/L32\s+: int/g) ?? [];
        expect(matches).toHaveLength(1);
    });

    it('suppresses body when both codeLenses and inlayHints are empty', () => {
        const out = formatFileIntelligenceBlock('/x.py', sampleIntel());
        expect(bodyLines(out)).toHaveLength(0);
    });

    // Adversarial battery — each test is its own cycle.

    it('ADV: preserves multi-byte Unicode in inlay labels', () => {
        const intel = sampleIntel({
            inlayHints: [
                { line: 10, label: ': Überklass' },
                { line: 11, label: ': 변수' },
            ],
        });
        const out = formatFileIntelligenceBlock('/x.py', intel);
        expect(out).toContain('Überklass');
        expect(out).toContain('변수');
    });

    it('ADV: renders a well-formed line for an empty inlay label', () => {
        // The upstream fetch drops empty labels, but the formatter must not crash if one sneaks in.
        const intel = sampleIntel({
            inlayHints: [{ line: 5, label: '' }],
        });
        const out = formatFileIntelligenceBlock('/x.py', intel);
        expect(out).toContain('<file-intelligence');
        expect(out).toContain('</file-intelligence>');
        // Output is a string; we don't commit to specific empty-label rendering.
        expect(typeof out).toBe('string');
    });

    it('ADV: tolerates extremely large line numbers', () => {
        const intel = sampleIntel({
            codeLenses: [{ line: 9_999_999, symbol: 'WayDown', references: 1 }],
            inlayHints: [{ line: 10_000_000, label: ': int' }],
        });
        const out = formatFileIntelligenceBlock('/x.py', intel);
        expect(out).toContain('L9999999');
        expect(out).toContain('L10000000');
    });

    it('ADV: second run on the same input produces identical output (idempotency)', () => {
        const intel = sampleIntel({
            codeLenses: [{ line: 4, symbol: 'Greeter', references: 3, implementations: 2 }],
            inlayHints: [{ line: 24, label: '-> int' }],
        });
        const first = formatFileIntelligenceBlock('/x.py', intel);
        const second = formatFileIntelligenceBlock('/x.py', intel);
        expect(first).toEqual(second);
    });

    it('ADV: mutating input after render does not mutate prior output (no shared references)', () => {
        const codeLenses: ResolvedLens[] = [
            { line: 4, symbol: 'Greeter', references: 3, implementations: 2 },
        ];
        const inlayHints: InlayTypeHint[] = [{ line: 24, label: '-> int' }];
        const first = formatFileIntelligenceBlock('/x.py', { codeLenses, inlayHints });
        codeLenses.push({ line: 99, symbol: 'Sneak', references: 10 });
        inlayHints.push({ line: 98, label: ': str' });
        // Output string is immutable; mutations after render must not affect `first`
        expect(first).not.toContain('Sneak');
        expect(first).not.toContain(': str');
    });

    it('ADV: caps total rendered body at MAX_LINES even when inlay floods (combined-cap)', () => {
        // A file with a few high-signal classes but thousands of unannotated locals
        // must NOT produce a 5000-line block. The combined body must stay bounded.
        const codeLenses: ResolvedLens[] = Array.from({ length: 10 }, (_, i) => ({
            line: i + 1,
            symbol: `Sym${i}`,
            references: i + 100,
        }));
        const inlayHints: InlayTypeHint[] = Array.from({ length: 500 }, (_, i) => ({
            line: i + 20,
            label: `: T${i}`,
        }));
        const out = formatFileIntelligenceBlock('/x.py', { codeLenses, inlayHints });
        const body = bodyLines(out);
        // ≤ 100 content lines + optional truncation note = ≤ 101
        expect(body.length).toBeLessThanOrEqual(101);
    });
});
