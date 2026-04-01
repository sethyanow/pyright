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

After the TypeRegistry extraction (pyr-wru), 17 mutable closure variables remain in `createTypeEvaluator()` (plus 2 registry-related variables from pyr-wru: `registry` and `registryInitialized`). Only ~29 infrastructure functions directly touch the 17 state variables — the remaining ~170 functions access state only transitively. This task extracts those 17 variables and their infrastructure functions into a `TypeEvaluatorState` class, breaking the closure's gravity well and enabling all subsequent domain extractions.

**Registry variables stay in the closure.** `registry` and `registryInitialized`, plus `ensureRegistryInitialized`, remain as closure variables. They're TypeRegistry concerns (pyr-wru), not general state. After this task, the closure retains only these 2 mutable variables plus the registry initialization function. Domain modules receive `TypeEvaluatorState` + `TypeRegistry` as separate params (per epic design).

The state variables cluster into coupled groups (e.g., `writeTypeCache` touches `typeCache`, `returnTypeInferenceTypeCache`, `incompleteGenCount`, and `speculativeTypeTracker` in one operation). `speculativeTypeTracker` is already a class instance. Methods on the state object is the right call — this state is internally coupled and the operations are behavioral (enter/exit patterns, conditional cache routing).

**Blocked by:** pyr-wru (registry must be extracted first)
**Unlocks:** pyr-5hl through pyr-8b1 (all domain extractions depend on state being a passable object)

## Requirements

1. Create `typeEvaluatorState.ts` in `packages/pyright-internal/src/analyzer/`
2. Define `TypeEvaluatorState` class holding all 17 mutable variables as instance fields
3. Move ~29 infrastructure functions as methods on the class — same names, same logic, `this.` instead of closure access
4. Create the state instance inside `createTypeEvaluator()`, replace all direct variable access and infrastructure function calls with `state.method()` / `state.field`
5. Export `TypeEvaluatorState` type so domain modules extracted later can receive it as a parameter
6. All existing tests pass — zero behavior change

## Implementation

### Step 1: Baseline test run
```bash
cd packages/pyright-internal && bun run test > /tmp/pyright-baseline-state.txt 2>&1
```

### Step 2: Create `typeEvaluatorState.ts` with the class
Create `packages/pyright-internal/src/analyzer/typeEvaluatorState.ts`.

**Instance fields** (moved from closure variables — use LSP `documentSymbol` on `createTypeEvaluator` to find current positions):
- `symbolResolutionStack: SymbolResolutionStackEntry[]`
- `speculativeTypeTracker: SpeculativeTypeTracker`
- `suppressedNodeStack: SuppressedNodeStackEntry[]`
- `assignClassToSelfStack: AssignClassToSelfInfo[]`
- `functionRecursionMap: Map<number, FunctionRecursionInfo[]>`
- `codeFlowAnalyzerCache: Map<number, CodeFlowAnalyzerCacheEntry[]>`
- `typeCache: Map<number, TypeCacheEntry>`
- `effectiveTypeCache: Map<number, Map<string, EffectiveTypeResult>>`
- `expectedTypeCache: Map<number, Type>`
- `asymmetricAccessorAssignmentCache: Set<number>`
- `deferredClassCompletions: DeferredClassCompletion[]`
- `cancellationToken: CancellationToken | undefined`
- `printExpressionSpaceCount: number`
- `incompleteGenCount: number`
- `returnTypeInferenceContextStack: ReturnTypeInferenceContext[]`
- `returnTypeInferenceTypeCache: Map<number, TypeCacheEntry> | undefined`
- `signatureTrackerStack: SignatureTrackerStackEntry[]`

**NOT moved** (stay as closure variables — TypeRegistry concerns from pyr-wru):
- `registry: TypeRegistry`
- `registryInitialized: boolean`

**Methods to move** (29 infrastructure functions that directly touch state):

