---
name: pyright-lsp
description: >-
  This skill should be used when querying the Pyright language server for Python
  code intelligence — "find implementations of this class", "search for symbols",
  "go to definition", "find references", "what type is this". Provides two access
  paths: the MCP lsp() tool (preferred) and a TypeScript CLI for agents without
  MCP access.
---

# Pyright LSP

Query the Pyright language server for Python code intelligence. Two access paths:

1. **MCP tool `lsp()`** — preferred, available when the pyright MCP server is running
2. **CLI `lsp-client`** — standalone, spawns its own Pyright instance per invocation

## MCP Tool

```
lsp({ method: "workspace/symbol", params: { query: "ClassName" } })
```

The MCP server maintains a persistent Pyright instance. Queries are fast after
initial analysis.

## CLI (non-MCP agents)

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/lsp-client.js <method> '<params_json>'
```

Each invocation spawns a fresh Pyright, waits for analysis, runs the query,
shuts down. Slower than MCP but works without any MCP infrastructure.

### Examples

Find all symbols matching a name:
```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/lsp-client.js \
  workspace/symbol '{"query": "MyClass"}'
```

Find all symbols (empty query):
```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/lsp-client.js \
  workspace/symbol '{"query": ""}'
```

Find implementations of a class (ABC/base class → concrete subclasses):
```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/lsp-client.js \
  textDocument/implementation \
  '{"textDocument":{"uri":"file:///path/to/file.py"},"position":{"line":5,"character":6}}'
```

Go to definition:
```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/lsp-client.js \
  textDocument/definition \
  '{"textDocument":{"uri":"file:///path/to/file.py"},"position":{"line":10,"character":4}}'
```

## Key Details

**URI format**: All `textDocument` methods require `file:///absolute/path` URIs. Spaces
and special characters must be percent-encoded.

**Positions are zero-based**: line 0 = first line, character 0 = first column.

**Implementation finds explicit subclasses**, not structural Protocol subtypes. Use on
ABC base classes, not Protocols.

**Analysis timing**: Pyright runs background analysis after startup. The CLI handles
this automatically (polls until results appear). The MCP server is ready after
initialization, but the first query on a large workspace may see partial results.

**Build prerequisite**: Requires `npm run build:cli:dev` (Pyright langserver bundle)
and `cd packages/pyright-mcp && npm run build` (CLI wrapper). The SessionStart hook
warns if the langserver bundle is missing.

## Available Methods

| Method | What it does |
|--------|-------------|
| `workspace/symbol` | Search symbols across workspace by name |
| `textDocument/implementation` | Find concrete subclasses of a class |
| `textDocument/definition` | Jump to where a symbol is defined |
| `textDocument/references` | Find all usages of a symbol |
| `textDocument/hover` | Get type information at a position |
| `textDocument/documentSymbol` | List all symbols in a single file |

Any LSP method Pyright supports works — these are the most useful for agents.
