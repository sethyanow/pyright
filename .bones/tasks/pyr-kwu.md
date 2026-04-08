---
id: pyr-kwu
title: 'Phase 1 Acceptance: Foundation — goToImplementation + workspaceSymbol fix'
status: closed
type: task
priority: 1
owner: Seth
depends_on: [pyr-o4h, pyr-tbs, pyr-g5x]
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
- [x] Demo presented to user in conversation via MCP `lsp()` tool
- [x] User confirms acceptance (closes this task + sub-epic)

## Log

- [2026-04-08T23:53:07Z] [Seth] Acceptance gate passed. All 4 demos verified via MCP lsp() tool: (1) goToImplementation on ABC Greeter found EnglishGreeter + SpanishGreeter, (2) goToImplementation on method greet found both overrides, (3) goToImplementation on concrete EnglishGreeter returned null (correct per LSP spec), (4) workspaceSymbol with empty query returned symbols. User confirmed acceptance.
