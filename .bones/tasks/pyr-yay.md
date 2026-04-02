---
id: pyr-yay
title: Extract Type Assignment and Compatibility functions
status: active
type: task
priority: 2
owner: Seth
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

**Reference:** `.claude/skills/closure-extraction/` — extraction process, dependency mapping, per-function checklist.

### Step 1: Baseline test run
```bash
cd packages/pyright-internal && bun run test:norebuild > /tmp/pyright-baseline-assign.txt 2>&1
```

### Step 2: Inventory the functions to extract
Core assignment functions (VERIFIED line numbers as of pyr-5hl completion):
- `assignType` — line 21108 (exposed on interface)
- `assignClass` — line 20471
- `assignClassToSelf` — line 20667 (exposed on interface)
- `assignClassWithTypeArgs` — line 20841
- `assignTypeArgs` — line 20979 (exposed on interface)
- `assignFunction` — line 23031
- `assignParam` — line 22850
- `assignFromUnionType` — line 22031
- `assignToUnionType` — line 22531
- `assignConditionalTypeToTypeVar` — line 22721
- `assignRecursiveTypeAliasToSelf` — line 21941

Related functions that are only called by assignment functions:
- `adjustSourceParamDetailsForDestVariadic` — line 22934
- `convertToTypeFormType` — line 21979

Assignment target functions (assign type TO expression/node):
- `assignTypeToExpression` — line 4110 (exposed on interface)
- `assignTypeToNameNode` — line 3271
- `assignTypeToMemberAccessNode` — line 3405
- `assignTypeToMemberVariable` — line 3501
- `assignTypeToTupleOrListNode` — line 3629

Compatibility/subtyping helpers:
- `isTypeComparable` — line 22401 (exposed on interface)
- `isProperSubtype` — line 22356
- `isTypeSubsumedByOtherType` — line 22331 (exposed on interface)
- `isSpecialFormClass` — line 22304 (exposed on interface)
- `narrowConstrainedTypeVar` — line 25051 (exposed on interface, thin wrapper over codeFlowEngine)
- `narrowTypeBasedOnAssignment` — line 23872

Override validation (co-extract as cluster):
- `validateOverrideMethod` — line 23952 (exposed on interface)
- `isOverrideMethodApplicable` — line 24089
- `validateOverrideMethodInternal` — line 24131

TypeVar scoping functions:
- `assignTypeVarScopeId` — line 4911
- `enforceClassTypeVarScope` — line 5035
- `findScopedTypeVar` — line 5099

NOTE: `applyTypeArgToTypeVar` was listed in the original plan at line 28086 but DOES NOT EXIST in typeEvaluator.ts (file is 25,210 lines). Removed from inventory.

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
- Interface-exposed functions (`assignType`, `assignClassToSelf`, `assignTypeArgs`, `assignTypeToExpression`, `isTypeComparable`, `isTypeSubsumedByOtherType`, `isSpecialFormClass`, `narrowConstrainedTypeVar`, `validateOverrideMethod`) become thin delegation lambdas matching the specialForms.ts pattern

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
- [ ] No circular imports — `typeAssignment.ts` imports from `typeEvaluatorTypes.ts` (not `typeEvaluator.ts`)
- [ ] Each extracted function receives evaluator/registry/state as explicit params (no implicit closure access)
- [ ] assignTypeTo* decision documented: either extracted with rationale, or left in closure with rationale

## Anti-Patterns

- **Don't split the `assign*` family across multiple files.** They form a dense internal call graph — `assignType` calls `assignClass`, which calls `assignClassWithTypeArgs`, which calls `assignTypeArgs`. Splitting them creates cross-file spaghetti. One module. REASON: functions that call each other belong together.
- **Don't force-extract `assignTypeTo*` functions if they're deeply entangled with expression evaluation.** Check their call graph first. If they need to stay in the closure, that's fine — document it in the task log. REASON: clean boundaries beat line-count targets.
- **Don't change the assignment algorithm.** The order of subtype checks, variance handling, and constraint solving is load-bearing. REASON: this is the core type safety logic of pyright — moving it is mechanical, changing it is a different epic.
- **Don't extract `validateOverrideMethod` without its helpers.** `isOverrideMethodApplicable` (line 24089) and `validateOverrideMethodInternal` (line 24131) must be co-extracted — they're direct internal helpers. REASON: extracting the public function without its implementation creates split logic.
- **Don't extract `bindFunctionToClassOrObject` or `partiallySpecializeBoundMethod`.** These belong to the Member Access/Descriptors extraction (pyr-p1w), not type assignment. REASON: scope creep into a different task's domain.

## Key Considerations

