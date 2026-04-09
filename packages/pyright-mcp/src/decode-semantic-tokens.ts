export interface DecodedToken {
    line: number;
    character: number;
    length: number;
    tokenType: string;
    tokenModifiers: string[];
}

export interface TokenLegend {
    tokenTypes: string[];
    tokenModifiers: string[];
}

export function decodeSemanticTokens(data: number[], legend: TokenLegend): DecodedToken[] {
    const tokens: DecodedToken[] = [];
    let currentLine = 0;
    let currentChar = 0;

    for (let i = 0; i + 4 < data.length; i += 5) {
        const deltaLine = data[i];
        const deltaStartChar = data[i + 1];
        const length = data[i + 2];
        const tokenTypeIndex = data[i + 3];
        const tokenModifiersBitset = data[i + 4];

        if (deltaLine > 0) {
            currentLine += deltaLine;
            currentChar = deltaStartChar;
        } else {
            currentChar += deltaStartChar;
        }

        const tokenType =
            tokenTypeIndex < legend.tokenTypes.length ? legend.tokenTypes[tokenTypeIndex] : 'unknown';

        const modifiers: string[] = [];
        for (let bit = 0; bit < legend.tokenModifiers.length; bit++) {
            if (tokenModifiersBitset & (1 << bit)) {
                modifiers.push(legend.tokenModifiers[bit]);
            }
        }

        tokens.push({
            line: currentLine,
            character: currentChar,
            length,
            tokenType,
            tokenModifiers: modifiers,
        });
    }

    return tokens;
}
