#!/usr/bin/env bash
# SessionStart hook: verify Pyright dev build and MCP server dist exist.
set -euo pipefail

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"

# Check MCP server dist
MCP_SERVER="${PLUGIN_ROOT}/dist/mcp-server.js"
if [ ! -f "${MCP_SERVER}" ]; then
    echo "Warning: MCP server not built. Run: cd packages/pyright-mcp && npm run build"
fi

# Check langserver: env var → CWD-relative
if [ -n "${PYRIGHT_LANGSERVER_PATH:-}" ]; then
    if [ ! -f "${PYRIGHT_LANGSERVER_PATH}" ]; then
        echo "Warning: PYRIGHT_LANGSERVER_PATH set but file not found: ${PYRIGHT_LANGSERVER_PATH}"
    fi
elif [ ! -f "packages/pyright/dist/pyright-langserver.js" ]; then
    echo "Warning: Pyright dev build not found. Run: npm run build:cli:dev"
fi
