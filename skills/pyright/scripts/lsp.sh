#!/usr/bin/env bash
# Wrapper script for agents without MCP access.
# Usage: lsp.sh <method> <params_json>
#
# Examples:
#   lsp.sh workspace/symbol '{"query": "MyClass"}'
#   lsp.sh textDocument/hover '{"textDocument":{"uri":"file:///tmp/foo.py"},"position":{"line":0,"character":0}}'

set -euo pipefail

METHOD="${1:?Usage: lsp.sh <method> <params_json>}"
PARAMS="${2:-{}}"

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/../../.." && pwd)}"
MCP_SERVER="$PLUGIN_ROOT/packages/pyright-mcp/dist/mcp-server.js"

if [ ! -f "$MCP_SERVER" ]; then
    echo "Error: MCP server not built. Run: cd $PLUGIN_ROOT/packages/pyright-mcp && npm run build" >&2
    exit 1
fi

# Construct MCP tool call JSON-RPC message
REQUEST=$(cat <<EOF
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"lsp","arguments":{"method":"$METHOD","params":$PARAMS}}}
EOF
)

BODY="Content-Length: ${#REQUEST}\r\n\r\n$REQUEST"

# Send to MCP server via stdio and extract the result
echo -ne "$BODY" | node "$MCP_SERVER" 2>/dev/null | head -1 | sed 's/^Content-Length: [0-9]*\r\n\r\n//'
