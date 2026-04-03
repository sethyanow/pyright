# Dependency Patterns for typeEvaluator.ts Extraction

## Closure Functions on the TypeEvaluator Interface

These are defined inside `createTypeEvaluator()` but exposed on the `TypeEvaluator` interface (see `typeEvaluatorTypes.ts`). After extraction, call them as `evaluator.xxx(...)`.

Common ones encountered during assignment extraction:
- `printType(type)` → `evaluator.printType(type)`
- `printSrcDestTypes(src, dest)` → `evaluator.printSrcDestTypes(src, dest)`
- `makeTopLevelTypeVarsConcrete(type)` → `evaluator.makeTopLevelTypeVarsConcrete(type)`
- `getCallbackProtocolType(objType, recursionCount)` → `evaluator.getCallbackProtocolType(objType, recursionCount)`
- `getBoundMagicMethod(...)` → `evaluator.getBoundMagicMethod(...)`
- `getEffectiveTypeOfSymbol(symbol)` → `evaluator.getEffectiveTypeOfSymbol(symbol)`
- `getTypeOfMember(memberInfo)` → `evaluator.getTypeOfMember(memberInfo)`
- `getTypeClassType()` → `evaluator.getTypeClassType()`
- `isFinalVariableDeclaration(decl)` → `evaluator.isFinalVariableDeclaration(decl)`
- `inferVarianceForClass(classType)` → `evaluator.inferVarianceForClass(classType)`
- `solveAndApplyConstraints(...)` → `evaluator.solveAndApplyConstraints(...)`
- `stripLiteralValue(type)` → `evaluator.stripLiteralValue(type)`
- `getEffectiveReturnType(funcType)` — closure-only function. Use `FunctionType.getEffectiveReturnType(type)` (from types.ts) as the primary path, with `evaluator.getInferredReturnType(type)` as fallback for functions that haven't been inferred yet. See the `getEffectiveReturnType` helper in typeAssignment.ts.

**How to verify:** `goToDefinition` on the call site. If it resolves to a line inside `createTypeEvaluator()` (lines ~568-25210), it's a closure function. Then check if it appears in the evaluator interface object (~line 25083). If yes, use `evaluator.xxx()`. If no, it needs to either be added to the interface or extracted too.

## Registry Access

The `TypeRegistry` holds pre-fetched type references. Access pattern is `registry.xxxClass`.

Known registry fields used by assignment functions:
- `registry.functionClass` — used by assignType (NewType handling, function-to-object assignment)
- `registry.methodClass` — used by assignType (method type assignment)
- `registry.noneTypeClass` — used by assignType (None-to-protocol assignment)
- `registry.strClass` — used by assignClass (TypedDict-to-Mapping), assignType (LiteralString)
- `registry.mappingClass` — used by assignClass (TypedDict-to-Mapping)
- `registry.dictClass` — used by assignClass (TypedDict-to-dict)
- `registry.boolClass` — used by assignFunction (TypeGuard return type)

## State Access

The `TypeEvaluatorState` holds mutable state for the evaluation session.

Known state fields used by assignment functions:
- `state.assignClassToSelfStack` — used by assignClassToSelf (push/pop), assignTypeArgs (read)

### State Wrappers (Closure Functions That Dissolve)

These closure functions in typeEvaluator.ts (~lines 570-610) are thin wrappers around `state.xxx()`. Extracted functions should call `state.xxx()` directly instead of going through the closure wrapper.

| Closure function | State method |
|---|---|
| `readTypeCache(node, flags)` | `state.readTypeCache(node, flags)` |
| `writeTypeCache(node, result, flags)` | `state.writeTypeCache(node, result, flags)` |
| `isTypeCached(node)` | `state.isTypeCached(node)` |
| `pushSymbolResolution(symbol, decl)` | `state.pushSymbolResolution(symbol, decl)` |
| `popSymbolResolution(symbol)` | `state.popSymbolResolution(symbol)` |
| `suppressDiagnostics(node, cb)` | `state.suppressDiagnostics(node, cb)` |
| `disableSpeculativeMode(cb)` | `state.disableSpeculativeMode(cb)` |
| `isSpeculativeModeInUse(node)` | `state.isSpeculativeModeInUse(node)` |
| `isNodeInReturnTypeInferenceContext(node)` | `state.isNodeInReturnTypeInferenceContext(node)` |
| `getCodeFlowAnalyzerForReturnTypeInferenceContext()` | `state.getCodeFlowAnalyzerForReturnTypeInferenceContext()` |

### Stored Dependencies on State

These were closure parameters or late-created objects, now stored on `TypeEvaluatorState`:

| Access | What it is |
|---|---|
| `state.importLookup` | The program's import resolver (was closure param to `createTypeEvaluator`) |
| `state.codeFlowEngine` | The code flow analysis engine (was closure const, created after evaluator interface) |
| `state.evaluatorOptions` | Evaluator configuration options |

## External Module Imports

