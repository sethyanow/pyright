---
id: pyr-lo0
title: 'Phase 1: Foundation — goToImplementation + workspaceSymbol fix'
status: open
type: epic
priority: 1
depends_on: [pyr-rcy, pyr-e3e, pyr-kwu, pyr-o4h, pyr-tbs, pyr-g5x]
parent: pyr-otr
---



















## Context
Parent epic pyr-otr, Phase 1. No prior phase dependencies — this is the foundation.

Establishes three things: (1) the "find subclasses/implementors" machinery that Phase 2 (type hierarchy) reuses for subtypes, (2) working cross-workspace symbol search that every subsequent phase benefits from, and (3) the plugin + MCP adapter that every phase's demo and acceptance gates depend on.

Completed tasks:
- pyr-rcy: Remove empty-query guard in workspaceSymbolProvider.ts (CLOSED)
- pyr-e3e: Add ImplementationProvider following TypeDefinitionProvider pattern (CLOSED)

Remaining:
- pyr-o4h: Plugin + MCP adapter — thin bridge exposing LSP capabilities to agents (not Claude-only)
- pyr-kwu: Phase 1 acceptance (demo via MCP `lsp()` tool)

## Requirements
R1 and R2 from parent epic pyr-otr.

## Success Criteria
- [x] `textDocument/implementation` registered in capabilities and returns concrete implementations of Protocols/ABCs
- [x] `textDocument/implementation` works on method names (returns overriding methods in subclasses)
- [x] `workspace/symbol` with empty query returns symbols from user code files
- [x] Non-empty workspace/symbol queries still filter correctly
- [x] Fourslash tests for both features
- [x] Full test suite passes
- [ ] Plugin installed with MCP adapter bridging to dev-built Pyright
- [ ] MCP `lsp()` tool operational — agents can hit goToImplementation + workspaceSymbol through it
- [ ] Demo: features work live via MCP `lsp()` tool

## Anti-Patterns
- Don't return goToDefinition results for goToImplementation — they answer different questions. REASON: definition finds where something is declared; implementation finds concrete classes that fulfill a contract.
- Don't limit workspaceSymbol to open files — it must search the entire program's user code. REASON: agents query cold, never "open" files.

## Key Considerations
- goToImplementation on a non-abstract class or a function should return empty or fall back gracefully — don't error.
- workspaceSymbol on a large workspace could be slow on empty query. This is acceptable — vtsls does it, and the client can paginate.

## Acceptance Requirements
See pyr-kwu for demo details. All demos go through the MCP `lsp()` tool.