Cache management (7):
- `readTypeCacheEntry(node)` — reads typeCache and returnTypeInferenceTypeCache
- `isTypeCached(node)` — calls readTypeCacheEntry, checks incompleteGenCount
- `readTypeCache(node, flags)` — calls readTypeCacheEntry, references `evaluatorOptions.verifyTypeCacheEvaluatorFlags` and module-level debug constant. Constructor needs `evaluatorOptions`.
- `writeTypeCache(node, typeResult, flags, inferenceContext?, allowSpeculativeCaching?)` — touches typeCache, returnTypeInferenceTypeCache, incompleteGenCount, speculativeTypeTracker. Calls `isTypeSame` (pure utility from `typeUtils.ts` — import directly).
- `getTypeCacheEntryCount()` — reads typeCache.size
- `disposeEvaluator()` — resets functionRecursionMap, codeFlowAnalyzerCache, typeCache, effectiveTypeCache, expectedTypeCache, asymmetricAccessorAssignmentCache
- `isNodeInReturnTypeInferenceContext(node)` — checks returnTypeInferenceContextStack

Symbol resolution (5):
- `getIndexOfSymbolResolution(symbol, declaration)`
- `pushSymbolResolution(symbol, declaration)`
- `popSymbolResolution(symbol)`
- `setSymbolResolutionPartialType(symbol, declaration, type)`
- `getSymbolResolutionPartialType(symbol, declaration)`

Speculative mode (3):
- `useSpeculativeMode(node, callback, options)` — delegates to speculativeTypeTracker
- `disableSpeculativeMode(callback)` — delegates to speculativeTypeTracker
- `isSpeculativeModeInUse(node)` — delegates to speculativeTypeTracker