Functions imported from other analyzer modules (not the closure):
- `constraintSolver.ts`: assignTypeVar, solveConstraints
- `constraintTracker.ts`: ConstraintTracker, ConstraintSet
- `constructors.ts`: createFunctionFromConstructor
- `protocols.ts`: assignClassToProtocol, assignModuleToProtocol
- `properties.ts`: assignProperty
- `tuples.ts`: assignTupleTypeArgs, makeTupleObject
- `typedDicts.ts`: assignTypedDictToTypedDict, getTypedDictMappingEquivalent, getTypedDictDictEquivalent
- `typeUtils.ts`: lookUpClassMember, getTypeVarArgsRecursive, sortTypes, requiresSpecialization, convertToInstance, convertToInstantiable, doForEachSubtype, makeTypeVarsBound, partiallySpecializeType, specializeForBaseClass, MemberAccessFlags, etc.
- `types.ts`: ClassType, TypeVarType, FunctionType, Type, isClass, isTypeVar, isUnion, isAnyOrUnknown, etc.
- `parameterUtils.ts`: getParamListDetails, ParamKind, ParamListDetails

## Symbols That Aren't Where You'd Expect

Confirmed during pyr-yay extraction — these tripped up import resolution:

| Symbol | NOT in | Actually in |
|---|---|---|
| `isPrivateOrProtectedName` | typeUtils | `symbolNameUtils.ts` |
| `isPositionOnlySeparator` | FunctionType namespace | standalone export in `types.ts` |
| `findSubtype` | (not exported from typeUtils) | implement locally or use `doForEachSubtype` |
| `isTypeVarSame` | types.ts | `typeUtils.ts` |
| `isNoneInstance` | types.ts | `typeUtils.ts` |
| `isLiteralType` (function) | types.ts | `typeUtils.ts` |
| `isLiteralLikeType` | types.ts | `typeUtils.ts` |
| `removeFromUnion` | typeUtils | `types.ts` |
| `isMethodType` | typeUtils | `types.ts` |
| `ConstraintSet` | types.ts | `constraintTracker.ts` |

Don't pre-solve imports. Add what you know, compile, fix what the compiler reports.

## The evaluatorInterface → evaluator Rename

Inside the closure, the evaluator interface is stored as `evaluatorInterface`. In extracted modules, the convention is to name the parameter `evaluator`. The rename is:
- Function parameter: `evaluator: TypeEvaluator`
- All references in the body: `evaluatorInterface` → `evaluator`

**Note:** Some external module calls pass `evaluatorInterface` as a first argument (e.g., `assignTypedDictToTypedDict(evaluatorInterface, ...)`). These become `evaluator` in the extracted code since the extracted function receives `evaluator` as its param.

## Module-Level Constants

Some functions reference module-level constants defined in typeEvaluator.ts (not in the closure). These need to be moved to the target module or imported:
- `typePromotions` — Map of type promotion rules (used by assignClass)
- `maxRecursiveTypeAliasRecursionCount` — recursion limit (used by assignType)
- `maxTypeRecursionCount` — from types.ts, already importable

## Delegation Patterns

When a function is extracted, its original location in typeEvaluator.ts becomes a delegate:

**For functions with many closure callers (e.g., assignType with ~20 call sites):**
```typescript
function assignType(destType: Type, srcType: Type, ...): boolean {
    return typeAssignment.assignType(evaluatorInterface, registry, state, destType, srcType, ...);
}
```

**For functions only called from the interface object:**
Replace the shorthand property with a lambda:
```typescript
isSpecialFormClass: (classType: ClassType, flags: AssignTypeFlags) =>
    typeAssignment.isSpecialFormClass(classType, flags),
```

Use `incomingCalls` to determine which pattern — many callers = local delegate, few callers = interface lambda only.

## Circular Import Avoidance

When a type or interface is defined in typeEvaluator.ts and needed by the extracted module, **redefine it locally** rather than importing from typeEvaluator.ts. Importing from typeEvaluator.ts creates a circular dependency (extracted module → typeEvaluator.ts → extracted module).

Example: `MemberAccessTypeResult` was defined as an exported interface in typeEvaluator.ts. memberAccess.ts needed it but couldn't import from typeEvaluator.ts, so it was redefined locally in memberAccess.ts.

## One-Liner Wrapper Dissolution

Some closure functions are one-liners wrapping already-extracted functions or external utilities. In extracted code, call the underlying function directly:

| Closure wrapper | Call directly |
|---|---|
| `narrowTypeBasedOnAssignment(decl, assigned)` | `typeAssignment.narrowTypeBasedOnAssignment(evaluator, registry, state, decl, assigned)` |
| `printObjectTypeForClass(type)` | `TypePrinter.printObjectTypeForClass(type, state.evaluatorOptions.printTypeFlags, returnTypeCallback)` |
| `getEffectiveReturnType(type)` | `FunctionType.getEffectiveReturnType(type) ?? evaluator.getInferredReturnType(type)` |

## Inventory Is a Starting Point

Skeleton inventories are starting points, not fixed scope. Functions not in the inventory may need to come along if they're the sole connector between batch members (e.g., getTypeOfClassMemberName wasn't in pyr-p1w's inventory but was the only caller of applyDescriptorAccessMethod and the only thing called by getTypeOfBoundMember). Use `incomingCalls` to discover these.
