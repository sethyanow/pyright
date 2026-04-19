---
id: pyr-x2v
title: Verify codeLens/resolve performance on cold cache with large workspace
status: open
type: task
priority: 2
---


## Context

Unfinished debt from the 2026-04-12 handoff. Phase 5 (pyr-yh8) shipped the codeLens provider but closed with a known issue: `codeLens/resolve` with `kind: "implementations"` was timing out on cold cache when the workspace had many Python files. Prior session measured `_findSubclassLocations` binding 1,284 test-sample Python files in >30s, exceeding the hardcoded MCP timeout.

An import-graph pre-filter was attempted and reverted (diagnosis: the bottleneck is `_bindFile` itself, which must run before the import graph exists — chicken-and-egg).

A string-BFS approach was proposed: use `sourceFileInfo.contents` (available without binding, per `ReferencesProvider`'s existing pattern) to pre-filter files by name before calling `getParseResults`. That approach was never implemented or measured.

I closed pyr-noe and marked Phase 5.5b Task 1 done without actually re-running the cold-cache scenario that motivated the concern in the first place. I told the user "presumably addressed since pyr-yh8 closed." That's a research debt, not a verified state.

## Requirements

R1. Reproduce the original failure: cold-cache codeLens resolve on a workspace with 1000+ Python files (the pyright-internal test samples are the canonical reproducer).
R2. Measure the actual timing — is it still >30s? Is the implementation count resolve the slow path, or is it reference count? Both?
R3. If still slow: implement and measure the string-BFS pre-filter in `_findSubclassLocations` and `_findMethodOverrideLocations` (`definitionProvider.ts:389-452`) and the identical pattern in `TypeHierarchyProvider.getSubtypes` (`typeHierarchyProvider.ts:149-169`).
R4. Preserve transitive subclass discovery — the 2026-04-12 handoff specifically flagged `codeLens.transitiveSubclass.fourslash.ts` as the regression test (reverted with its commit; recreate if useful).
R5. Confirm end-to-end: hook (pyr-noe) triggers resolve on a cold workspace; resolves within the hook's 10s budget.

## Success Criteria

- [ ] Reproduction captured: exact setup (workspace path, file count, cold-state trigger) + baseline timing for `codeLens/resolve` on `implementations` AND `references` kinds
- [ ] If slow: string-BFS pre-filter implemented in `_findSubclassLocations`, `_findMethodOverrideLocations`, and `TypeHierarchyProvider.getSubtypes`
- [ ] `codeLens.transitiveSubclass.fourslash.ts` (or equivalent) committed as regression test for transitive inheritance across 3 files (base → middle → leaf without direct base import)
- [ ] Measured post-fix timing: resolve completes well within the hook's 10s budget on the same cold repro
- [ ] `cd packages/pyright-internal && npm run test:norebuild` — all pass
- [ ] End-to-end: trigger pyr-noe's hook against a cold workspace with 1000+ Python files; enrichment block appears within 10s

## Anti-Patterns

- **Don't declare victory from test-pass alone.** Fourslash tests run on tiny virtual workspaces that are always hot. The failure mode is cold-cache on large real workspaces.
- **Don't re-attempt the import-graph pre-filter.** The handoff already established that approach is chicken-and-egg. The string-BFS on `sourceFileInfo.contents` is the right tool — it reads disk without parsing/binding.
- **Don't invent a numeric target.** "<10s on 1284 files" isn't a design spec; it's a consequence of the hook timeout. Success is "hook timeout no longer trips" on the reproduction workload.

## Key Considerations

- **`sourceFileInfo.contents` availability:** per the handoff, `getFileContent()` in `sourceFile.ts` reads from (1) open file buffer, (2) cached parsed content, (3) filesystem — no parsing or binding. Confirmed the pattern works for `ReferencesProvider` at `referencesProvider.ts:256`.
- **BFS for transitive subclasses:** finding `Dog` as a subclass adds `"Dog"` to the search queue; next pass finds files containing `"Dog"`. Without BFS, a `GoldenRetriever(Dog)` in a file that doesn't mention `Animal` gets missed when searching for `Animal`'s impls.
- **Cold-cache reproduction:** delete Pyright's in-memory cache (restart proxy), or simply use a fresh `PYRIGHT_PROXY_STATE_DIR`. First request after spawn is the cold path.
- **Hook-layer mitigation already exists:** pyr-noe's socket-lsp-client has a 7s internal timeout that returns `[]` rather than rejecting. So this bug degrades the UX (no enrichment on cold cache) but doesn't break Read. Still: silent degradation is worse than no feature.

## Log

(None yet.)
- [2026-04-19T01:37:57Z] [Seth] Re-opened as its own task after pyr-noe checkpoint review. Pyr-yh8 (Phase 5) closed with the handoff's cold-cache concern unverified. pyr-noe's 7s hook timeout masks the failure as silent degradation. String-BFS pre-filter on sourceFileInfo.contents (per ReferencesProvider pattern) is the proposed fix but was never implemented.