- All line numbers were VERIFIED after pyr-5hl completion (file at 25,210 lines). Prior numbers were offset ~3,500 lines.
- `assignClassToSelfStack` confirmed on `TypeEvaluatorState` (line 94 in typeEvaluatorState.ts). `speculativeTypeTracker` confirmed at line 92.
- The `assignTypeTo*` group (lines 3271-4110) is physically separated from the core cluster (lines 20471-23031) — they're in the expression evaluation area. Step 4 investigation is essential.
- `narrowConstrainedTypeVar` is a thin 8-line wrapper delegating to `codeFlowEngine.narrowConstrainedTypeVar`. Extracting it is trivial but consider whether it really belongs with assignment vs. code-flow.
- Functions near the assignment cluster that are NOT in scope: `getAbstractSymbols` (24538), `isFinalVariable` (24772), `isExplicitTypeAliasDeclaration` (24780), print functions (24922-24980), `parseStringAsTypeAnnotation` (24990).

### Failure Catalog (Adversarial Planning)

**Dependency Treachery: Function parameter wiring**
- Assumption: Every closure variable accessed by extracted functions is either on `TypeEvaluator` interface, `TypeEvaluatorState`, `TypeRegistry`, or a direct import from another module.
- Betrayal: A function accesses a closure-local variable (e.g., `importLookup`, `evaluatorOptions`, `codeFlowEngine`) that isn't on any of the three param objects. TypeScript catches this at compile time, but fixing it mid-extraction creates cascading interface changes.
- Consequence: Extraction stalls while deciding whether to add the variable to the interface, pass it as an extra param, or restructure.
- Mitigation: Before extracting each function, read it and list all non-local references. Verify each maps to evaluator interface, state, registry, or a direct module import. Surface unmapped references before writing code. The specialForms.ts extraction already solved this — follow the same verification pattern.

**Temporal Betrayal: Import circularity**
- Assumption: `typeAssignment.ts` imports from `typeEvaluatorTypes.ts` (interfaces) and utility modules, never from `typeEvaluator.ts` directly.
- Betrayal: A dependency on a function still in the closure (e.g., `getTypeOfExpression`) is satisfied by importing from `typeEvaluator.ts` instead of going through the `TypeEvaluator` interface parameter.
- Consequence: Circular import. TypeScript may compile but runtime initialization order fails silently — exported values are `undefined` when the circular import resolves.
- Mitigation: Structural rule: `typeAssignment.ts` NEVER imports from `typeEvaluator.ts`. All access to evaluator functionality goes through the `TypeEvaluator` interface parameter. Verify with `import` statement audit after extraction.

**State Corruption: Interface delegation wiring**
- Assumption: Interface delegation lambdas correctly forward all parameters and return values.
- Betrayal: The evaluator interface object uses shorthand property assignment (`assignType,`) for functions currently in the closure. After extraction, these become delegation lambdas (`assignType: (...args) => typeAssignment.assignType(evaluatorInterface, ...args)`). If the delegation omits a parameter or gets the order wrong for params with compatible types (e.g., two `ClassType` params swapped), TypeScript won't catch it.
- Consequence: Silent behavioral change — wrong type passed to wrong parameter. Tests may not catch it if the swapped types happen to work in common cases but fail for edge cases.
- Mitigation: For each delegation lambda, verify parameter count AND names match the original function signature. Use named parameters in the delegation, not positional spread. Follow the existing specialForms.ts pattern where each delegation is explicit.

**Dependency Treachery: Intra-module call graph**
- Assumption: After extraction, assign* functions call each other directly within `typeAssignment.ts` without going through the evaluator interface.
- Betrayal: Some assign* functions are called from BOTH within the family AND from remaining typeEvaluator.ts code. The typeEvaluator.ts callers will use the imported name. But if the imported function also needs `evaluator` as a param, the caller in typeEvaluator.ts must pass `evaluatorInterface` — which may not exist at the call site (e.g., in a nested helper that doesn't have it in scope).
- Consequence: Compile error at call sites in typeEvaluator.ts that previously called the function as a closure sibling.
- Mitigation: Before extracting, use LSP `findReferences` on each function to identify ALL callers. Separate callers into: (a) within extraction batch → direct calls, (b) in typeEvaluator.ts closure → must pass evaluatorInterface, (c) via TypeEvaluator interface → delegation handles it. Category (b) is the risk — each such caller must have `evaluatorInterface` in scope.

**Input Hostility: assignTypeTo* decision boundary**
- Assumption: The call-graph investigation (Step 4) cleanly categorizes assignTypeTo* functions as either "extractable" or "too entangled."
- Betrayal: A function is 80% extractable but has 2-3 calls to deep closure internals that aren't on any interface. The agent declares it "too entangled" and leaves the entire group behind, losing 800+ lines of extraction.
- Consequence: Suboptimal decomposition — line count target undershot, but no behavioral issue.
- Mitigation: For functions with partial entanglement, check if the closure internals they call can be added to the TypeEvaluator interface (if they're generally useful) or passed as callback params (if they're narrow). Don't treat "has ANY closure dependency" as binary — evaluate each dependency individually. But if adding them to the interface would bloat it (anti-pattern from epic), leave the functions in the closure and document why.

## Log

- [2026-04-02T16:23:39Z] [Seth] Session failed: completed investigation (Steps 1-3) but zero extraction code written. Over-analyzed ~2500 lines of source, spawned failed agent in violation of TDD skill rules. Handoff written with complete dependency mappings so next session can skip analysis and start writing immediately.
