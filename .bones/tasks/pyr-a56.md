---
id: pyr-a56
title: Decompose typeEvaluator.ts
status: open
type: epic
priority: 2
depends_on: [pyr-wru, pyr-kqo, pyr-5hl, pyr-yay, pyr-1lc, pyr-p1w, pyr-8b1]
---











## Context

`packages/pyright-internal/src/analyzer/typeEvaluator.ts` is 28,880 lines — a single `createTypeEvaluator()` closure containing ~200 inner functions sharing 19 mutable state variables. It's too large for tools to index, agents burn context reading it, and navigating it requires heroic LSP usage.

Pyright already has a proven extraction pattern: `codeFlowEngine.ts`, `constructors.ts`, `operations.ts`, `typeGuards.ts`, and `patternMatching.ts` were extracted from what was presumably an even larger file. The closure pattern is deliberate (avoids `this` dispatch on hot paths), but the file's size is an accident of accretion, not a design choice.

### Root Cause Analysis

The closure holds 19 mutable variables, but only ~30 infrastructure functions directly touch them. The remaining ~170 functions are domain logic held hostage — they call internal helpers that happen to live in the closure, not because they need the shared state.

Key finding: `prefetched` (a read-only type registry) accounts for **180 of the ~280 total state references**. It's a lookup table of common types (bool, str, dict, etc.) stuffed into a closure variable. The other 17 variables have 4-15 references each, concentrated in a small set of infrastructure functions.

The fix: extract the infrastructure (type registry + state management), then domain modules can be extracted using pyright's existing module-function pattern.

## Requirements

1. Extract `TypeRegistry` — eager, non-nullable type registry replacing `prefetched` (180 ref sites)
2. Extract `TypeEvaluatorState` — state object with methods for the 17 mutable closure variables and ~30 infrastructure functions
3. Extract Special Form Creation — `create*` functions (~4000 lines)
4. Extract Type Assignment/Compatibility — `assign*` functions (~4000 lines)
5. Extract Symbol/Declaration Resolution — `getDeclared*`, `getEffective*`, `resolve*` (~2000 lines)
6. Extract Member Access/Descriptors — `applyDescriptor*`, `bindMethod*` (~1500 lines)
7. Extract Call Validation/Overloads — `validate*`, `getBestOverload*`, `expandArg*` (~2000 lines)
8. All existing tests pass after every extraction — zero behavior change
9. Target: `typeEvaluator.ts` at ~5K lines (expression evaluation orchestration + wiring)

## Success Criteria

- [ ] `typeEvaluator.ts` reduced from ~29K to ~5K lines
- [ ] Full test suite passes: `cd packages/pyright-internal && bun run test:norebuild`
- [ ] Each extracted module has single clear responsibility
- [ ] No circular dependencies between extracted modules
- [ ] Extracted modules follow pyright's existing patterns (take `TypeEvaluator` as param)

## Anti-Patterns

- **Don't widen the public `TypeEvaluator` interface for every extraction.** Domain modules receive `TypeEvaluatorState` + `TypeRegistry` as params alongside `TypeEvaluator`. Only add to the interface if external consumers genuinely need it. REASON: interface bloat defeats the purpose of decomposition.
- **Don't extract Expression Evaluation.** The `getTypeOf*` and `evaluateTypesFor*` orchestration functions stay in the closure — they're the genuine orchestrator that dispatches to domain modules. ~5K lines of orchestration is digestible. REASON: diminishing returns; the goal is "digestible" not "empty."
- **Don't change behavior.** This is structural refactoring. If a test fails, the extraction broke something — fix the extraction, not the test. REASON: the test suite is the specification.
- **Don't create new abstractions.** Move functions to modules, pass dependencies as params. No new design patterns, no class hierarchies, no dependency injection frameworks. REASON: pyright already has a working extraction pattern — use it.
- **Don't over-engineer the state object.** Methods on `TypeEvaluatorState` should be the same functions that exist today, just on an object instead of in a closure. Same names, same signatures plus `this`. REASON: this is code motion, not redesign.

## Approach

Linear extraction, bottom-up by dependency depth. Infrastructure first (unblocks everything), then domain modules from leaves to root.

### Extraction Pattern

Two patterns already exist in pyright:
1. **Module functions** (`constructors.ts`, `operations.ts`): standalone exported functions that take `TypeEvaluator` as parameter
2. **Engine factory** (`codeFlowEngine.ts`): factory that receives evaluator + state, returns object with methods

Domain extractions (tasks 3-7) use pattern 1. Infrastructure extraction (task 2) uses pattern 2.

**Reference:** `.claude/skills/closure-extraction/` — LSP-driven dependency mapping, SCC analysis for extraction ordering, per-function checklist.

### Verified Architecture Claims

- `prefetched` has 180 references, all other state vars have 4-15 [VERIFIED via LSP findReferences]
- `initializePrefetchedTypes` (line 1019) uses `getBuiltInType`/`getTypingType` which require a functional evaluator [VERIFIED via Read]
- `writeTypeCache` touches 4 state variables in one operation: typeCache, returnTypeInferenceTypeCache, incompleteGenCount, speculativeTypeTracker [VERIFIED via Read line 766]
- `speculativeTypeTracker` is already a class instance with its own methods [VERIFIED via Read line 22106]
- Existing extracted modules only import from `typeEvaluatorTypes.ts`, not from `typeEvaluator.ts` [VERIFIED via Read of constructors.ts, operations.ts imports]

## Key Decisions

| Question | Answer | Implication |
|----------|--------|------------|
| Primary goal? | Navigability/maintainability for humans + agents | Optimize for file size reduction and clear module boundaries |
| Upstream? | Personal fork, no constraints | Can diverge from closure pattern freely |
| `prefetched` handling? | Eager, non-nullable TypeRegistry | All 180 sites lose null checks, populated before evaluator returns |
| State layer design? | Methods on object (not FP standalone) | State is internally coupled (writeTypeCache touches 4 vars); methods match pyright style |
| Extraction order? | Bottom-up, linear chain | Each extraction builds on the last, no scaffolding needed |
| Expression Evaluation? | Stays in closure | ~5K is the target resting state, revisit naturally if needed |
| Epic structure? | One phase, seven tasks, linear deps | Known mechanical work, no ceremony needed |
