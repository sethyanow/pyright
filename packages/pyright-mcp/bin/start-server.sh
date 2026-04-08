#!/usr/bin/env bash
# Entrypoint for the pyright-mcp plugin.
# Resolves the Pyright langserver path, then execs the MCP server.
# ALL output goes to stderr — stdout is the MCP protocol channel.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MCP_SERVER="${SCRIPT_DIR}/../dist/mcp-server.js"

# 1. Verify node is available
if ! command -v node >/dev/null 2>&1; then
    echo "Error: node not found in PATH. Install Node.js or activate nvm/fnm." >&2
    exit 1
fi

# 2. Verify MCP server dist exists
if [ ! -f "${MCP_SERVER}" ]; then
    echo "Error: MCP server not built. Run: cd packages/pyright-mcp && npm run build" >&2
    exit 1
fi

# 3. Resolve langserver path: env var → CWD-relative → error
if [ -n "${PYRIGHT_LANGSERVER_PATH:-}" ]; then
    # Explicit override
    if [ ! -f "${PYRIGHT_LANGSERVER_PATH}" ]; then
        echo "Error: PYRIGHT_LANGSERVER_PATH set but file not found: ${PYRIGHT_LANGSERVER_PATH}" >&2
        exit 1
    fi
elif [ -f "packages/pyright/dist/pyright-langserver.js" ]; then
    # CWD-relative (repo dev case — CWD is pyright repo root)
    PYRIGHT_LANGSERVER_PATH="packages/pyright/dist/pyright-langserver.js"
else
    echo "Error: Pyright langserver not found." >&2
    echo "  Either set PYRIGHT_LANGSERVER_PATH or run from the pyright repo root." >&2
    echo "  To build: npm run build:cli:dev" >&2
    exit 1
fi

export PYRIGHT_LANGSERVER_PATH
exec node "${MCP_SERVER}"
