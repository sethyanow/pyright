---
id: pyr-wru
title: Extract TypeRegistry from prefetched
status: closed
type: task
priority: 2
owner: Seth
parent: pyr-a56
---



## Context

The `prefetched` closure variable in `createTypeEvaluator()` is a lazily-populated bag of common Python types (bool, str, dict, tuple, None, etc.) referenced **180 times** across `typeEvaluator.ts`. It's the single largest coupling point keeping functions in the closure. Every domain function needs to check "is this a str?" or "get the bool class" — but `prefetched` is a read-only lookup table, not state management.

Currently it's `Partial<PrefetchedTypes> | undefined` (line 665), populated lazily by `initializePrefetchedTypes()` (line 1019), which calls `getBuiltInType`, `getTypingType`, etc. These functions require a functional evaluator, so initialization can't happen at construction — but it CAN happen eagerly right after the evaluator interface is assembled (line 28764) and before the factory returns.

**Blocked by:** nothing (first task)
**Unlocks:** pyr-kqo (TypeEvaluatorState extraction — state layer needs registry separated first)

## Requirements

1. Create `typeRegistry.ts` in `packages/pyright-internal/src/analyzer/`
2. Define `TypeRegistry` interface — same fields as `PrefetchedTypes` but all non-nullable (no `Partial<>`, no `undefined`)
3. Create `createTypeRegistry(evaluator: TypeEvaluator, importLookup: ImportLookup, node: ParseNode): TypeRegistry` factory that eagerly populates all fields using logic from `initializePrefetchedTypes()` (lines 1019-1099)
4. Call `createTypeRegistry()` inside `createTypeEvaluator()` after the evaluator interface is assembled (after line 28764) but before return
5. Replace all ~180 `prefetched?.fieldName` references with `registry.fieldName` — drop null checks
6. Remove `prefetched` closure variable, `PrefetchedTypes` partial usage, and `initializePrefetchedTypes()` function
7. All existing tests pass — zero behavior change

## Implementation

### Step 1: Baseline test run
Run the full test suite and capture output to establish baseline.
```bash
cd packages/pyright-internal && bun run test:norebuild > /tmp/pyright-baseline.txt 2>&1
```

### Step 2: Create `typeRegistry.ts`
Create `packages/pyright-internal/src/analyzer/typeRegistry.ts`:
- Define `TypeRegistry` interface with all 18 fields from `PrefetchedTypes` (line 206 of `typeEvaluatorTypes.ts`). Note: `PrefetchedTypes` fields are already typed as `Type` (non-nullable) — the nullability comes from the `Partial<>` wrapper on the variable, not the interface. Either reuse `PrefetchedTypes` directly as `TypeRegistry` (type alias) or create a new interface.
- Export `createTypeRegistry(evaluator: TypeEvaluator, importLookup: ImportLookup, node: ParseNode): TypeRegistry` factory function
- **Reconstruct internal helpers inside the factory:** Three closure-only functions are NOT on `TypeEvaluator` interface:
  - `getTypeOfModule(node, symbolName, nameParts)` (line 3358): uses `importLookup` + `evaluator.getEffectiveTypeOfSymbol`. Reconstruct as local function in factory: call `importLookup({nameParts, importingFileUri})`, get symbol from `symbolTable`, call `evaluator.getEffectiveTypeOfSymbol(symbol)`.
  - `getTypesType(node, name)` (line 3350): wraps `getTypeOfModule(node, name, ['types'])`
  - `getTypeshedType(node, name)` (line 3354): wraps `getTypeOfModule(node, name, ['_typeshed'])`
  - `isTypeFormSupported(node)` (line 28629): reads `AnalyzerNodeInfo.getFileInfo(node).diagnosticRuleSet.enableExperimentalFeatures` — no closure state, inline directly.
