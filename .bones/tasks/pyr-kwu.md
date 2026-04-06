---
id: pyr-kwu
title: 'Phase 1 Acceptance: Foundation — goToImplementation + workspaceSymbol fix'
status: open
type: task
priority: 1
depends_on: [pyr-o4h]
parent: pyr-lo0
---


## Context

Phase 1 of pyr-otr (Add missing LSP providers). Demo goes through the pyright-mcp plugin's `lsp()` MCP tool.

## User Demo

Demonstrate Phase 1 features live through the MCP adapter:

1. **goToImplementation on a Protocol** — `lsp("textDocument/implementation", ...)` finds concrete classes
2. **goToImplementation on a method** — finds overriding methods in subclasses
3. **goToImplementation on a concrete class** — returns empty, not error
4. **workspaceSymbol with empty query** — `lsp("workspace/symbol", {query: ""})` returns symbols

## Success Criteria
- [ ] Demo presented to user in conversation via MCP `lsp()` tool
- [ ] User confirms acceptance (closes this task + sub-epic)
