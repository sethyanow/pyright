---
id: pyr-rcy
title: 'workspaceSymbol: return results on empty query'
status: open
type: bug
priority: 1
parent: pyr-lo0
---



## Context

`workspaceSymbolProvider.ts:_reportSymbolsForProgram` bails on empty query (`if (!this._query) return;`). Every other major language server (vtsls, rust-analyzer, clangd) returns all symbols on empty query. This breaks any client that sends workspace/symbol without typed text — including Claude Code's LSP tool.

## Fix

Remove the empty-query guard in `_reportSymbolsForProgram` (line 132-134 of `workspaceSymbolProvider.ts`). The `isPatternInSymbol` call on line 101 already returns `true` for empty pattern (verified in stringUtils.test.ts line 13), so the filtering logic handles it correctly without the guard.

## Success Criteria

- [ ] Empty-query workspace/symbol returns symbols from user code files
- [ ] Non-empty queries still filter correctly
- [ ] Tests pass
