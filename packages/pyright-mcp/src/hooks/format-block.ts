export interface ResolvedLens {
    line: number;
    symbol: string;
    references?: number;
    implementations?: number;
}

const MAX_LINES = 100;

function escape(s: string): string {
    return s.replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function lensScore(l: ResolvedLens): number {
    return (l.references ?? 0) + (l.implementations ?? 0);
}

function renderLine(l: ResolvedLens): string {
    const parts = [`L${l.line}`, escape(l.symbol)];
    if (l.references !== undefined) parts.push(`refs=${l.references}`);
    if (l.implementations !== undefined) parts.push(`impls=${l.implementations}`);
    return parts.join('  ');
}

export function formatFileIntelligence(path: string, lenses: ResolvedLens[]): string {
    const open = `<file-intelligence path="${escape(path)}">`;
    const close = `</file-intelligence>`;
    if (lenses.length === 0) {
        return `${open}\n${close}\n`;
    }

    const sorted = [...lenses].sort((a, b) => lensScore(b) - lensScore(a));
    const visible = sorted.slice(0, MAX_LINES);
    const hidden = sorted.length - visible.length;

    const lines = visible.map(renderLine);
    if (hidden > 0) {
        lines.push(`… ${hidden} more symbols omitted`);
    }

    return `${open}\n${lines.join('\n')}\n${close}\n`;
}
