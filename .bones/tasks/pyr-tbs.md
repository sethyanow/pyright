---
id: pyr-tbs
title: Fix ImplementationProvider false positives on large workspaces
status: closed
type: bug
priority: 1
owner: Seth
parent: pyr-lo0
---






## Context

`ImplementationProvider._findSubclassLocations` at `definitionProvider.ts:468` calls `derivesFromClassRecursive(classTypeResult.classType, targetClass, /* ignoreUnknown */ false)`. The third argument `ignoreUnknown: false` causes `derivesFromClassRecursive` to conservatively return `true` for any class with `Any` or `Unknown` in its MRO (typeUtils.ts:2226-2228). Typeshed stubs contain many classes that inherit from `Any` (e.g., `NonCallableMock(Base, Any)` in mock.pyi, `SilentReporter(_Reporter)` where `_Reporter: TypeAlias = Any` in check.pyi).

**Root cause:** `ignoreUnknown: false` in three call sites:
1. `_collectSubclassesFromStatements` line 468 — class subclass search
2. `_collectMethodOverridesFromStatements` line 509 — method override search

On the test fixture (small workspace), this works because no classes have `Any` in their MRO. On the full repo workspace (288 results), typeshed stubs and third-party stubs with `Any` base classes all match conservatively.

**Fix:** Change `ignoreUnknown` to `true` at both call sites. For goToImplementation, we want definite subclasses — speculative matches through `Any` are noise.

**Repro:** `node packages/pyright-mcp/dist/lsp-client.js textDocument/implementation '{"textDocument":{"uri":"file:///Volumes/code/pyright/packages/pyright-mcp/src/tests/fixtures/sample.py"},"position":{"line":3,"character":6}}'` from repo root. Returns 288 results; should return 2.

## Requirements

R1. `textDocument/implementation` on `Greeter(ABC)` returns only `EnglishGreeter` and `SpanishGreeter` — not every class with `Any` in its MRO.

## Implementation

1. In `definitionProvider.ts`, change `ignoreUnknown` from `false` to `true` in both `derivesFromClassRecursive` calls (lines 468 and 509).

## Success Criteria

- [x] Regression test: fourslash test with a multi-file workspace where an unrelated class has `Any` in its MRO — only the target's actual subclasses returned
- [x] Existing implementation fourslash tests still pass
- [x] CLI repro against full repo workspace returns only the 2 fixture subclasses

## Anti-Patterns

- Don't add additional filtering logic when the existing function already has the right parameter. The `ignoreUnknown` flag exists precisely for this use case.
- Don't filter by file path or source type. The subclass check itself should be correct regardless of where the class is defined.

## Key Considerations

- The `isSameGenericClass` guard (line 467/508) prevents matching the target class itself — unaffected by this change.
- `ignoreUnknown: true` means classes with genuinely unknown base classes (rare in practice for goToImplementation targets) won't appear. This is the right tradeoff — false negatives on unknowns are better than 286 false positives.

## Failure Catalog

**Dependency Treachery: `derivesFromClassRecursive` with `ignoreUnknown: true`**
- Assumption: Changing `ignoreUnknown` to `true` only suppresses false positives from `Any`/`Unknown` base classes
- Betrayal: A legitimate subclass whose MRO passes through a class with an `Unknown` base (partial type stub) would be silently dropped
- Consequence: False negative — a real implementation disappears from goToImplementation results
- Mitigation: Acceptable tradeoff. goToImplementation targets are user-defined classes with complete type info. The scenario (user class → intermediate with unknown base → target) is structurally unlikely. Existing fourslash tests verify real subclass chains still work.

**Input Hostility: Test fixture design**
- Assumption: A fourslash file with `class Decoy(Any): ...` triggers the bug path
- Betrayal: `Any` might not resolve in the fourslash virtual filesystem the same way as in real analysis, making the test pass trivially
- Consequence: False green — test doesn't catch regressions
- Mitigation: TDD RED step must confirm the test FAILS before the fix. If it passes, the fixture doesn't reproduce the bug and needs adjustment.
