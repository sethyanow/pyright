---
id: pyr-oaf
title: 'Semantic tokens: classify module references as namespace'
status: closed
type: bug
priority: 1
owner: Seth
parent: pyr-mge
---






## Context

`_classifyName` in `semanticTokensProvider.ts:138` maps `DeclarationType` to semantic token types. Module references (e.g. `os` in `os.path.join`) resolve through `DeclarationType.Alias`, but the alias target is a module — and no `DeclarationType` corresponds to modules. The name falls through to `default: return undefined`, emitting no token.

`namespace` is in the token legend (line 32) but never returned by any code path.

## Requirements

R1. Module references at usage sites (not import statements) must be classified as `SemanticTokenTypes.namespace`.
R2. After alias resolution, check if the resolved type is a `ModuleType` (via `isModule()`) and return `namespace`.
R3. Import names remain excluded (existing `_isImportName` guard).

## Implementation

1. In `_classifyName` (`semanticTokensProvider.ts`), after alias resolution succeeds (line 149-155), check if the resolved declaration's type evaluates to a module. If so, return `SemanticTokenTypes.namespace` before the main switch.
2. Import `isModule` from `../analyzer/types`.
3. Update `semanticTokens.basic.fourslash.ts` or add a new fourslash test verifying `os` in `os.path.join` is classified as `namespace`.

## Success Criteria

- [x] `os` in `os.path.join("a", "b")` classified as `namespace` token
- [x] Import names (`import os`) still excluded from tokens
- [x] Fourslash test covering module-as-namespace classification
- [x] Existing semantic token tests still pass
- [x] `npm run typecheck` clean
