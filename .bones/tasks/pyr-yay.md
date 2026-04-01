---
id: pyr-yay
title: Extract Type Assignment and Compatibility functions
status: open
type: task
priority: 2
depends_on: [pyr-5hl]
parent: pyr-a56
---

## Context

The `assign*` family implements Python's type compatibility/assignability logic — subtype checks, variance handling, constraint solving, class-to-class assignment, function signature matching, union distribution, and TypeVar binding. This is one of the largest domains (~4000 lines) with a heavy internal call graph (functions call each other extensively) but relatively few upward dependencies into expression evaluation.

Primary closure coupling: `assignClassToSelfStack` (4 refs, used for recursive class variance checking) and `speculativeTypeTracker` (used for speculative assignment attempts). Both are now on `TypeEvaluatorState`.

**Blocked by:** pyr-5hl (Special Forms extracted, reducing closure noise)
**Unlocks:** pyr-1lc (Symbol Resolution extraction)

## Requirements

1. Create `typeAssignment.ts` in `packages/pyright-internal/src/analyzer/`
2. Move all `assign*` functions plus closely related compatibility functions
3. Each function takes `TypeEvaluator` + `TypeRegistry` + `TypeEvaluatorState` as needed
4. Update `typeEvaluator.ts` to import and delegate
5. All existing tests pass — zero behavior change

## Implementation

### Step 1: Baseline test run
```bash
cd packages/pyright-internal && bun run test:norebuild > /tmp/pyright-baseline-assign.txt 2>&1
```

### Step 2: Inventory the functions to extract
Core assignment functions:
- `assignType` — line 24658 (exposed on interface)
- `assignClass` — line 24021
- `assignClassToSelf` — line 24217 (exposed on interface)
- `assignClassWithTypeArgs` — line 24391
- `assignTypeArgs` — line 24529 (exposed on interface)
- `assignFunction` — line 26581
- `assignParam` — line 26400
- `assignFromUnionType` — line 25581
- `assignToUnionType` — line 26081
- `assignConditionalTypeToTypeVar` — line 26271
- `assignRecursiveTypeAliasToSelf` — line 25491
- `applyTypeArgToTypeVar` — line 28086

Related functions that are only called by assignment functions:
- `adjustSourceParamDetailsForDestVariadic` — line 26484
- `convertToTypeFormType` — line 25529

Assignment target functions (assign type TO expression/node):
- `assignTypeToExpression` — line 4481 (exposed on interface)
- `assignTypeToNameNode` — line 3642
- `assignTypeToMemberAccessNode` — line 3776
- `assignTypeToMemberVariable` — line 3872
- `assignTypeToTupleOrListNode` — line 4000

Compatibility helpers:
- `isTypeComparable` — exposed on interface
- `narrowConstrainedTypeVar` — exposed on interface
- `validateOverrideMethod` — exposed on interface

Also move `assignTypeVarScopeId` (line 5282), `enforceClassTypeVarScope` (line 5406), `findScopedTypeVar` (line 5470) — TypeVar scoping functions used by assignment.

### Step 3: Create `typeAssignment.ts`
Create `packages/pyright-internal/src/analyzer/typeAssignment.ts`:
- Export each function with `evaluator`, `registry`, `state` params as needed
- The `assign*` functions heavily call each other — when extracted, they call each other directly within the module (no need to go through the evaluator interface for intra-module calls)
- Functions that are on the `TypeEvaluator` interface get wrapper entries in the evaluator object

### Step 4: Handle the `assignTypeToExpression` subgroup
The `assignTypeTo*` functions (assign type TO a node) call back into expression evaluation more heavily — they evaluate sub-expressions during assignment. Verify their call graph:
- If they primarily call interface methods (`getTypeOfExpression`, `addDiagnostic`), extract them
- If they have deep entanglement with expression evaluation internals, leave them in the closure and document why

### Step 5: Update `typeEvaluator.ts`
- Remove moved functions from closure body
- Import from `typeAssignment.ts`
- Update evaluator interface object to delegate to extracted functions
- Interface-exposed functions (`assignType`, `assignClassToSelf`, `assignTypeArgs`, `assignTypeToExpression`, `isTypeComparable`, `narrowConstrainedTypeVar`, `validateOverrideMethod`) become thin wrappers

### Step 6: Run tests
```bash
cd packages/pyright-internal && bun run test:norebuild > /tmp/pyright-after-assign.txt 2>&1
diff /tmp/pyright-baseline-assign.txt /tmp/pyright-after-assign.txt
```

### Step 7: Run linter
```bash
cd /Volumes/code/pyright && bun run check
```

## Success Criteria

- [ ] `typeAssignment.ts` exists with assignment and compatibility functions
- [ ] `typeEvaluator.ts` reduced by ~4000 lines
- [ ] Full test suite passes
- [ ] Linter passes
- [ ] No circular imports between `typeAssignment.ts` and `typeEvaluator.ts`

## Anti-Patterns

- **Don't split the `assign*` family across multiple files.** They form a dense internal call graph — `assignType` calls `assignClass`, which calls `assignClassWithTypeArgs`, which calls `assignTypeArgs`. Splitting them creates cross-file spaghetti. One module. REASON: functions that call each other belong together.
- **Don't force-extract `assignTypeTo*` functions if they're deeply entangled with expression evaluation.** Check their call graph first. If they need to stay in the closure, that's fine — document it in the task log. REASON: clean boundaries beat line-count targets.
- **Don't change the assignment algorithm.** The order of subtype checks, variance handling, and constraint solving is load-bearing. REASON: this is the core type safety logic of pyright — moving it is mechanical, changing it is a different epic.
