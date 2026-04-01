---
id: pyr-5hl
title: Extract Special Form Creation functions
status: open
type: task
priority: 2
depends_on: [pyr-kqo]
parent: pyr-a56
---

## Context

The `create*` family of functions in `typeEvaluator.ts` build special Python type constructs — `Callable`, `Union`, `Optional`, `Literal`, `TypeVar`, `ParamSpec`, `TypeVarTuple`, `Annotated`, `TypeGuard`, `Final`, `Required`, `ReadOnly`, `ClassVar`, `Concatenate`, `Unpack`, `Generic`, `NewType`, `TypeAlias`, `Self`, and specialized class types. These are leaf functions with the lightest closure coupling — they mostly call `addDiagnostic` (on the interface), `validateTypeArg` (on the interface), and `getTypeOfExpression` (evaluator interface method).

With TypeRegistry and TypeEvaluatorState extracted, these functions can be standalone module functions that take `TypeEvaluator`, `TypeRegistry`, and `TypeEvaluatorState` as parameters.

**Blocked by:** pyr-kqo (state must be extractable as a parameter)
**Unlocks:** pyr-yay (Type Assignment extraction)

## Requirements

1. Create `specialForms.ts` in `packages/pyright-internal/src/analyzer/`
2. Move all `create*` functions from `typeEvaluator.ts` into `specialForms.ts`
3. Each function takes `TypeEvaluator` + `TypeRegistry` + `TypeEvaluatorState` as needed
4. Update `typeEvaluator.ts` to import and call the extracted functions
5. All existing tests pass — zero behavior change

## Implementation

### Step 1: Baseline test run
```bash
cd packages/pyright-internal && bun run test:norebuild > /tmp/pyright-baseline-sf.txt 2>&1
```

### Step 2: Inventory the functions to extract
Functions to move (all inside `createTypeEvaluator` closure):
- `createTypeVarType` — line 12990
- `createTypeVarTupleType` — line 13231
- `createParamSpecType` — line 13323
- `createTypeAliasType` — line 13467
- `createNewType` — line 13632
- `createClassFromMetaclass` — line 13771
- `createCallableType` — line 15555
- `createOptionalType` — line 15710
- `createLiteralType` — line 15783
- `createClassVarType` — line 15926
- `createTypeFormType` — line 15962
- `createTypeGuardType` — line 15997
- `createSelfType` — line 16030
- `createRequiredOrReadOnlyType` — line 16125
- `createUnpackType` — line 16221
- `createFinalType` — line 16269
- `createConcatenateType` — line 16293
- `createAnnotatedType` — line 16345
- `createSpecialType` — line 16413
- `createUnionType` — line 16552
- `createGenericType` — line 16638
- `createSpecialBuiltInClass` — line 16812
- `createSubclass` — line 17380 (exposed on interface)
- `createSpecializedClassType` — line 21171
- `createSpecializedTypeAlias` — line 7364
- `createAsyncFunction` — line 19577
- `createAwaitableReturnType` — line 19606

Also check for helper functions called only by these:
- `getBooleanValue` — line 13598
- `getFunctionFullName` — line 13611
- `getParamSpecDefaultType` — line 13396
- `buildTypeParamsFromTypeArgs` — line 18327
- `getPseudoGenericTypeVarName` — line 17375

### Step 3: Create `specialForms.ts`
Create `packages/pyright-internal/src/analyzer/specialForms.ts`:
- Export each function individually (matching pyright's existing pattern in `constructors.ts`)
- Add `evaluator: TypeEvaluator` as first parameter to each function
- Add `registry: TypeRegistry` parameter where the function accesses common types
- Add `state: TypeEvaluatorState` parameter where the function uses infrastructure (speculative mode, diagnostics suppression, etc.)
- Trace each function's internal calls to determine which params it actually needs — don't pass all three blindly

### Step 4: Update `typeEvaluator.ts`
- Remove the moved functions from the closure body
- Add imports from `specialForms.ts`
- At each call site, replace bare calls with `specialForms.createXxx(evaluatorInterface, registry, state, ...originalArgs)` or bind them partially

### Step 5: Handle interface-exposed functions
`createSubclass` is exposed on the `TypeEvaluator` interface (line 28773). The evaluator interface entry becomes a wrapper that calls the extracted function:
```typescript
createSubclass: (...args) => specialForms.createSubclass(evaluatorInterface, registry, state, ...args)
```

### Step 6: Run tests
```bash
cd packages/pyright-internal && bun run test:norebuild > /tmp/pyright-after-sf.txt 2>&1
diff /tmp/pyright-baseline-sf.txt /tmp/pyright-after-sf.txt
```

### Step 7: Run linter
```bash
cd /Volumes/code/pyright && bun run check
```

## Success Criteria

- [ ] `specialForms.ts` exists with all `create*` functions
- [ ] All moved functions removed from `typeEvaluator.ts` closure body
- [ ] `typeEvaluator.ts` reduced by ~4000 lines
- [ ] Full test suite passes
- [ ] Linter passes

## Anti-Patterns

- **Don't create a class or factory pattern for special forms.** These are standalone functions — match the `constructors.ts` / `operations.ts` pattern of exported functions. REASON: consistency with pyright's existing extracted modules.
- **Don't pass all three dependencies to every function.** Trace actual usage — if a `create*` function only needs `evaluator` and `registry`, don't add `state`. REASON: minimal dependency surface makes functions easier to test and reason about.
- **Don't rename functions or change signatures beyond adding the dependency params.** REASON: code motion, not redesign. Reviewable diffs.
- **Don't move `createSpecializedClassType` if it has heavy expression evaluation entanglement.** Verify its call graph first — if it calls back into expression evaluation heavily, it may belong in the orchestration layer. Flag it and leave in place rather than creating a circular dependency. REASON: clean module boundaries beat completionism.