- **Functions available through evaluator interface:** `evaluator.getBuiltInType()` (line 762), `evaluator.getTypingType()` (line 838), `evaluator.getTypeCheckerInternalsType()` (line 839), `evaluator.getEffectiveTypeOfSymbol()` (line 747).
- Move initialization logic from `initializePrefetchedTypes()` (lines 1019-1099 of `typeEvaluator.ts`) into the factory
- Handle the `AnyType` special form wiring (lines 1070-1097) and the cyclical dependency workaround (line 1039: `getTypingType(node, 'Collection')`)
- **Non-nullable fallbacks:** Several fields are assigned without `?? UnknownType.create()` fallback (e.g., `objectClass`, `typeClass`, `tupleClass`, `boolClass`, `intClass`, `strClass`, `dictClass`). In practice these always resolve from typeshed, but for TypeScript type safety with non-nullable fields, add `?? UnknownType.create()` fallbacks to all assignments.

### Step 3: Integrate registry into `createTypeEvaluator()`
In `typeEvaluator.ts`:
- Replace `let prefetched: Partial<PrefetchedTypes> | undefined` (line 665) with `let registry!: TypeRegistry` (definite assignment assertion — TypeScript trusts initialization happens before first read)
- Remove `initializePrefetchedTypes()` function (lines 1019-1099)
- **CRITICAL: Registry must be lazily initialized, not eager.** `initializePrefetchedTypes(node)` is currently called lazily from 6 entry points (lines 903, 980, 1163, 17431, 18827, 20927) — there is NO `ParseNode` available at factory return time (line 28879). Create a new initializer:
  ```typescript
  let registryInitialized = false;
  function ensureRegistryInitialized(node: ParseNode): void {
      if (registryInitialized) return;
      // CRITICAL: Set flag BEFORE factory call, matching original pattern
      // where `prefetched = {}` was set before resolution. This prevents
      // infinite recursion on re-entrant evaluator calls during init.
      registryInitialized = true;
      registry = createTypeRegistry(evaluatorInterface, importLookup, node);
  }
  ```
- Replace all 6 `initializePrefetchedTypes(node)` call sites with `ensureRegistryInitialized(node)`
- `importLookup` is already a parameter of `createTypeEvaluator()` (line 643), available in closure scope
- The `let registry!: TypeRegistry` pattern means all 180 access sites can use `registry.fieldName` with no `?.` — TypeScript knows it's non-nullable. Runtime safety is guaranteed by the 6 entry point guards (same guarantee as today)

### Step 4: Replace all `prefetched?.` references
Systematic replacement across `typeEvaluator.ts`:
- `prefetched?.boolClass` → `registry.boolClass` (and so on for all fields)
- `prefetched?.` with null checks → direct access (registry is non-nullable)
- `if (prefetched?.objectClass && isInstantiableClass(prefetched.objectClass))` → `if (isInstantiableClass(registry.objectClass))`
- Watch for the pattern `prefetched?.fieldName ?? UnknownType.create()` — if the registry guarantees non-null, the fallback can be removed IF the field is always resolvable. If not (e.g., `templateClass` depends on Python version), keep the field as `Type` (which may be UnknownType) rather than making it optional.

### Step 5: Update `getBuiltInType` helpers
The convenience functions `getTupleClassType()` (line 3309), `getDictClassType()` (line 3313), `getStrClassType()` (line 3317), `getObjectType()` (line 3321), `getNoneType()` (line 3325), `getTypeClassType()` (line 3333) currently read from `prefetched`. Update them to read from `registry`.

### Step 6: Run tests
```bash
cd packages/pyright-internal && bun run test:norebuild > /tmp/pyright-after-registry.txt 2>&1
diff /tmp/pyright-baseline.txt /tmp/pyright-after-registry.txt
```

### Step 7: Run linter
```bash
cd /Volumes/code/pyright && bun run check
```

## Success Criteria

