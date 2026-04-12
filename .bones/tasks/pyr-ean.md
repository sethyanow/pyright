---
id: pyr-ean
title: BFS string pre-filter for implementation/subtype scans
status: closed
type: bug
priority: 1
owner: Seth
---





## Requirements

1. `_findSubclassLocations` must not bind files that cannot contain subclasses of the target
2. `_findMethodOverrideLocations` must use the same optimization
3. `TypeHierarchyProvider.getSubtypes` must use the same optimization
4. Transitive inheritance must be discovered (BFS on discovered class names)
5. No behavior change — all subclasses still found, including transitive ones

## Context

### The Bug

`ImplementationProvider._findSubclassLocations` (definitionProvider.ts:389-417) iterates all source files and calls `getParseResults()` on each. This triggers `_bindFile()` for every user-code file. With 1,284 Python test samples in the workspace, binding all on cold cache exceeds 30s — the MCP server's timeout.

Same pattern in `_findMethodOverrideLocations` (419-452) and `TypeHierarchyProvider.getSubtypes` (149-172).

### The Fix

Use `sourceFileInfo.contents` (reads file text WITHOUT binding) to string-filter before `getParseResults()`. This is the same pattern `ReferencesProvider` uses (line 255-256).

For transitive inheritance, use BFS:
1. Start with `classNames = {targetClass.name}`
2. String-filter files for any name in set, bind matches
3. Discover subclasses, add their names to set
4. Repeat until no new names

### Verified Facts

- `getParseResults()` calls `getBoundSourceFileInfo()` which calls `_bindFile()` (program.ts:664)
- `sourceFileInfo.contents` returns `sourceFile.getFileContent()` which reads buffer/cache/disk only (sourceFileInfo.ts:70-72, sourceFile.ts:537-565)
- `derivesFromClassRecursive` handles type-level transitivity (typeUtils.ts:2216-2233)
- BFS is needed at string-filter level: file with `class GoldenRetriever(Dog)` doesn't mention "Animal"

## Implementation

1. Extract shared `_stringMatchesAnyClassName(contents: string, classNames: Set<string>): boolean` helper
2. Add BFS loop structure to `_findSubclassLocations`:
   - Track `processedFiles: Set<string>` and `classNamesToSearch: Set<string>`
   - String-filter before `getParseResults()`
   - Collect discovered subclass names, add to search set
   - Repeat until no new names
3. Apply same pattern to `_findMethodOverrideLocations`
4. Apply same pattern to `TypeHierarchyProvider.getSubtypes`

## Success Criteria

- [x] Fourslash test: transitive subclass discovered across 3 files (Animal → Dog → GoldenRetriever)
      → codeLens.transitiveSubclass.fourslash.ts
- [x] Fourslash test: implementation count correct for class with no subclasses
      → codeLens.adversarial.noSubclasses.fourslash.ts
- [x] Fourslash test: method override found through transitive inheritance
      → findImplementations.transitiveMethod.fourslash.ts
- [x] TypeHierarchy fourslash test: subtypes found transitively
      → typeHierarchy.transitiveSubtypes.fourslash.ts
- [x] All existing codeLens/implementation/typeHierarchy tests still pass
      → 2387 tests passed
- [x] `npm run typecheck` clean
      → verified

## Log

- [2026-04-12T08:53:13Z] [Seth] Implementation complete. BFS string pre-filter added to _findSubclassLocations, _findMethodOverrideLocations, and TypeHierarchyProvider.getSubtypes. All success criteria verified. Adversarial test battery passed (deep chain, diamond, substring collision, empty, unicode). 2387 tests pass, typecheck clean.
