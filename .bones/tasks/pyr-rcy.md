---
id: pyr-rcy
title: 'workspaceSymbol: return results on empty query'
status: closed
type: bug
priority: 1
parent: pyr-lo0
---






## Context

`workspaceSymbolProvider.ts:_reportSymbolsForProgram` bails on empty query (`if (!this._query) return;`). Every other major language server (vtsls, rust-analyzer, clangd) returns all symbols on empty query. This breaks any client that sends workspace/symbol without typed text — including Claude Code's LSP tool.

## Fix

Remove the empty-query guard in `_reportSymbolsForProgram` (line 132-134 of `workspaceSymbolProvider.ts`). The `isPatternInSymbol` call on line 101 already returns `true` for empty pattern (verified in stringUtils.test.ts line 13), so the filtering logic handles it correctly without the guard.

## Implementation

1. Write test first: `packages/pyright-internal/src/tests/workspaceSymbol.test.ts`
   - Unit test constructing `WorkspaceSymbolProvider` with a mock `Workspace` (follow pattern from `testLanguageService.ts:95-111`)
   - Test: empty query returns non-empty symbol list from user code
   - Test: empty query does NOT return typeshed/third-party symbols (`isUserCode` filter still active)
   - Test: non-empty query still filters correctly (regression)
   - No existing fourslash infra for workspace symbols — unit test is the right approach

2. Remove empty-query guard: `packages/pyright-internal/src/languageService/workspaceSymbolProvider.ts:131-135`
   - Delete the 3-line block: comment + `if (!this._query) return;`

3. Verify: `cd packages/pyright-internal && npx jest workspaceSymbol --forceExit`
4. Verify: `npm run typecheck`

## Success Criteria

- [x] Empty-query workspace/symbol returns symbols from user code files
- [x] Empty-query workspace/symbol does NOT return typeshed symbols (isUserCode filter preserved)
- [x] Non-empty queries still filter correctly
- [x] Unit test in workspaceSymbol.test.ts covers all three cases
- [x] Full test suite passes

## Key Considerations (Failure Catalog)

**Resource Exhaustion: Large workspace on empty query**
- Assumption: Iterating all user code files and indexing symbols is bounded in time/memory
- Betrayal: Workspace with thousands of files — each gets parsed and symbol-indexed
- Consequence: Slow response, memory spike
- Mitigation: `handleMemoryHighUsage()` (line 150) already manages memory pressure. Same code path non-empty queries use. Parent epic decision: acceptable, client can paginate.

**Dependency Treachery: Mock workspace in test**
- Assumption: Test can construct a Workspace with a ProgramView containing user code files
- Betrayal: `WorkspaceSymbolProvider` calls `workspace.service.run()` needing real `AnalyzerService`. If `isInitialized.resolved()` isn't set up, provider silently skips workspace (line 44).
- Consequence: Test passes with empty results — asserts nothing
- Mitigation: Test MUST assert result count > 0 for empty-query case. A test that asserts "no crash" is worthless.

## Edge Cases

- **Large workspace result set:** Parent epic (pyr-otr) decided this is acceptable — "vtsls does it, and the client can paginate." The `handleMemoryHighUsage()` call on line 150 already handles memory pressure during iteration.
- **disableWorkspaceSymbol flag:** Already checked at line 40 before reaching the guard — no interaction.
- **undefined query:** Not possible — LSP spec requires `query: string` (verified in protocol.d.ts). The protocol layer validates before it reaches the provider.

## Anti-Patterns

- Don't add a result limit or pagination logic — that's a client concern, not the provider's. The guard removal is the complete fix.

## Log

- [2026-04-05T22:53:22Z] [Seth] Closed. Removed 3-line empty-query guard. Added 6 tests (3 core + 3 adversarial). Full suite 2347/2347 green. Typecheck clean.
