---
id: pyr-kqo
title: Extract TypeEvaluatorState from closure internals
status: open
type: task
priority: 2
depends_on: [pyr-wru]
parent: pyr-a56
---

## Context

After the TypeRegistry extraction (pyr-wru), 17 mutable closure variables remain in `createTypeEvaluator()`. Only ~30 infrastructure functions directly touch them — the remaining ~170 functions access state only transitively. This task extracts those variables and infrastructure functions into a `TypeEvaluatorState` class, breaking the closure's gravity well and enabling all subsequent domain extractions.

The state variables cluster into coupled groups (e.g., `writeTypeCache` touches `typeCache`, `returnTypeInferenceTypeCache`, `incompleteGenCount`, and `speculativeTypeTracker` in one operation). `speculativeTypeTracker` is already a class instance. Methods on the state object is the right call — this state is internally coupled and the operations are behavioral (enter/exit patterns, conditional cache routing).

**Blocked by:** pyr-wru (registry must be extracted first)
**Unlocks:** pyr-5hl through pyr-8b1 (all domain extractions depend on state being a passable object)

## Requirements

1. Create `typeEvaluatorState.ts` in `packages/pyright-internal/src/analyzer/`
2. Define `TypeEvaluatorState` class holding all 17 mutable variables as instance fields
3. Move ~30 infrastructure functions as methods on the class — same names, same logic, `this.` instead of closure access
4. Create the state instance inside `createTypeEvaluator()`, replace all direct variable access and infrastructure function calls with `state.method()` / `state.field`
5. Export `TypeEvaluatorState` type so domain modules extracted later can receive it as a parameter
6. All existing tests pass — zero behavior change

## Implementation

### Step 1: Baseline test run
```bash
cd packages/pyright-internal && bun run test:norebuild > /tmp/pyright-baseline-state.txt 2>&1
```

### Step 2: Create `typeEvaluatorState.ts` with the class
Create `packages/pyright-internal/src/analyzer/typeEvaluatorState.ts`.

**Instance fields** (moved from closure variables, lines 647-664):
- `symbolResolutionStack: SymbolResolutionStackEntry[]` (line 647)
- `speculativeTypeTracker: SpeculativeTypeTracker` (line 648)
- `suppressedNodeStack: SuppressedNodeStackEntry[]` (line 649)
- `assignClassToSelfStack: AssignClassToSelfInfo[]` (line 650)
- `functionRecursionMap: Map<number, FunctionRecursionInfo[]>` (line 652)
- `codeFlowAnalyzerCache: Map<number, CodeFlowAnalyzerCacheEntry[]>` (line 653)
- `typeCache: Map<number, TypeCacheEntry>` (line 654)
- `effectiveTypeCache: Map<number, Map<string, EffectiveTypeResult>>` (line 655)
- `expectedTypeCache: Map<number, Type>` (line 656)
- `asymmetricAccessorAssignmentCache: Set<number>` (line 657)
- `deferredClassCompletions: DeferredClassCompletion[]` (line 658)
- `cancellationToken: CancellationToken | undefined` (line 659)
- `printExpressionSpaceCount: number` (line 660)
- `incompleteGenCount: number` (line 661)
- `returnTypeInferenceContextStack: ReturnTypeInferenceContext[]` (line 662)
- `returnTypeInferenceTypeCache: Map<number, TypeCacheEntry> | undefined` (line 663)
- `signatureTrackerStack: SignatureTrackerStackEntry[]` (line 664)

**Methods to move** (infrastructure functions that directly touch state):

Cache management:
- `readTypeCacheEntry(node)` — line 716
- `isTypeCached(node)` — line 726
- `readTypeCache(node, flags)` — line 735
- `writeTypeCache(node, typeResult, flags, inferenceContext?, allowSpeculativeCaching?)` — line 766
- `getTypeCacheEntryCount()` — line 697
- `disposeEvaluator()` — line 707
- `isNodeInReturnTypeInferenceContext(node)` — find via LSP, checks returnTypeInferenceContextStack

