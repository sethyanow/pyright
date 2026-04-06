---
name: pyright-lsp
description: >-
  This skill should be used when querying the Pyright language server for Python
  code intelligence. Use when the user asks to "find implementations", "search
  symbols", "go to definition", "find references", "check types", or perform any
  LSP operation on Python code. Provides the lsp() MCP tool and wrapper scripts
  for non-MCP agents.
---

# Pyright LSP

Query the Pyright language server for Python code intelligence through the MCP
`lsp()` tool. Supports any LSP method — workspace/symbol, textDocument/implementation,
textDocument/definition, textDocument/references, and more.

## Usage

### MCP Tool: `lsp(method, params)`

Send any LSP request to the running Pyright instance:

```
lsp({
  method: "workspace/symbol",
  params: { query: "ClassName" }
})
```

### URI Format

All `textDocument` methods require file URIs — not bare paths:

```
file:///absolute/path/to/file.py
```

Spaces and special characters must be percent-encoded.

### Available LSP Methods

| Method | Purpose | Key Params |
|--------|---------|------------|
| `workspace/symbol` | Search symbols across workspace | `{ query: "" }` (empty = all) |
| `textDocument/implementation` | Find concrete implementations of a Protocol/ABC | `{ textDocument: { uri }, position: { line, character } }` |
| `textDocument/definition` | Jump to definition | Same as above |
| `textDocument/references` | Find all references | Same + `{ context: { includeDeclaration: true } }` |
| `textDocument/hover` | Type info at position | `{ textDocument: { uri }, position: { line, character } }` |
| `textDocument/documentSymbol` | List symbols in a file | `{ textDocument: { uri } }` |

Positions are zero-based (line 0 = first line, character 0 = first column).

### Analysis Timing

After startup, Pyright performs background analysis. The first few queries may
return partial results. Poll `workspace/symbol` with a known query to verify
analysis is complete before relying on results.

## Wrapper Scripts

For agents that don't have MCP access, use the wrapper scripts directly:

```bash
# Search symbols
$CLAUDE_PLUGIN_ROOT/skills/pyright/scripts/lsp.sh workspace/symbol '{"query": "MyClass"}'

# Find implementations
$CLAUDE_PLUGIN_ROOT/skills/pyright/scripts/lsp.sh textDocument/implementation \
  '{"textDocument":{"uri":"file:///path/to/file.py"},"position":{"line":5,"character":10}}'
```

## Error Handling

- **Unsupported method**: Returns LSP MethodNotFound error (-32601)
- **Invalid URI**: Pyright returns empty results (not an error)
- **Pyright not built**: Returns "Pyright langserver failed to start" error
- **Request timeout**: Returns timeout error after 30 seconds
