---
id: pyr-p1w
title: Extract Member Access and Descriptor functions
status: closed
type: task
priority: 2
owner: Seth
depends_on: [pyr-1lc]
parent: pyr-a56
---








## Context

Member access and descriptor functions handle Python's attribute access protocol — descriptor `__get__`/`__set__`/`__delete__` dispatch, `__getattr__`/`__getattribute__` overrides, method binding to classes/instances, and the complexities of asymmetric accessors (properties with different get/set types).

These functions are moderately coupled to the closure — they call `addDiagnostic`, `getTypeOfExpression`, and type assignment functions. With the TypeEvaluator interface, TypeRegistry, TypeEvaluatorState, and type assignment already extracted, these can be cleanly moved.

**Blocked by:** pyr-1lc (Symbol Resolution extracted)
**Unlocks:** pyr-8b1 (Call Validation extraction)

## Requirements

1. Create `memberAccess.ts` in `packages/pyright-internal/src/analyzer/`
2. Move member access, descriptor, and method binding functions
3. Each function takes `TypeEvaluator` + `TypeRegistry` + `TypeEvaluatorState` as needed
4. Update `typeEvaluator.ts` to import and delegate
5. All existing tests pass — zero behavior change

## Implementation

### Step 1: Baseline test run
```bash
cd packages/pyright-internal && bun run test:norebuild > /tmp/pyright-baseline-ma.txt 2>&1
```

### Step 2: Inventory the functions to extract
Descriptor protocol:
- `applyDescriptorAccessMethod` — line 6545 (~250 lines)
- `applyAttributeAccessOverride` — line 6942

Method binding:
- `bindMethodForMemberAccess` — line 6795
- `bindFunctionToClassOrObject` — line 28247 (exposed on interface)

Member type resolution:
- `getTypeOfBoundMember` — line 2321 (exposed on interface, ~200 lines)
- `getTypeOfMember` — exposed on interface
- `getBoundMagicMethod` — line 2507 (exposed on interface)
- `getTypeOfMagicMethodCall` — exposed on interface
- `getGetterTypeFromProperty` — line 24517 (exposed on interface)
- `getCallbackProtocolType` — line 26342 (exposed on interface)

Helpers:
- `expandTypedKwargs` — line 2696
- `addTypeFormForSymbol` — line 4988

### Step 3: Create `memberAccess.ts`
Create `packages/pyright-internal/src/analyzer/memberAccess.ts`:
- Export each function with dependency params
- `getTypeOfBoundMember` is the central function — it dispatches to `applyDescriptorAccessMethod`, `applyAttributeAccessOverride`, and `bindMethodForMemberAccess`
- These functions call `assignType` — import from `typeAssignment.ts` (already extracted)
- These functions call `validateCallArgs` — still in `typeEvaluator.ts` at this point, accessed through `TypeEvaluator` interface

### Step 4: Verify no circular dependencies
Check that `memberAccess.ts` doesn't need to import from `typeEvaluator.ts` directly (only through the `TypeEvaluator` interface). The dependency should be:
```
memberAccess.ts → TypeEvaluator interface (typeEvaluatorTypes.ts)
memberAccess.ts → typeAssignment.ts (for assign functions, if called directly)
memberAccess.ts → TypeRegistry, TypeEvaluatorState
```

### Step 5: Update `typeEvaluator.ts`
- Remove moved functions
- Import from `memberAccess.ts`
- Update evaluator interface entries for exposed functions

### Step 6: Run tests
```bash
cd packages/pyright-internal && bun run test:norebuild > /tmp/pyright-after-ma.txt 2>&1
diff /tmp/pyright-baseline-ma.txt /tmp/pyright-after-ma.txt
```

### Step 7: Run linter
```bash
cd /Volumes/code/pyright && bun run check
```

## Success Criteria

- [x] `memberAccess.ts` exists with member access and descriptor functions
- [x] Full test suite passes
- [x] Linter passes
- [x] No circular imports

## Anti-Patterns

- **Don't extract member access assignment functions (`assignTypeToMemberAccessNode`, `assignTypeToMemberVariable`) here.** Those were scoped in pyr-yay (Type Assignment). If they weren't extracted there, they stay in the closure. REASON: member access RESOLUTION and member access ASSIGNMENT are different concerns — don't mix them.
- **Don't split `getTypeOfBoundMember` from its helper functions.** It calls `applyDescriptorAccessMethod` and `bindMethodForMemberAccess` directly — they move together. REASON: dense internal call graph.

## Log

- [2026-04-03T12:48:22Z] [Seth] Session start. Claiming task. Beginning Phase 1: dependency mapping via LSP.
- [2026-04-03T12:53:48Z] [Seth] Phase 1 complete. No cycles — all one-at-a-time extraction.

Tier 1 (leaves): expandTypedKwargs, addTypeFormForSymbol, applyAttributeAccessOverride, getTypeOfMagicMethodCall, getTypeOfMember, getGetterTypeFromProperty, bindFunctionToClassOrObject, getTypeOfBoundMember

Tier 2 (call into tier 1): getBoundMagicMethod, applyDescriptorAccessMethod, bindMethodForMemberAccess

Tier 3 (calls tier 2): getCallbackProtocolType

Nearby helpers to evaluate during extraction: isAsymmetricDescriptorClass, getAttributeAccessMember, isClassWithAsymmetricAttributeAccessor, partiallySpecializeBoundMethod
- [2026-04-03T13:12:44Z] [Seth] Phase 1 revised: getTypeOfClassMemberName (only called by getTypeOfBoundMember) creates a cycle with batch members. Extracting as cycle batch: getTypeOfBoundMember, getTypeOfClassMemberName, applyDescriptorAccessMethod, bindMethodForMemberAccess, applyAttributeAccessOverride + helpers getTypeOfMemberInternal, isAsymmetricDescriptorClass, getAttributeAccessMember, isClassWithAsymmetricAttributeAccessor, setSymbolAccessed, printObjectTypeForClass, narrowTypeBasedOnAssignment, validateSymbolIsTypeExpression. Then getBoundMagicMethod and getCallbackProtocolType as post-cycle.
- [2026-04-03T13:22:13Z] [Seth] Pausing mid-cycle batch. Functions in memberAccess.ts but NOT yet wired (cycle incomplete): applyAttributeAccessOverride, bindMethodForMemberAccess, applyDescriptorAccessMethod, validateSymbolIsTypeExpression, getTypeOfMemberInternal. Still need to write: getTypeOfClassMemberName (~300 lines, heaviest function), getTypeOfBoundMember (~180 lines). All non-cycle functions extracted and committed (9 commits). File compiles except for 2 forward refs to getTypeOfBoundMember. No test failures in any committed state.
- [2026-04-03T13:48:49Z] [Seth] All functions extracted and tests passing (2344/2344). npm run check clean. Pushed to remote.
