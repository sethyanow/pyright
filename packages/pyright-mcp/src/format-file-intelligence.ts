import type { DecodedToken } from './decode-semantic-tokens';

export interface Position {
    line: number;
    character: number;
}

export interface Range {
    start: Position;
    end: Position;
}

export interface ResolvedCodeLens {
    range: Range;
    count: number;
    kind: 'references' | 'implementations';
}

export interface TypeInlay {
    position: Position;
    label: string;
}

export interface FileIntelligenceInput {
    path: string;
    source: string;
    codeLens: ResolvedCodeLens[];
    inlays: TypeInlay[];
    tokens: DecodedToken[];
}

// Token types that are irrelevant as emission candidates — pure syntax,
// never carry modifiers/counts/inlay attachments. Everything else is seeded
// and the emission-gating filter keeps only those with an actual emission.
const SKIP_TOKEN_TYPES = new Set([
    'keyword',
    'comment',
    'string',
    'number',
    'regexp',
    'operator',
    'decorator',
    'namespace',
]);

// Token types that can receive an inlay Type hint attachment. Excludes
// parameter/typeParameter (hint never decorates them) so a return-type hint
// on `def f(x: int, y: int):` goes to `f`, not to the trailing `int` annotation.
const INLAY_TARGET_TYPES = new Set(['class', 'method', 'function', 'variable', 'property', 'enumMember']);

interface SymbolEntry {
    line: number; // 0-indexed
    character: number; // 0-indexed
    length: number;
    tokenType: string;
    modifiers: string[];
    refs?: number;
    impls?: number;
    inlayLabel?: string;
}

function escapeAttr(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

function escapeContent(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

function extractName(source: string, line: number, character: number, length: number): string {
    // Slice identifier text by line/char/length. Work line-by-line so CRLF source
    // doesn't throw off offsets — we only need the line's content.
    const lines = source.split('\n');
    if (line < 0 || line >= lines.length) {
        return '';
    }
    const lineText = lines[line];
    // Strip trailing \r if present (CRLF source)
    const clean = lineText.endsWith('\r') ? lineText.slice(0, -1) : lineText;
    return clean.slice(character, character + length);
}

export function formatFileIntelligence(input: FileIntelligenceInput): string {
    const entries: SymbolEntry[] = [];

    // 1. Seed entries from semantic tokens. Skip pure-syntax types; keep
    // everything that could carry modifiers, counts, or an inlay attachment.
    // The emission-gating filter (step 4) drops entries with zero emissions.
    for (const t of input.tokens) {
        if (SKIP_TOKEN_TYPES.has(t.tokenType)) {
            continue;
        }
        entries.push({
            line: t.line,
            character: t.character,
            length: t.length,
            tokenType: t.tokenType,
            modifiers: [...t.tokenModifiers],
        });
    }

    // 2. Attach codeLens counts. Lens range.start also marks a definition position
    // (codeLens is seeded from DocumentSymbolProvider), which we capture for the
    // emission gate so reference-site tokens don't emit modifier-only lines.
    const definitionPositions = new Set<string>();
    for (const lens of input.codeLens) {
        const lensLine = lens.range.start.line;
        const lensCol = lens.range.start.character;
        definitionPositions.add(`${lensLine}:${lensCol}`);
        if (lens.count <= 0) {
            continue; // Omit zero-count lenses from count emissions.
        }
        const match = entries.find(
            (e) => e.line === lensLine && e.character === lensCol
        );
        if (!match) {
            continue; // Orphan lens — no symbol at that position.
        }
        if (lens.kind === 'references') {
            match.refs = lens.count;
        } else {
            match.impls = lens.count;
        }
    }

    // 3. Attach inlay Type hints. Group by line for O(n log n) attribution.
    const inlaysByLine = new Map<number, TypeInlay[]>();
    for (const hint of input.inlays) {
        const bucket = inlaysByLine.get(hint.position.line);
        if (bucket) {
            bucket.push(hint);
        } else {
            inlaysByLine.set(hint.position.line, [hint]);
        }
    }
    // For each line, sort inlays by column ascending so attribution is stable.
    for (const bucket of inlaysByLine.values()) {
        bucket.sort((a, b) => a.position.character - b.position.character);
    }
    // Group eligible entries by line for rightmost-match attribution.
    // Only class/method/function/variable/property tokens receive inlays.
    const entriesByLine = new Map<number, SymbolEntry[]>();
    for (const e of entries) {
        if (!INLAY_TARGET_TYPES.has(e.tokenType)) continue;
        const bucket = entriesByLine.get(e.line);
        if (bucket) {
            bucket.push(e);
        } else {
            entriesByLine.set(e.line, [e]);
        }
    }
    for (const bucket of entriesByLine.values()) {
        bucket.sort((a, b) => a.character - b.character);
    }
    for (const [lineNum, hints] of inlaysByLine) {
        const lineEntries = entriesByLine.get(lineNum);
        if (!lineEntries || lineEntries.length === 0) {
            continue; // No eligible symbols on this line → drop hints.
        }
        for (const hint of hints) {
            // Leftmost eligible symbol with column strictly less than hint column.
            // Pyright emits Type inlays immediately after the defining symbol,
            // and the defining symbol is always the leftmost eligible on the line
            // (`def NAME(...)`, `NAME = ...`). This avoids attaching a return-type
            // hint to a trailing `int` annotation inside the parameter list.
            const chosen = lineEntries.find((e) => e.character < hint.position.character);
            if (chosen && chosen.inlayLabel === undefined) {
                chosen.inlayLabel = hint.label;
            }
        }
    }

    // 4. Emission gate + sort.
    // - Tokens at definition sites (lens-known positions) emit any enrichment.
    // - Tokens NOT at definition sites emit only if they received an inlay hint.
    //   This suppresses reference-site modifier noise (e.g. `Greeter [abstract]`
    //   showing at every parent-class reference across the file).
    const emitting = entries.filter((e) => {
        const hasEnrichment =
            e.modifiers.length > 0 ||
            e.refs !== undefined ||
            e.impls !== undefined ||
            e.inlayLabel !== undefined;
        if (!hasEnrichment) return false;
        const isDef = definitionPositions.has(`${e.line}:${e.character}`);
        return isDef || e.inlayLabel !== undefined;
    });
    emitting.sort((a, b) => a.line - b.line || a.character - b.character);

    // 5. Render.
    const lines: string[] = [];
    lines.push(`<file-intelligence path="${escapeAttr(input.path)}">`);
    for (const e of emitting) {
        const name = extractName(input.source, e.line, e.character, e.length);
        const parts: string[] = [];
        parts.push(`L${e.line + 1}:${e.character + 1}`);
        parts.push(e.tokenType);
        parts.push(name);
        if (e.modifiers.length > 0) {
            parts.push(`[${e.modifiers.join(',')}]`);
        }
        if (e.refs !== undefined) {
            parts.push(`refs=${e.refs}`);
        }
        if (e.impls !== undefined) {
            parts.push(`impls=${e.impls}`);
        }
        if (e.inlayLabel !== undefined) {
            parts.push(escapeContent(e.inlayLabel));
        }
        lines.push(parts.join(' '));
    }
    lines.push('</file-intelligence>');
    return lines.join('\n');
}
