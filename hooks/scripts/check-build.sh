#!/usr/bin/env bash
# SessionStart hook: verify Pyright dev build exists.
set -euo pipefail

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
LANGSERVER="$PLUGIN_ROOT/packages/pyright/dist/pyright-langserver.js"

if [ ! -f "$LANGSERVER" ]; then
    echo "⚠️ Pyright dev build not found. Run: npm run build:cli:dev"
fi
