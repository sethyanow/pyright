import path from 'path';

export function resolveLangserverPath(): string {
    return process.env.PYRIGHT_LANGSERVER_PATH || path.resolve(__dirname, 'pyright-langserver.js');
}
