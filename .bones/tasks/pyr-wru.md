---
id: pyr-wru
title: Extract TypeRegistry from prefetched
status: open
type: task
priority: 2
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
3. Create `createTypeRegistry(evaluator: TypeEvaluator): TypeRegistry` factory that eagerly populates all fields using logic from `initializePrefetchedTypes()` (lines 1019-1095)
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
- Define `TypeRegistry` interface with all fields from `PrefetchedTypes` (line 206 of `typeEvaluatorTypes.ts`) but non-nullable
- Export `createTypeRegistry(evaluator: TypeEvaluator): TypeRegistry` factory function
- Move initialization logic from `initializePrefetchedTypes()` (lines 1019-1095 of `typeEvaluator.ts`) into the factory
- The factory calls `evaluator.getBuiltInType()`, `evaluator.getTypingType()`, etc. — same functions, just through the interface instead of closure access
- Handle the `AnyType` special form wiring (lines 1070-1095) and the cyclical dependency workaround (line 1039: `getTypingType(node, 'Collection')`)

### Step 3: Integrate registry into `createTypeEvaluator()`
In `typeEvaluator.ts`:
- Remove `let prefetched: Partial<PrefetchedTypes> | undefined` (line 665)
- Remove `initializePrefetchedTypes()` function (lines 1019-1095)
- After the `evaluatorInterface` object is created (line 28764) and `codeFlowEngine` (line 28877), add: `const registry = createTypeRegistry(evaluatorInterface)`
- Note: `createTypeRegistry` needs a `ParseNode` to pass to `getBuiltInType` — check how `initializePrefetchedTypes` gets its node and replicate

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

- [ ] `typeRegistry.ts` exists with `TypeRegistry` interface and `createTypeRegistry()` factory
- [ ] `prefetched` closure variable removed from `typeEvaluator.ts`
- [ ] `initializePrefetchedTypes()` function removed from `typeEvaluator.ts`
- [ ] All ~180 `prefetched?.` references replaced with non-nullable `registry.` access
- [ ] Full test suite passes
- [ ] Linter passes

## Anti-Patterns

- **Don't make TypeRegistry fields optional.** The whole point is eager, non-nullable. If a type can't be resolved (e.g., Python version check for `templateClass`), store `UnknownType.create()` — that's what the current code does anyway. REASON: removing 180 null checks is the goal.
- **Don't pass the registry through the TypeEvaluator interface.** It stays internal to `createTypeEvaluator`. Domain modules extracted later will receive it as a direct parameter. REASON: the public interface is for external consumers; registry is an implementation detail.
- **Don't refactor the getBuiltInType/getTypingType functions.** They work fine. Just call them through the evaluator interface. REASON: scope discipline — this task is about the registry, not the type lookup plumbing.