Symbol resolution:
- `getIndexOfSymbolResolution(symbol, declaration)` — line 853
- `pushSymbolResolution(symbol, declaration)` — line 859
- `popSymbolResolution(symbol)` — line 877
- `setSymbolResolutionPartialType(symbol, declaration, type)` — line 883
- `getSymbolResolutionPartialType(symbol, declaration)` — line 890

Speculative mode:
- `useSpeculativeMode(node, callback, options)` — line 22106
- `disableSpeculativeMode(callback)` — line 22129
- `isSpeculativeModeInUse(node)` — find via LSP

Diagnostic suppression:
- `suppressDiagnostics(callback)` — find via LSP, uses suppressedNodeStack
- `canSkipDiagnosticForNode(node)` — line 3562

Signature tracking:
- `getSignatureTrackerForNode(node)` — line 22048
- `useSignatureTracker(node, callback)` — find via LSP, uses signatureTrackerStack
- `ensureSignatureIsUnique(type, node)` — line 22089

Cancellation:
- `runWithCancellationToken(token, callback)` — line 667
- `checkForCancellation()` — line 691

Return type inference context:
- `getCodeFlowAnalyzerForReturnTypeInferenceContext()` — line 846
- Functions that push/pop returnTypeInferenceContextStack — find via LSP

Misc:
- `getPrintExpressionTypesSpaces()` — line 28742

### Step 3: Wire into `createTypeEvaluator()`
In `typeEvaluator.ts`:
- Remove all 17 variable declarations (lines 647-664)
- Add `const state = new TypeEvaluatorState(evaluatorOptions)` at the top of the closure
- Constructor takes `evaluatorOptions` for config that methods need (e.g., `verifyTypeCacheEvaluatorFlags`)
- Replace bare function calls with `state.method()` calls throughout

### Step 4: Update the evaluator interface object
The `evaluatorInterface` object (line 28764) exposes several infrastructure methods. Update references:
- `runWithCancellationToken` → `state.runWithCancellationToken.bind(state)` or a thin wrapper
- `checkForCancellation` → `state.checkForCancellation.bind(state)`
- `disposeEvaluator` → `state.disposeEvaluator.bind(state)`
- `useSpeculativeMode` → `state.useSpeculativeMode.bind(state)`
- `isSpeculativeModeInUse` → `state.isSpeculativeModeInUse.bind(state)`
- `setTypeResultForNode` → may need a wrapper that calls `state.writeTypeCache`
- `getTypeCacheEntryCount` → `state.getTypeCacheEntryCount.bind(state)`

### Step 5: Handle methods that also call non-state functions
Some infrastructure functions call domain functions (e.g., `writeTypeCache` calls `isTypeSame`). These external dependencies should be passed to the constructor or individual methods as callbacks rather than pulling the entire evaluator in. Keep the dependency surface minimal.

### Step 6: Run tests
```bash
cd packages/pyright-internal && bun run test:norebuild > /tmp/pyright-after-state.txt 2>&1
diff /tmp/pyright-baseline-state.txt /tmp/pyright-after-state.txt
```

### Step 7: Run linter
```bash
cd /Volumes/code/pyright && bun run check
```

## Success Criteria

- [ ] `typeEvaluatorState.ts` exists with `TypeEvaluatorState` class
- [ ] All 17 mutable closure variables removed from `createTypeEvaluator()` body
- [ ] All ~30 infrastructure functions moved to state class methods
- [ ] `createTypeEvaluator()` creates `TypeEvaluatorState` instance
- [ ] Full test suite passes
- [ ] Linter passes

## Anti-Patterns

- **Don't rename the methods.** `pushSymbolResolution` stays `pushSymbolResolution`, not `pushResolution` or `addSymbolToStack`. REASON: this is code motion, not API design. Same names = reviewable diffs.
- **Don't make the state class generic or abstract.** One concrete class, no interfaces, no generics. REASON: there's exactly one implementation and no need for polymorphism.
- **Don't pull domain logic into the state class.** If a function touches state AND does domain logic (e.g., a cache function that also resolves types), split it — state method handles the cache operation, domain function calls the method and does the rest. REASON: the state class should be boring plumbing.
- **Don't use property getters/setters for fields.** Direct field access is fine — pyright's style is explicit, not encapsulated. REASON: this is a performance-sensitive codebase; getter overhead on hot paths matters.
