import { existsSync } from 'fs';
import path from 'path';

export function resolveLangserverPath(): string {
    if (process.env.PYRIGHT_LANGSERVER_PATH) return process.env.PYRIGHT_LANGSERVER_PATH;
    // Resolution from common bundle locations:
    //   dist/proxy.js              → ./pyright-langserver.js
    //   dist/hooks/enrich-file.js  → ../pyright-langserver.js
    const candidates = [
        path.resolve(__dirname, 'pyright-langserver.js'),
        path.resolve(__dirname, '..', 'pyright-langserver.js'),
    ];
    for (const c of candidates) {
        if (existsSync(c)) return c;
    }
    return candidates[0];
}
