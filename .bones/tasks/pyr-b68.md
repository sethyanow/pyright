---
id: pyr-b68
title: go_to_definition returns empty on async method definitions at keyword position
status: open
type: bug
priority: 2
---

## Bug Report — Field Observation

**Source:** ChunkHound MCP tool acceptance testing (chunkhound project)
**Reporter:** AI agent during live MCP tool demo
**Pyright version:** 1.1.408 (via LSP stdio transport)

### Reproduction

`textDocument/definition` returns empty `[]` when the cursor position is on the `async` or `def` keyword of a method definition. Positioning on the method **name** works correctly.

**Steps:**
1. Open a Python file via `textDocument/didOpen` (or rely on Pyright's on-disk analysis)
2. Send `textDocument/definition` at the position of the `async` keyword (or `def` keyword) of a method
3. Result: empty array `[]`
4. Send `textDocument/definition` at the position of the method **name** identifier
5. Result: correct Location pointing to the definition

**Concrete example:**
```python
# chunkhound/services/lsp_population.py, line 58 (1-based):
    async def populate_file(
#   ^~~~~                        ← definition here returns []
#              ^~~~~~~~~~~~~     ← definition here returns correct Location
```

LSP request that returns empty:
```json
{"method": "textDocument/definition", "params": {"textDocument": {"uri": "file:///path/to/lsp_population.py"}, "position": {"line": 57, "character": 14}}}
```

### Context

Discovered during ChunkHound's LSP edge population pipeline. The population service calls `find_references` and `go_to_definition` at `SymbolInfo.range.start` positions from `textDocument/documentSymbol` responses. For class/method definitions, `range.start` points to the beginning of the full definition (keyword), not `selectionRange.start` (the name).

This means `go_to_definition` at `range.start` silently returns nothing for many symbols. The workaround is to use `selectionRange.start` instead, which we've implemented in ChunkHound.

### Expected Behavior

`textDocument/definition` at a keyword position (`async`, `def`, `class`) that is part of a symbol definition should resolve to that symbol's definition location — same as positioning on the name.

### Impact

Low — workaround exists (use `selectionRange`). But it's a papercut for any tool that iterates `documentSymbol` results and calls definition/references at `range.start`.

### Workaround

Use `selectionRange.start` instead of `range.start` for all LSP operations that need symbol identity.

## Success Criteria
- [ ] `textDocument/definition` at keyword positions resolves to the containing symbol