- [x] `typeRegistry.ts` exists with `TypeRegistry` type alias and `populateTypeRegistry()` factory
- [x] `prefetched` closure variable removed from `typeEvaluator.ts`
- [x] `initializePrefetchedTypes()` function removed from `typeEvaluator.ts`
- [x] All ~180 `prefetched?.` references replaced with non-nullable `registry.` access
- [x] No `?.` or `!` operators on `registry` field access (the definite assignment assertion handles it)
- [x] All 6 `initializePrefetchedTypes()` call sites replaced with `ensureRegistryInitialized()`
- [x] Full test suite passes (53/54 suites, 2303/2329 tests — same as baseline; 26 failures in languageServer.test.ts are pre-existing)
- [x] Linter passes

## Key Considerations

- **Lazy initialization is required.** The 6 entry points (`getType`, `getTypeResult`, `getTypeOfExpression`, `getTypeOfClass`, `getTypeOfFunction`, `evaluateTypesForStatement`) each call `initializePrefetchedTypes(node)` at their top. No node exists at factory return (line 28879). The `ensureRegistryInitialized` pattern preserves this behavior.
- **Cyclical dependency.** Line 1039 caches `Collection` before resolving `tuple` to break a cycle. The factory must preserve this ordering. `evaluator.getTypingType(node, 'Collection')` must be called before `evaluator.getBuiltInType(node, 'tuple')`.
- **`supportsKeysAndGetItemClass` fallback.** Lines 1064-1067 fall back to `mappingClass` if `SupportsKeysAndGetItem` is not available. The factory must preserve this conditional.
- **`AnyType` wiring.** Lines 1069-1097 wire up a synthetic `Any` class with `objectClass` and `typeClass` as dependencies. This happens after basic type resolution and must be preserved exactly.
- **`getEffectiveTypeOfSymbol` signature.** The factory's internal `getTypeOfModule` reconstruction needs `evaluator.getEffectiveTypeOfSymbol(symbol)` — verify this overload exists on the interface (line 747 of `typeEvaluatorTypes.ts`). The closure version at line 23120 may have a different signature than the interface version.
- **`PrefetchedTypes` can potentially be reused as `TypeRegistry`.** The interface at line 206 already has all-non-nullable `Type` fields. The `Partial<>` wrapper (not the interface) is what creates nullability. Consider: `export type TypeRegistry = PrefetchedTypes` to avoid duplication.
- **Re-entrancy during initialization.** The original `prefetched = {}` (line 1023) is set BEFORE any resolution calls, so re-entrant evaluator functions during init see `prefetched` as truthy and skip re-initialization (accessing partially-populated fields). The new `registryInitialized = true` must precede the factory call for the same reason. Re-entrant access to `registry` before factory returns hits partially-initialized state — same as today.
- **`PrefetchedTypes` has no external consumers.** Only 3 references: definition (typeEvaluatorTypes.ts:206), import (typeEvaluator.ts:214), variable declaration (typeEvaluator.ts:665). Safe to reuse directly as `TypeRegistry` or remove.
- **No `registry` access path should bypass entry point initialization.** The `let registry!: TypeRegistry` assertion hides uninitialized access from the compiler. After replacement, manually verify that every function accessing `registry.fieldName` is only reachable through one of the 6 entry point guards.

## Anti-Patterns

- **Don't make TypeRegistry fields optional.** The whole point is eager, non-nullable. If a type can't be resolved (e.g., Python version check for `templateClass`), store `UnknownType.create()` — that's what the current code does anyway. REASON: removing 180 null checks is the goal.
- **Don't pass the registry through the TypeEvaluator interface.** It stays internal to `createTypeEvaluator`. Domain modules extracted later will receive it as a direct parameter. REASON: the public interface is for external consumers; registry is an implementation detail.
- **Don't refactor the getBuiltInType/getTypingType functions.** They work fine. Just call them through the evaluator interface. REASON: scope discipline — this task is about the registry, not the type lookup plumbing.
