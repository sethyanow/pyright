import {
    formatFileIntelligence,
    type FileIntelligenceInput,
    type ResolvedCodeLens,
    type TypeInlay,
} from '../format-file-intelligence';
import type { DecodedToken } from '../decode-semantic-tokens';

// Minimal source fixture — 14 lines covering ABC, override, unannotated function
const SOURCE = [
    'from abc import ABC, abstractmethod', // line 0
    '',
    '',
    'class Greeter(ABC):', // line 3, `Greeter` at col 6
    '    @abstractmethod',
    '    def greet(self, name: str) -> str: ...', // line 5, `greet` at col 8
    '',
    '',
    'class EnglishGreeter(Greeter):', // line 8, `EnglishGreeter` at col 6
    '    def greet(self, name: str) -> str:', // line 9, `greet` at col 8
    '        return f"Hello, {name}!"',
    '',
    '',
    'def add(x, y):', // line 13, `add` at col 4
].join('\n');

function tok(line: number, character: number, length: number, tokenType: string, mods: string[] = []): DecodedToken {
    return { line, character, length, tokenType, tokenModifiers: mods };
}

function emptyInput(overrides: Partial<FileIntelligenceInput> = {}): FileIntelligenceInput {
    return {
        path: '/abs/path/to/file.py',
        source: '',
        codeLens: [],
        inlays: [],
        tokens: [],
        ...overrides,
    };
}

