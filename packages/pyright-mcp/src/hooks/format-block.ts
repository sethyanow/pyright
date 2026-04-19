export interface ResolvedLens {
    line: number;
    symbol: string;
    references?: number;
    implementations?: number;
}

export interface InlayTypeHint {
    line: number;
    label: string;
}

export interface FileIntelligence {
    codeLenses: ResolvedLens[];
    inlayHints: InlayTypeHint[];
}

const MAX_LINES = 100;

function escape(s: string): string {
    return s.replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function lensScore(l: ResolvedLens): number {
    return (l.references ?? 0) + (l.implementations ?? 0);
}

function renderLensLine(l: ResolvedLens): string {
    const parts = [`L${l.line}`, escape(l.symbol)];
    if (l.references !== undefined) parts.push(`refs=${l.references}`);
    if (l.implementations !== undefined) parts.push(`impls=${l.implementations}`);
    return parts.join('  ');
}

function renderInlayLine(h: InlayTypeHint): string {
    return `L${h.line}  ${escape(h.label)}`;
}

function openTag(path: string): string {
    return `<file-intelligence path="${escape(path)}">`;
}

const CLOSE_TAG = `</file-intelligence>`;

export function formatFileIntelligence(path: string, lenses: ResolvedLens[]): string {
    return formatFileIntelligenceBlock(path, { codeLenses: lenses, inlayHints: [] });
}

function dedupeInlay(hints: InlayTypeHint[]): InlayTypeHint[] {
    const seen = new Set<string>();
    const out: InlayTypeHint[] = [];
    for (const h of hints) {
        const k = `${h.line}\x00${h.label}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(h);
    }
    return out;
}

type MergedEntry =
    | { kind: 'lens'; line: number; render: string }
    | { kind: 'inlay'; line: number; render: string };

export function formatFileIntelligenceBlock(path: string, intel: FileIntelligence): string {
    const open = openTag(path);
    const { codeLenses, inlayHints } = intel;

    if (codeLenses.length === 0 && inlayHints.length === 0) {
        return `${open}\n${CLOSE_TAG}\n`;
    }

    // Phase 1: score-sort codeLens and cap at MAX_LINES. High-signal codeLens claims budget first
    // so an inlay flood cannot evict it.
    const lensSorted = [...codeLenses].sort((a, b) => lensScore(b) - lensScore(a));
    const lensVisible = lensSorted.slice(0, MAX_LINES);
    const lensHidden = lensSorted.length - lensVisible.length;

    // Phase 2: dedupe inlay, then cap to remaining budget. Total body lines stay ≤ MAX_LINES.
    const inlayUnique = dedupeInlay(inlayHints);
    const remaining = Math.max(0, MAX_LINES - lensVisible.length);
    const inlayVisible = inlayUnique.slice(0, remaining);
    const inlayHidden = inlayUnique.length - inlayVisible.length;

    // Phase 3: merge into MergedEntry[], stable-sort by line with lens-before-inlay tiebreak.
    const merged: MergedEntry[] = [
        ...lensVisible.map<MergedEntry>((l) => ({ kind: 'lens', line: l.line, render: renderLensLine(l) })),
        ...inlayVisible.map<MergedEntry>((h) => ({ kind: 'inlay', line: h.line, render: renderInlayLine(h) })),
    ];
    merged.sort((a, b) => {
        if (a.line !== b.line) return a.line - b.line;
        if (a.kind === b.kind) return 0;
        return a.kind === 'lens' ? -1 : 1;
    });

    const lines = merged.map((e) => e.render);
    const totalHidden = lensHidden + inlayHidden;
    if (totalHidden > 0) {
        // Preserve prior phrasing when only codeLens overflowed, so pyr-noe's
        // "more symbols omitted" regression test still matches exactly.
        const label = inlayHidden === 0 ? 'symbols' : 'entries';
        lines.push(`… ${totalHidden} more ${label} omitted`);
    }

    return `${open}\n${lines.join('\n')}\n${CLOSE_TAG}\n`;
}
