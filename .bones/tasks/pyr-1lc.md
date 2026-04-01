---
id: pyr-1lc
title: Extract Symbol and Declaration Resolution functions
status: open
type: task
priority: 2
depends_on: [pyr-yay]
parent: pyr-a56
---

## Context

Symbol and declaration resolution functions determine the declared and effective types of symbols (variables, functions, classes, parameters) from their declarations. These are the bridge between the binder's symbol tables and the type evaluator's type inference — they look up declarations, resolve aliases, handle forward references, and compute effective types considering multiple assignments and type narrowing.

Primary closure coupling was `symbolResolutionStack` (8 refs) — now on `TypeEvaluatorState`. These functions primarily call evaluator interface methods and each other.

**Blocked by:** pyr-yay (Type Assignment extracted)
**Unlocks:** pyr-p1w (Member Access extraction)

## Requirements

1. Create `symbolResolution.ts` in `packages/pyright-internal/src/analyzer/`
2. Move symbol/declaration resolution functions from `typeEvaluator.ts`
3. Each function takes `TypeEvaluator` + `TypeRegistry` + `TypeEvaluatorState` as needed
4. Update `typeEvaluator.ts` to import and delegate
5. All existing tests pass — zero behavior change

## Implementation

### Step 1: Baseline test run
```bash
cd packages/pyright-internal && bun run test:norebuild > /tmp/pyright-baseline-sym.txt 2>&1
```

### Step 2: Inventory the functions to extract
Declared type resolution:
- `getDeclaredTypeOfSymbol` — line 23472 (exposed on interface)
- `getDeclaredTypeForExpression` — line 2780 (exposed on interface)
- `getDeclaredReturnType` — line 23918 (exposed on interface)
- `getInferredTypeOfDeclaration` — line 22802 (exposed on interface)
- `getTypeForDeclaration` — line 22451 (exposed on interface)

Effective type:
- `getEffectiveTypeOfSymbol` — line 23120 (exposed on interface)
- `getEffectiveTypeOfSymbolForUsage` — line 23128 (exposed on interface)
- `getEffectiveReturnType` — line 23589
- `getEffectiveReturnTypeResult` — line 23601

Declaration info:
- `getDeclInfoForNameNode` — line 22230 (exposed on interface)
- `getDeclInfoForStringNode` — line 22186 (exposed on interface)
- `getDeclarationFromKeywordParam` — line 22150

Alias resolution:
- `resolveAliasDeclaration` — exposed on interface
- `resolveAliasDeclarationWithInfo` — exposed on interface
- `getAliasedSymbolTypeForName` — line 20442
- `getAliasFromImport` — line 22218

Return type inference:
- `getInferredReturnType` — line 23593 (exposed on interface)
- `_getInferredReturnTypeResult` — line 23610 (large function, ~200 lines)
- `inferReturnTypeIfNecessary` — exposed on interface
- `inferVarianceForClass` — exposed on interface

Symbol lookup:
- `lookUpSymbolRecursive` — exposed on interface
- `isTypeSubsumedByOtherType` — exposed on interface
- `getAbstractSymbols` — line 28212 (exposed on interface)
- `getAbstractSymbolInfo` — line 10269

Misc:
- `isFinalVariable` — exposed on interface
- `isFinalVariableDeclaration` — exposed on interface
- `isExplicitTypeAliasDeclaration` — exposed on interface
- `getCodeFlowTypeForCapturedVariable` — line 5130

### Step 3: Create `symbolResolution.ts`
Create `packages/pyright-internal/src/analyzer/symbolResolution.ts`:
- Export each function with dependency params
- Many of these are exposed on the `TypeEvaluator` interface — they become wrappers in the evaluator object
- `_getInferredReturnTypeResult` is the largest function (~200 lines) — it uses `returnTypeInferenceContextStack` and `returnTypeInferenceTypeCache` heavily via state methods

### Step 4: Verify `_getInferredReturnTypeResult` extractability
This function (line 23610) pushes/pops the return type inference context and creates temporary caches. After pyr-kqo, these operations are state methods. Verify:
- All state access goes through `state.method()` (not direct field access)
- Callbacks passed to speculative mode work correctly when the function is outside the closure

### Step 5: Update `typeEvaluator.ts`
- Remove moved functions
- Import from `symbolResolution.ts`
- Update evaluator interface — most of these functions are already on the interface, so many entries become wrappers

### Step 6: Run tests
```bash
cd packages/pyright-internal && bun run test:norebuild > /tmp/pyright-after-sym.txt 2>&1
diff /tmp/pyright-baseline-sym.txt /tmp/pyright-after-sym.txt
```

### Step 7: Run linter
```bash
cd /Volumes/code/pyright && bun run check
```

## Success Criteria

- [ ] `symbolResolution.ts` exists with all symbol/declaration resolution functions
- [ ] `typeEvaluator.ts` reduced by ~2000 lines
- [ ] Full test suite passes
- [ ] Linter passes

## Anti-Patterns

- **Don't separate `getEffectiveTypeOfSymbol` from `getDeclaredTypeOfSymbol`.** They're tightly coupled — effective type depends on declared type. REASON: these form a cohesive resolution pipeline.
- **Don't extract `_getInferredReturnTypeResult` if it creates deep re-entrant evaluation.** If this function triggers full expression evaluation recursively (not just via interface calls), it may need to stay in the closure. Verify and document. REASON: circular runtime dependencies are worse than a slightly larger file.
- **Don't over-extract.** If a symbol resolution function is called only from expression evaluation orchestration (e.g., only from `evaluateTypesForStatement`), consider leaving it in place. The goal is ~2000 lines moved, not zero symbol-related code in the closure. REASON: some functions are "resolution" by name but "orchestration" by nature.
