---
id: pyr-8b1
title: Extract Call Validation and Overload Resolution functions
status: open
type: task
priority: 2
depends_on: [pyr-p1w]
parent: pyr-a56
---

## Context

Call validation and overload resolution functions handle Python's complex calling conventions — positional args, keyword args, *args/**kwargs, overloaded functions, ParamSpec, TypeVarTuple in arg positions, and the interaction between overload selection and type narrowing. This is the last domain extraction, sitting just below the expression evaluation orchestration layer.

Primary closure coupling was `signatureTrackerStack` (7 refs) and `speculativeTypeTracker` (used for speculative overload evaluation) — both now on `TypeEvaluatorState`.

**Blocked by:** pyr-p1w (Member Access extracted)
**Unlocks:** Epic completion — after this, `typeEvaluator.ts` should be at ~5K lines

## Requirements

1. Create `callValidation.ts` in `packages/pyright-internal/src/analyzer/`
2. Move call validation, overload resolution, and arg expansion functions
3. Each function takes `TypeEvaluator` + `TypeRegistry` + `TypeEvaluatorState` as needed
4. Update `typeEvaluator.ts` to import and delegate
5. All existing tests pass — zero behavior change
6. Final `wc -l` check on `typeEvaluator.ts` — target ~5K lines

## Implementation

### Step 1: Baseline test run
```bash
cd packages/pyright-internal && bun run test:norebuild > /tmp/pyright-baseline-cv.txt 2>&1
```

### Step 2: Inventory the functions to extract
Call validation:
- `validateCallArgs` — exposed on interface (this is the main entry point, likely very large)
- `validateOverloadedArgTypes` — exposed on interface
- `validateInitSubclassArgs` — exposed on interface
- `validateTypeArg` — exposed on interface (also called by Special Forms — verify it was already extracted in pyr-5hl or extract here)

Overload resolution:
- `getBestOverloadForArgs` — line 9625 (exposed on interface)
- `filterOverloadMatchesForAnyArgs` — line 9577
- `filterOverloadMatchesForUnpackedArgs` — line 9561

Arg expansion:
- `expandArgList` — line 10844
- `expandArgType` — line 9932
- `expandArgTypes` — line 9884

Arg processing:
- `convertNodeToArg` — line 8871 (exposed on interface)
- `getTypeOfArg` — exposed on interface
- `getTypeOfArgExpectingType` — line 21770
- `getSpeculativeNodeForCall` — line 9333

Call signature:
- `getCallSignatureInfo` — line 2560 (exposed on interface)
- `evaluateCastCall` — line 10803
- `getTypeOfAssertType` — line 8821

Helpers:
- `getIndexAccessMagicMethodName` — line 8069
- `getTypeArgs` — line 8304
- `getTypeArg` — line 8484
- `adjustCallableReturnType` — line 12441
- `adjustTypeArgsForTypeVarTuple` — line 7133
- `adjustParamAnnotatedType` — line 19372
- `applyConditionFilterToType` — line 4403

### Step 3: Create `callValidation.ts`
Create `packages/pyright-internal/src/analyzer/callValidation.ts`:
- Export each function with dependency params
- `validateCallArgs` is the heavyweight — it likely calls into member access (for method binding) and type assignment (for arg type checking). Both are already extracted, accessible via evaluator interface or direct imports
- Overload resolution uses speculative mode heavily — calls through `state.useSpeculativeMode()`
- Signature tracking uses `state.useSignatureTracker()` and `state.ensureSignatureIsUnique()`

### Step 4: Check for functions already extracted
`validateTypeArg` may have been moved in pyr-5hl (Special Forms) since it's called heavily by `create*` functions. Verify:
- If already in `specialForms.ts` → import it from there
- If still in `typeEvaluator.ts` → move it here (it's more naturally a validation function)

### Step 5: Update `typeEvaluator.ts`
- Remove moved functions
- Import from `callValidation.ts`
- Update evaluator interface entries

### Step 6: Run tests
```bash
cd packages/pyright-internal && bun run test:norebuild > /tmp/pyright-after-cv.txt 2>&1
diff /tmp/pyright-baseline-cv.txt /tmp/pyright-after-cv.txt
```

### Step 7: Verify final file size
```bash
wc -l packages/pyright-internal/src/analyzer/typeEvaluator.ts
```
Target: ~5000 lines. If significantly larger, identify what remains and document in the epic log.

### Step 8: Run linter
```bash
cd /Volumes/code/pyright && bun run check
```

## Success Criteria

- [ ] `callValidation.ts` exists with call validation and overload resolution functions
- [ ] `typeEvaluator.ts` reduced to ~5K lines (expression evaluation + wiring)
- [ ] Full test suite passes
- [ ] Linter passes
- [ ] No circular imports across any extracted modules
- [ ] `wc -l` result documented in bones log

## Anti-Patterns

- **Don't extract the expression-level call evaluation.** Functions like `getTypeOfCall` (if it exists as a single entry point from expression evaluation) may be the orchestration dispatch, not call validation per se. The line between "validate these args" and "evaluate this call expression" is where the extraction boundary sits. REASON: expression evaluation orchestration stays in the closure.
- **Don't create dependencies between `callValidation.ts` and `specialForms.ts`.** If both need `validateTypeArg`, it lives in one place and the other imports it. Prefer putting it in `callValidation.ts` since validation is its primary concern. REASON: unidirectional dependency graph.
- **Don't chase the 5K target by force-extracting functions that belong in the orchestration layer.** If the file ends up at 6K or 7K, that's still a success — down from 29K. Document what remains and why. REASON: clean boundaries beat line-count targets.
