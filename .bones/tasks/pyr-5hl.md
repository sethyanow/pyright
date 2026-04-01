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
- [ ] Full test suite passes (2343 tests as of pyr-kqo baseline)
- [ ] Linter passes
- [ ] No circular imports — `specialForms.ts` imports from `typeEvaluatorTypes.ts` (interface), never from `typeEvaluator.ts`
- [ ] Each function's parameter list matches actual dependency usage (no unnecessary evaluator/registry/state params)

## Anti-Patterns

- **Don't create a class or factory pattern for special forms.** These are standalone functions — match the `constructors.ts` / `operations.ts` pattern of exported functions. REASON: consistency with pyright's existing extracted modules.
- **Don't pass all three dependencies to every function.** Trace actual usage — if a `create*` function only needs `evaluator` and `registry`, don't add `state`. REASON: minimal dependency surface makes functions easier to test and reason about.
- **Don't rename functions or change signatures beyond adding the dependency params.** REASON: code motion, not redesign. Reviewable diffs.
- **Don't move `createSpecializedClassType` if it has heavy expression evaluation entanglement.** Verify its call graph first — if it calls back into expression evaluation heavily, it may belong in the orchestration layer. Flag it and leave in place rather than creating a circular dependency. REASON: clean module boundaries beat completionism.
- **Don't import from `typeEvaluator.ts` in `specialForms.ts`.** Always import the `TypeEvaluator` interface from `typeEvaluatorTypes.ts`. Importing from the implementation file creates circular dependency risk and breaks the established pattern. REASON: constructors.ts and operations.ts follow this pattern already.
- **Don't extract in bulk then compile once at the end.** Extract in dependency-ordered batches, compile after each batch. Bulk extraction produces cascading errors that obscure root causes. REASON: incremental compilation catches issues where they originate.

## Key Considerations

### Non-interface helper functions used by createSpecializedClassType (SRE-verified)

`createSpecializedClassType` calls 5 closure-defined helper functions not on the `TypeEvaluator` interface. SRE analysis confirmed ALL of them depend only on interface methods + imported utilities — they CAN be extracted:

| Helper | Closure deps | Used outside create*? | Size |
|--------|-------------|----------------------|------|
| `isTypeFormSupported` (line 28167) | None — reads `AnalyzerNodeInfo.getFileInfo(node)` directly | Yes (18 refs across file) | 3 lines |
| `validateTypeParamDefault` (line 17986) | `addDiagnostic` (interface), `validateTypeVarDefault` (imported) | Yes (lines 17625, 18977) | ~43 lines |
| `validateTypeVarTupleIsUnpacked` (line 6915) | `addDiagnostic` (interface) | Yes (lines 6870, 15164, 15233) | ~14 lines |
| `transformTypeArgsForParamSpec` (line 21320) | `addDiagnostic` (interface) | Yes (line 7036 in createSpecializedTypeAlias — also being extracted) | ~66 lines |
| `applyTypeArgToTypeVar` (line 27624) | `assignType`, `makeTopLevelTypeVarsConcrete`, `printType` (all interface) | No (only call site is createSpecializedClassType) | ~122 lines |

**Strategy for shared helpers:** Export them from `specialForms.ts` and import them back into the `typeEvaluator.ts` closure body. No circular dependency since `specialForms.ts` → `typeEvaluatorTypes.ts` (interface), and `typeEvaluator.ts` → `specialForms.ts` (functions). This is one-directional.

**`isTypeFormSupported` special case:** This 3-line utility has no closure dependencies at all. Could be extracted to a standalone utility module or placed in `specialForms.ts`. Either way, its 18 call sites in typeEvaluator.ts become imports.

### Interleaved non-create* functions

The create* functions in the 12915-17400 range are NOT contiguous — other functions like `getTypeVarTupleDefaultType` (line 12941), `getTypeVarDefaultType`, etc. are interleaved. Don't assume the block can be cut-and-pasted wholesale. Each function must be individually identified and moved.

### Extraction order (dependency-safe)

1. **Leaf functions first** — functions that only call `addDiagnostic` + imported utilities: `createTypeVarType`, `createTypeVarTupleType`, `createParamSpecType`, `createCallableType`, `createOptionalType`, `createLiteralType`, `createClassVarType`, `createTypeFormType`, `createTypeGuardType`, `createSelfType`, `createRequiredOrReadOnlyType`, `createUnpackType`, `createFinalType`, `createConcatenateType`, `createAnnotatedType`, `createUnionType`, `createGenericType`, `createNewType`, `createTypeAliasType`, `createClassFromMetaclass`, `createAsyncFunction`, `createAwaitableReturnType`
2. **Shared helpers** — `isTypeFormSupported`, `validateTypeVarTupleIsUnpacked`, `validateTypeParamDefault`, `transformTypeArgsForParamSpec`, `applyTypeArgToTypeVar`, `getBooleanValue`, `getFunctionFullName`, `getParamSpecDefaultType`, `getPseudoGenericTypeVarName`
3. **Dispatch functions** — `createSpecialType` (calls other create* functions), `createSpecialBuiltInClass` (calls createSpecialType + other create*)
4. **Heavy functions** — `createSpecializedClassType` (calls shared helpers + other create* functions), `createSpecializedTypeAlias`, `buildTypeParamsFromTypeArgs`
5. **Interface-exposed** — `createSubclass` (needs wrapper in evaluator interface object)

### Adversarial failure modes

**Argument threading errors:** When adding `evaluator`/`registry`/`state` params, verify each call site's argument order manually. Don't bulk-prepend — some functions have optional params that could confuse positional matching. TypeScript strict mode + test suite catches mismatches.

**Partial extraction compile errors:** Mid-extraction, moved functions may reference not-yet-moved functions. Compile after each batch in the dependency order above to catch issues at source.

**Import cycle prevention:** `specialForms.ts` MUST import `TypeEvaluator` from `typeEvaluatorTypes.ts`, never from `typeEvaluator.ts`. This matches `constructors.ts` and `operations.ts` pattern.

### Stale line numbers

Line numbers in the Step 2 inventory are from before pyr-kqo extraction. Verified current positions via LSP documentSymbol — all functions exist but at shifted positions. Use LSP or `function functionName(` search during implementation, not hardcoded line numbers.

## Log

- [2026-04-01T20:43:37Z] [Seth] SRE review complete. Key findings: (1) createSpecializedClassType's 5 non-interface helper deps all depend only on interface methods + imports — extractable. (2) isTypeFormSupported is trivial 3-line utility, used in 18 places. (3) 4 helpers shared with non-create* code — export from specialForms.ts, import back. (4) Functions NOT contiguous in 12915-17400 range. (5) Line numbers stale from pyr-kqo. Added: 2 success criteria (no circular imports, param tracing), 2 anti-patterns (no import from typeEvaluator.ts, incremental extraction), Key Considerations section with dependency analysis, extraction order, adversarial failure modes. Recommendation: APPROVE with updates applied.