Diagnostic suppression (4):
- `suppressDiagnostics(node, callback, diagCallback?)` — pushes/pops suppressedNodeStack
- `isDiagnosticSuppressedForNode(node)` — checks suppressedNodeStack + speculativeTypeTracker
- `canSkipDiagnosticForNode(node)` — checks suppressedNodeStack + speculativeTypeTracker
- `addDiagnosticWithSuppressionCheck(diagLevel, message, node, range?)` — checks suppressedNodeStack, calls `isNodeReachable` (set post-construction), writes to `diagnosticSink` (from node's fileInfo — pure utility access). One external dep, one clean call, no split.

Asymmetric accessor (2):
- `setAsymmetricDescriptorAssignment(node)` — writes asymmetricAccessorAssignmentCache, calls isSpeculativeModeInUse
- `isAsymmetricAccessorAssignment(node)` — reads asymmetricAccessorAssignmentCache

Signature tracking (3):
- `getSignatureTrackerForNode(node)` — reads signatureTrackerStack
- `useSignatureTracker(node, callback)` — pushes/pops signatureTrackerStack
- `ensureSignatureIsUnique(type, node)` — calls getSignatureTrackerForNode

Cancellation (2):
- `runWithCancellationToken(token, callback)` — overloaded (sync + async), sets/restores cancellationToken
- `checkForCancellation()` — reads cancellationToken

Return type inference context (1 — isNodeInReturnTypeInferenceContext already counted above):
- `getCodeFlowAnalyzerForReturnTypeInferenceContext()` — reads returnTypeInferenceContextStack

Misc (1):
- `getPrintExpressionTypesSpaces()` — reads printExpressionSpaceCount

**NOT moved** (stay as closure functions — domain or registry concerns):
- `ensureRegistryInitialized(node)` — registry concern, calls `evaluatorInterface` methods
- `getCodeFlowAnalyzerForNode(node, typeAtStart)` — uses codeFlowAnalyzerCache but also `codeFlowEngine` (created after evaluatorInterface)
- `registerDeferredClassCompletion(classToComplete, dependsUpon)` — domain logic + deferredClassCompletions
- `runDeferredClassCompletions(type)` — domain logic + deferredClassCompletions
- `inferTypeOfSymbolForUsage(symbol, usageNode?, useLastDecl?)` — domain logic + effectiveTypeCache
- Functions using `assignClassToSelfStack` — domain logic
- Functions using `functionRecursionMap` — domain logic

These domain functions access state fields directly via `state.fieldName` instead of through methods.

### Step 3: Wire into `createTypeEvaluator()`
In `typeEvaluator.ts`:
- Remove 17 variable declarations. Leave `registry` and `registryInitialized`.
- Add `const state = new TypeEvaluatorState(evaluatorOptions)` at the top of the closure
- Constructor takes `evaluatorOptions` for config that methods need (e.g., `verifyTypeCacheEvaluatorFlags`)
- Replace bare function calls with `state.method()` calls throughout
- Domain functions that directly access state variables switch to `state.fieldName`

### Step 4: Update the evaluator interface object
The `evaluatorInterface` object exposes several infrastructure methods. Update references:
- `runWithCancellationToken` → `state.runWithCancellationToken.bind(state)` or a thin wrapper
- `checkForCancellation` → `state.checkForCancellation.bind(state)`
- `disposeEvaluator` → `state.disposeEvaluator.bind(state)`
- `useSpeculativeMode` → `state.useSpeculativeMode.bind(state)`
- `isSpeculativeModeInUse` → `state.isSpeculativeModeInUse.bind(state)`
- `suppressDiagnostics` → `state.suppressDiagnostics.bind(state)`
- `setTypeResultForNode` → may need a wrapper that calls `state.writeTypeCache`
- `getTypeCacheEntryCount` → `state.getTypeCacheEntryCount.bind(state)`

Also update `getCodeFlowEngine` call: currently receives bare `speculativeTypeTracker` — change to `state.speculativeTypeTracker`.

### Step 5: Handle methods that also call non-state functions
For pure utility imports (`isTypeSame` from `typeUtils.ts`), import directly in `typeEvaluatorState.ts`. For dependencies on `evaluatorInterface` or `codeFlowEngine` (created after state construction), use one of:
- **Callback injection:** Pass specific functions to methods that need them
- **Post-construction setter:** `state.setExternalDeps(...)` after evaluatorInterface is created
- **Keep in closure:** If the function's dependency on evaluatorInterface is primary, leave it as a closure function that delegates to state methods for the state-access parts

`addDiagnosticWithSuppressionCheck` uses post-construction setter for `isNodeReachable`. The `diagnosticSink` comes from the node's fileInfo (pure utility), not from evaluator state.

### Step 6: Run tests
```bash
cd packages/pyright-internal && bun run test > /tmp/pyright-after-state.txt 2>&1
tail -5 /tmp/pyright-after-state.txt
```
Use `bun run test` (with server rebuild), not `test:norebuild` — structural changes require rebuilding the test server.

### Step 7: Run linter
```bash
cd /Volumes/code/pyright && bun run check
```

## Success Criteria

- [ ] `typeEvaluatorState.ts` exists with `TypeEvaluatorState` class
- [ ] 17 mutable closure variables removed from `createTypeEvaluator()` body (registry + registryInitialized stay)
- [ ] 29 infrastructure functions moved to state class methods (see enumerated list in Step 2)
- [ ] `createTypeEvaluator()` creates `TypeEvaluatorState` instance
- [ ] `evaluatorInterface` object correctly delegates to state methods (Step 4 list)
- [ ] `getCodeFlowEngine` call uses `state.speculativeTypeTracker`
- [ ] Domain functions that access state fields use `state.fieldName` pattern
- [ ] `TypeEvaluatorState` is exported from `typeEvaluatorState.ts`
- [ ] Full test suite passes: `bun run test` (with server rebuild)
- [ ] Linter passes: `bun run check`

## Key Considerations

**Initialization ordering.** The `evaluatorInterface` object is created AFTER all closure functions are defined. In the closure, functions reference `evaluatorInterface` freely because JS closures capture the variable binding (not the value). In a class, the constructor runs immediately — it cannot receive `evaluatorInterface` because it doesn't exist yet. Infrastructure methods that are pure state operations (cache reads/writes, stack push/pop) have no issue. The only state-adjacent function that calls `evaluatorInterface` directly is `addDiagnosticWithSuppressionCheck` — see design discussion below.

**`addDiagnosticWithSuppressionCheck` on state.** Moves to state class. One external dep: `isNodeReachable` — set post-construction. The `diagnosticSink` access comes from the node's fileInfo via `AnalyzerNodeInfo.getFileInfo(node)`, which is a pure utility import, not an evaluator dependency. This keeps the entire suppression cluster (isDiagnosticSuppressedForNode, canSkipDiagnosticForNode, addDiagnosticWithSuppressionCheck, suppressDiagnostics) together on one object.

**`speculativeTypeTracker` dual role.** It's a field on TypeEvaluatorState AND gets passed to `getCodeFlowEngine`. After extraction: `getCodeFlowEngine(evaluatorInterface, state.speculativeTypeTracker)` — the only place external code reaches into state for a field reference.

**`writeTypeCache` external dependency.** Calls `isTypeSame` (from `typeUtils.ts`). This is a pure function with no evaluator dependencies — import directly in `typeEvaluatorState.ts`. No callback injection needed.

**`readTypeCache` debug flag.** Checks both `evaluatorOptions.verifyTypeCacheEvaluatorFlags` and a module-level `const verifyTypeCacheEvaluatorFlags = false`. Since it's always `false`, pass through `evaluatorOptions` in the constructor.

**Test command matters.** Use `bun run test` (with server rebuild), NOT `bun run test:norebuild`. The test server bundles the analyzed code — structural changes require a rebuild.

**Domain function state access pattern.** After extraction, ~12 domain functions still directly access state variables (effectiveTypeCache, expectedTypeCache, assignClassToSelfStack, functionRecursionMap, codeFlowAnalyzerCache, deferredClassCompletions). These switch from bare variable names to `state.fieldName`.

**Circular import risk (typeUtils.ts).** `isTypeSame` must be imported into `typeEvaluatorState.ts`. Safe — `typeUtils.ts` has no dependency on `typeEvaluator.ts` (verified: `constructors.ts` and `operations.ts` already import from `typeUtils.ts`).

**`.bind(state)` vs overloaded functions.** `runWithCancellationToken` has 3 overloads. TypeScript's `.bind()` is weak for overloads — may collapse signatures. If so, use thin arrow-function wrappers instead.

**Missed references are compile errors, not runtime bugs.** Removing closure variable declarations makes any missed `state.` conversion a TypeScript strict-mode compile error.

**One post-construction dependency.** `addDiagnosticWithSuppressionCheck` needs `isNodeReachable` from evaluatorInterface. Set via post-construction setter after evaluatorInterface is created. `ensureRegistryInitialized` stays as a closure function (registry concern). All other state methods are self-contained.

## Anti-Patterns

- **Don't rename the methods.** `pushSymbolResolution` stays `pushSymbolResolution`, not `pushResolution` or `addSymbolToStack`. REASON: this is code motion, not API design. Same names = reviewable diffs.
- **Don't make the state class generic or abstract.** One concrete class, no interfaces, no generics. REASON: there's exactly one implementation and no need for polymorphism.
- **Don't pull domain logic into the state class.** If a function touches state AND does domain logic (e.g., a cache function that also resolves types), split it — state method handles the cache operation, domain function calls the method and does the rest. REASON: the state class should be boring plumbing.
- **Don't use property getters/setters for fields.** Direct field access is fine — pyright's style is explicit, not encapsulated. REASON: this is a performance-sensitive codebase; getter overhead on hot paths matters.