describe('formatFileIntelligence', () => {
    describe('wrapper and empty input', () => {
        it('wraps empty input in a valid <file-intelligence> block', () => {
            const out = formatFileIntelligence(emptyInput());
            expect(out.startsWith('<file-intelligence path="/abs/path/to/file.py">')).toBe(true);
            expect(out.trimEnd().endsWith('</file-intelligence>')).toBe(true);
        });

        it('contains no symbol lines when there are no emissions', () => {
            const out = formatFileIntelligence(emptyInput());
            const bodyLines = out
                .split('\n')
                .filter((l: string) => l.startsWith('L'));
            expect(bodyLines).toHaveLength(0);
        });
    });

    // Emission rule: modifier-only lines require a codeLens to mark the position
    // as a definition site. A zero-count lens still counts — its purpose here is
    // to distinguish definition positions from reference-site tokens (which should
    // be suppressed to avoid repeating `Greeter [abstract]` at every reference).
    const defLens = (line: number, character: number): ResolvedCodeLens => ({
        range: { start: { line, character }, end: { line, character } },
        count: 0,
        kind: 'references',
    });

    describe('semantic modifiers', () => {
        it('emits a class line with [abstract] when the token has the abstract modifier at a definition site', () => {
            const out = formatFileIntelligence(
                emptyInput({
                    source: SOURCE,
                    tokens: [tok(3, 6, 7, 'class', ['abstract'])],
                    codeLens: [defLens(3, 6)],
                })
            );
            expect(out).toContain('L4:7 class Greeter [abstract]');
        });

        it('emits a method line with [override] for a subclass method definition', () => {
            const out = formatFileIntelligence(
                emptyInput({
                    source: SOURCE,
                    tokens: [tok(9, 8, 5, 'method', ['override'])],
                    codeLens: [defLens(9, 8)],
                })
            );
            expect(out).toContain('L10:9 method greet [override]');
        });

        it('joins multiple modifiers with commas', () => {
            const out = formatFileIntelligence(
                emptyInput({
                    source: SOURCE,
                    tokens: [tok(5, 8, 5, 'method', ['abstract', 'override'])],
                    codeLens: [defLens(5, 8)],
                })
            );
            expect(out).toContain('[abstract,override]');
        });

        it('suppresses modifier-only lines at reference sites (not definition positions)', () => {
            // Parent-class reference inside `class EnglishGreeter(Greeter):` —
            // Pyright emits [abstract] on the reference, but we want to show the
            // modifier once at the definition, not at every parent-class mention.
            const out = formatFileIntelligence(
                emptyInput({
                    source: SOURCE,
                    tokens: [
                        tok(3, 6, 7, 'class', ['abstract']), // Greeter definition
                        tok(8, 21, 7, 'class', ['abstract']), // Greeter reference inside EnglishGreeter(Greeter)
                    ],
                    codeLens: [defLens(3, 6)], // only the definition is lens-known
                })
            );
            expect(out).toContain('L4:7 class Greeter [abstract]');
            // Reference site suppressed
            expect(out).not.toContain('L9:22');
        });
    });

    describe('codeLens counts', () => {
        it('emits refs=N on a class symbol when references codeLens is present', () => {
            const out = formatFileIntelligence(
                emptyInput({
                    source: SOURCE,
                    tokens: [tok(8, 6, 14, 'class', [])],
                    codeLens: [
                        {
                            range: { start: { line: 8, character: 6 }, end: { line: 8, character: 20 } },
                            count: 1,
                            kind: 'references',
                        },
                    ],
                })
            );
            expect(out).toContain('L9:7 class EnglishGreeter refs=1');
        });

        it('emits both refs=N and impls=M on a class with both kinds of lens', () => {
            const out = formatFileIntelligence(
                emptyInput({
                    source: SOURCE,
                    tokens: [tok(3, 6, 7, 'class', ['abstract'])],
                    codeLens: [
                        {
                            range: { start: { line: 3, character: 6 }, end: { line: 3, character: 13 } },
                            count: 3,
                            kind: 'references',
                        },
                        {
                            range: { start: { line: 3, character: 6 }, end: { line: 3, character: 13 } },
                            count: 2,
                            kind: 'implementations',
                        },
                    ],
                })
            );
            expect(out).toContain('L4:7 class Greeter [abstract] refs=3 impls=2');
        });

        it('omits refs= when count is zero', () => {
            const out = formatFileIntelligence(
                emptyInput({
                    source: SOURCE,
                    tokens: [tok(3, 6, 7, 'class', ['abstract'])],
                    codeLens: [
                        {
                            range: { start: { line: 3, character: 6 }, end: { line: 3, character: 13 } },
                            count: 0,
                            kind: 'references',
                        },
                    ],
                })
            );
            expect(out).not.toContain('refs=');
            // But [abstract] modifier still carries the line
            expect(out).toContain('L4:7 class Greeter [abstract]');
        });
    });

    describe('inlay Type hints', () => {
        it('attaches a Type inlay to a function symbol on the same line (hint to the right)', () => {
            // `def add(x, y):` — `add` at col 4, hint lands at col 14 (after `)`)
            const out = formatFileIntelligence(
                emptyInput({
                    source: SOURCE,
                    tokens: [tok(13, 4, 3, 'function', [])],
                    inlays: [
                        {
                            position: { line: 13, character: 14 },
                            label: ': int',
                        },
                    ],
                })
            );
            expect(out).toContain('L14:5 function add : int');
        });

        it('picks the leftmost eligible symbol on the line (Pyright emits inlays on defining symbols)', () => {
            // `def multiply(x: int, y: int):` — return-type hint should attach to
            // `multiply` (the function being defined), not the trailing `int`
            // type annotation in the parameter list.
            const srcLine = 'def multiply(x: int, y: int):';
            const out = formatFileIntelligence(
                emptyInput({
                    source: srcLine,
                    tokens: [
                        tok(0, 4, 8, 'function', []), // `multiply` at col 4
                        tok(0, 16, 3, 'class', []), // `int` (x annotation) at col 16
                        tok(0, 24, 3, 'class', []), // `int` (y annotation) at col 24
                    ],
                    inlays: [{ position: { line: 0, character: 29 }, label: ': int' }],
                })
            );
            expect(out).toContain('L1:5 function multiply : int');
            expect(out).not.toMatch(/class int.*: int/);
        });

        it('drops an inlay when no symbol on that line has column ≤ hint column', () => {
            // Hint at col 2, only symbol at col 10 — no match
            const srcLine = '          foo';
            const out = formatFileIntelligence(
                emptyInput({
                    source: srcLine,
                    tokens: [tok(0, 10, 3, 'function', [])],
                    inlays: [{ position: { line: 0, character: 2 }, label: ': str' }],
                })
            );
            // The function has no emissions (modifiers empty, no codeLens, no matching inlay)
            const bodyLines = out.split('\n').filter((l: string) => l.startsWith('L'));
            expect(bodyLines).toHaveLength(0);
        });
    });

    describe('sorting and filtering', () => {
        it('sorts output lines by (line, column) ascending', () => {
            const out = formatFileIntelligence(
                emptyInput({
                    source: SOURCE,
                    tokens: [
                        // Deliberately out of order
                        tok(9, 8, 5, 'method', ['override']),
                        tok(3, 6, 7, 'class', ['abstract']),
                        tok(8, 6, 14, 'class', []),
                    ],
                    codeLens: [
                        defLens(3, 6), // Greeter def
                        defLens(9, 8), // greet def
                        {
                            range: { start: { line: 8, character: 6 }, end: { line: 8, character: 20 } },
                            count: 1,
                            kind: 'references',
                        },
                    ],
                })
            );
            const bodyLines = out.split('\n').filter((l: string) => l.startsWith('L'));
            // Expect L4 (class Greeter), L9 (class EnglishGreeter), L10 (method greet)
            expect(bodyLines[0].startsWith('L4:')).toBe(true);
            expect(bodyLines[1].startsWith('L9:')).toBe(true);
            expect(bodyLines[2].startsWith('L10:')).toBe(true);
        });

        it('skips symbols with no emissions (no modifiers, no counts, no inlay)', () => {
            const out = formatFileIntelligence(
                emptyInput({
                    source: SOURCE,
                    tokens: [
                        tok(3, 6, 7, 'class', []), // no modifiers, no lens → skip
                        tok(8, 6, 14, 'class', []), // no modifiers, no lens → skip
                    ],
                })
            );
            const bodyLines = out.split('\n').filter((l: string) => l.startsWith('L'));
            expect(bodyLines).toHaveLength(0);
        });
    });

    describe('adversarial: structural patterns', () => {
        it('singular — one token with no enrichments emits no body lines', () => {
            const out = formatFileIntelligence(
                emptyInput({
                    source: 'class Foo:\n',
                    tokens: [tok(0, 6, 3, 'class', [])],
                })
            );
            expect(out.split('\n').filter((l: string) => l.startsWith('L'))).toHaveLength(0);
        });

        it('encoding — Unicode identifier slices by offset (BMP char takes 1 UTF-16 unit)', () => {
            // Python allows Unicode identifiers. Pyright reports length in UTF-16 units.
            const src = 'class Caf\u00e9:\n'; // 'Café' (é is 1 UTF-16 unit)
            const out = formatFileIntelligence(
                emptyInput({
                    source: src,
                    tokens: [tok(0, 6, 4, 'class', ['abstract'])],
                    codeLens: [
                        { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 10 } }, count: 0, kind: 'references' },
                    ],
                })
            );
            expect(out).toContain('class Caf\u00e9 [abstract]');
        });

        it('type boundaries — zero-length token is tolerated (name slice is empty string)', () => {
            const out = formatFileIntelligence(
                emptyInput({
                    source: 'x = 1\n',
                    tokens: [tok(0, 0, 0, 'variable', [])],
                    inlays: [{ position: { line: 0, character: 2 }, label: ': int' }],
                })
            );
            // Name is empty but line still emits via inlay path. `variable  : int`
            // with double-space is acceptable — no crash, valid block.
            expect(out).toContain('variable');
            expect(out).toContain(': int');
            expect(out.trimEnd().endsWith('</file-intelligence>')).toBe(true);
        });

        it('type boundaries — large line/column numbers render without overflow', () => {
            const out = formatFileIntelligence(
                emptyInput({
                    source: '',
                    tokens: [tok(999_999, 999_999, 3, 'class', ['abstract'])],
                    codeLens: [
                        {
                            range: { start: { line: 999_999, character: 999_999 }, end: { line: 999_999, character: 1_000_002 } },
                            count: 42,
                            kind: 'references',
                        },
                    ],
                })
            );
            expect(out).toContain('L1000000:1000000');
            expect(out).toContain('refs=42');
        });

        it('semantically hostile — token position past end of source (name slice returns empty, no crash)', () => {
            const out = formatFileIntelligence(
                emptyInput({
                    source: 'x\n',
                    // Token claims line 5, col 20, but source only has 1 line
                    tokens: [tok(5, 20, 3, 'class', ['abstract'])],
                    codeLens: [
                        { range: { start: { line: 5, character: 20 }, end: { line: 5, character: 23 } }, count: 1, kind: 'references' },
                    ],
                })
            );
            // No crash, still produces valid block. Name is empty string.
            expect(out).toContain('<file-intelligence');
            expect(out.trimEnd().endsWith('</file-intelligence>')).toBe(true);
        });

        it('dense — many tokens on one line resolve inlay attribution correctly', () => {
            // Line with 20 eligible tokens; inlay lands near col 200 → leftmost eligible
            // with col < 200 gets the inlay.
            const tokens = Array.from({ length: 20 }, (_, i) => tok(0, i * 10, 5, 'class', []));
            const inlay = { position: { line: 0, character: 200 }, label: ': int' };
            const out = formatFileIntelligence(
                emptyInput({
                    source: ' '.repeat(250),
                    tokens,
                    inlays: [inlay],
                })
            );
            // Leftmost is the token at col 0 — should receive the inlay.
            expect(out).toContain('L1:1 class');
            expect(out).toContain(': int');
            // Only one emission (the receiver). Other 19 tokens have no enrichment.
            const bodyLines = out.split('\n').filter((l: string) => l.startsWith('L'));
            expect(bodyLines).toHaveLength(1);
        });

        it('second run — same input produces identical output (idempotent)', () => {
            const input = emptyInput({
                source: 'class Foo:\n',
                tokens: [tok(0, 6, 3, 'class', ['abstract'])],
                codeLens: [
                    { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } }, count: 1, kind: 'references' },
                ],
            });
            const out1 = formatFileIntelligence(input);
            const out2 = formatFileIntelligence(input);
            expect(out1).toBe(out2);
        });
    });

    describe('XML-ish escaping', () => {
        it('escapes < and & and " in the path attribute', () => {
            const out = formatFileIntelligence(
                emptyInput({
                    path: '/tmp/a<b&c"d.py',
                })
            );
            expect(out).toContain('path="/tmp/a&lt;b&amp;c&quot;d.py"');
        });

        it('escapes < and & in inlay labels but preserves > verbatim', () => {
            // Label `: Callable[[int], <unknown>]` is contrived but exercises escapes.
            // We expect `<` → &lt;, `&` → &amp;, but `>` stays as `>`.
            const out = formatFileIntelligence(
                emptyInput({
                    source: 'x = f()\n',
                    tokens: [tok(0, 0, 1, 'variable', [])],
                    inlays: [
                        {
                            position: { line: 0, character: 2 },
                            label: ': A<B>&C',
                        },
                    ],
                })
            );
            expect(out).toContain(': A&lt;B>&amp;C');
            expect(out).not.toContain(': A<B');
            expect(out).not.toContain('&C &amp;'); // no double-escape
        });
    });
});
