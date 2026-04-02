/*
 * typeAssignment.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 *
 * Functions for type assignment, compatibility checking, and subtype
 * verification extracted from the createTypeEvaluator closure.
 */

import { appendArray } from '../common/collectionUtils';
import { assert } from '../common/debug';
import { DiagnosticAddendum } from '../common/diagnostic';
import { LocAddendum } from '../localization/localize';
import { ParamCategory } from '../parser/parseNodes';
import { isPrivateOrProtectedName } from './symbolNameUtils';
import { assignTypeVar } from './constraintSolver';
import { ConstraintSet, ConstraintTracker } from './constraintTracker';
import { createFunctionFromConstructor } from './constructors';
import { DeclarationType } from './declaration';
import {
    getParamListDetails,
    ParamKind,
    ParamListDetails,
    VirtualParamDetails,
} from './parameterUtils';
import { assignProperty } from './properties';
import { assignClassToProtocol, assignModuleToProtocol } from './protocols';
import { assignTupleTypeArgs, makeTupleObject } from './tuples';
import { AssignTypeFlags, TypeEvaluator } from './typeEvaluatorTypes';
import { TypeEvaluatorState } from './typeEvaluatorState';
import { TypeRegistry } from './typeRegistry';
import {
    assignTypedDictToTypedDict,
    getTypedDictDictEquivalent,
    getTypedDictMappingEquivalent,
} from './typedDicts';
import {
    AnyType,
    ClassType,
    FunctionParam,
    FunctionParamFlags,
    FunctionType,
    FunctionTypeFlags,
    InheritanceChain,
    isAnyOrUnknown,
    isClass,
    isClassInstance,
    isFunction,
    isFunctionOrOverloaded,
    isInstantiableClass,
    isModule,
    isNever,
    isOverloaded,
    isParamSpec,
    isTypeSame,
    isTypeVar,
    isTypeVarTuple,
    isUnbound,
    isMethodType,
    isPositionOnlySeparator,
    isUnion,
    isUnknown,
    isUnpacked,
    isUnpackedClass,
    isUnpackedTypeVarTuple,
    maxTypeRecursionCount,
    OverloadedType,
    removeFromUnion,
    TupleTypeArg,
    Type,
    TypeAliasInfo,
    TypeBase,
    TypeVarType,
    UnionType,
    UnknownType,
    Variance,
    combineTypes,
} from './types';
import {
    combineTupleTypeArgs,
    containsLiteralType,
    convertToInstance,
    convertToInstantiable,
    doForEachSubtype,
    getTypeCondition,
    getTypeVarArgsRecursive,
    getTypeVarScopeId,
    getTypeVarScopeIds,
    isEffectivelyInstantiable,
    isEllipsisType,
    isIncompleteUnknown,
    isMemberReadOnly,
    isNoneTypeClass,
    isOptionalType,
    isLiteralLikeType,
    isLiteralType,
    isNoneInstance,
    isTupleClass,
    isTypeVarSame,
    lookUpClassMember,
    makeFunctionTypeVarsBound,
    makeTypeVarsBound,
    mapSubtypes,
    MemberAccessFlags,
    partiallySpecializeType,
    requiresSpecialization,
    sortTypes,
    specializeForBaseClass,
    transformPossibleRecursiveTypeAlias,
} from './typeUtils';

// Type promotions from PEP 484 (duplicated from typeEvaluator.ts module scope).
const typePromotions: Map<string, string[]> = new Map([
    ['builtins.float', ['builtins.int']],
    ['builtins.complex', ['builtins.float', 'builtins.int']],
    ['builtins.bytes', ['builtins.bytearray', 'builtins.memoryview']],
]);

// Recursion limit for recursive type alias comparisons.
const maxRecursiveTypeAliasRecursionCount = 14;

// Local helper — findSubtype is not exported from typeUtils.
function findSubtype(type: Type, predicate: (subtype: Type) => boolean): Type | undefined {
    if (isUnion(type)) {
        return type.priv.subtypes.find(predicate);
    }
    return predicate(type) ? type : undefined;
}

export function isSpecialFormClass(classType: ClassType, flags: AssignTypeFlags): boolean {
    if ((flags & AssignTypeFlags.AllowIsinstanceSpecialForms) !== 0) {
        return false;
    }

    return ClassType.isSpecialFormClass(classType);
}

// Finds unsolved type variables in the destType and establishes constraints
// in the constraint tracker for them based on the srcType.
export function setConstraintsForFreeTypeVars(
    destType: Type,
    srcType: UnknownType | AnyType,
    constraints: ConstraintTracker
) {
    const typeVars = getTypeVarArgsRecursive(destType);
    typeVars.forEach((typeVar) => {
        if (!TypeVarType.isBound(typeVar) && !constraints.getMainConstraintSet().getTypeVar(typeVar)) {
            // Don't set ParamSpecs or TypeVarTuples.
            if (!isParamSpec(srcType) && !isTypeVarTuple(srcType)) {
                constraints.setBounds(typeVar, srcType);
            }
        }
    });
}

// Determines whether we need to pack some of the source positionals
// into a tuple that matches a variadic *args parameter in the destination.
export function adjustSourceParamDetailsForDestVariadic(
    evaluator: TypeEvaluator,
    srcDetails: ParamListDetails,
    destDetails: ParamListDetails
) {
    // If there is no *args parameter in the dest, we have nothing to do.
    if (destDetails.argsIndex === undefined) {
        return;
    }

    // If the *args parameter isn't an unpacked TypeVarTuple or tuple,
    // we have nothing to do.
    if (!isUnpacked(destDetails.params[destDetails.argsIndex].type)) {
        return;
    }

    // If the source doesn't have enough positional parameters, we have nothing to do.
    if (srcDetails.params.length < destDetails.argsIndex) {
        return;
    }

    let srcLastToPackIndex = srcDetails.params.findIndex((p, i) => {
        assert(destDetails.argsIndex !== undefined);
        return i >= destDetails.argsIndex && p.kind === ParamKind.Keyword;
    });
    if (srcLastToPackIndex < 0) {
        srcLastToPackIndex = srcDetails.params.length;
    }

    // If both the source and dest have an *args parameter but the dest's is
    // in a later position, then we can't assign the source's *args to the dest.
    // Don't make any adjustment in this case.
    if (srcDetails.argsIndex !== undefined && destDetails.argsIndex > srcDetails.argsIndex) {
        return;
    }

    const destFirstNonPositional = destDetails.firstKeywordOnlyIndex ?? destDetails.params.length;
    const suffixLength = destFirstNonPositional - destDetails.argsIndex - 1;
    const srcPositionalsToPack = srcDetails.params.slice(destDetails.argsIndex, srcLastToPackIndex - suffixLength);
    const srcTupleTypes: TupleTypeArg[] = [];
    srcPositionalsToPack.forEach((entry) => {
        if (entry.param.category === ParamCategory.ArgsList) {
            if (isUnpackedTypeVarTuple(entry.type)) {
                srcTupleTypes.push({ type: entry.type, isUnbounded: false });
            } else if (isUnpackedClass(entry.type) && entry.type.priv.tupleTypeArgs) {
                appendArray(srcTupleTypes, entry.type.priv.tupleTypeArgs);
            } else {
                srcTupleTypes.push({ type: entry.type, isUnbounded: true });
            }
        } else {
            srcTupleTypes.push({ type: entry.type, isUnbounded: false, isOptional: !!entry.defaultType });
        }
    });

    if (srcTupleTypes.length !== 1 || !isTypeVarTuple(srcTupleTypes[0].type)) {
        const srcPositionalsType = makeTupleObject(evaluator, srcTupleTypes, /* isUnpacked */ true);

        // Snip out the portion of the source positionals that map to the variadic
        // dest parameter and replace it with a single parameter that is typed as a
        // tuple containing the individual types of the replaced parameters.
        srcDetails.params = [
            ...srcDetails.params.slice(0, destDetails.argsIndex),
            {
                param: FunctionParam.create(
                    ParamCategory.ArgsList,
                    srcPositionalsType,
                    FunctionParamFlags.NameSynthesized | FunctionParamFlags.TypeDeclared,
                    '_arg_combined'
                ),
                type: srcPositionalsType,
                declaredType: srcPositionalsType,
                index: -1,
                kind: ParamKind.Positional,
            },
            ...srcDetails.params.slice(
                destDetails.argsIndex + srcPositionalsToPack.length,
                srcDetails.params.length
            ),
        ];

        const argsIndex = srcDetails.params.findIndex((param) => param.param.category === ParamCategory.ArgsList);
        srcDetails.argsIndex = argsIndex >= 0 ? argsIndex : undefined;

        const kwargsIndex = srcDetails.params.findIndex(
            (param) => param.param.category === ParamCategory.KwargsDict
        );
        srcDetails.kwargsIndex = kwargsIndex >= 0 ? kwargsIndex : undefined;

        const firstKeywordOnlyIndex = srcDetails.params.findIndex((param) => param.kind === ParamKind.Keyword);
        srcDetails.firstKeywordOnlyIndex = firstKeywordOnlyIndex >= 0 ? firstKeywordOnlyIndex : undefined;

        srcDetails.positionOnlyParamCount = Math.max(
            0,
            srcDetails.params.findIndex(
                (p) =>
                    p.kind !== ParamKind.Positional || p.param.category !== ParamCategory.Simple || !!p.defaultType
            )
        );
    }
}

// Determines whether a type is "subsumed by" (i.e. is a proper subtype of) another type.
export function isTypeSubsumedByOtherType(
    evaluator: TypeEvaluator,
    registry: TypeRegistry,
    state: TypeEvaluatorState,
    type: Type,
    otherType: Type,
    allowAnyToSubsume: boolean,
    recursionCount = 0
) {
    const concreteType = evaluator.makeTopLevelTypeVarsConcrete(type);
    const otherSubtypes = isUnion(otherType) ? otherType.priv.subtypes : [otherType];

    for (const otherSubtype of otherSubtypes) {
        if (isTypeSame(otherSubtype, type)) {
            continue;
        }

        if (isAnyOrUnknown(otherSubtype)) {
            if (allowAnyToSubsume) {
                return true;
            }
        } else if (isProperSubtype(evaluator, registry, state, otherSubtype, concreteType, recursionCount)) {
            return true;
        }
    }

    return false;
}

// Determines whether the srcType is a subtype of destType but the converse
// is not true.
export function isProperSubtype(
    evaluator: TypeEvaluator,
    registry: TypeRegistry,
    state: TypeEvaluatorState,
    destType: Type,
    srcType: Type,
    recursionCount: number
) {
    // If the destType has a condition, don't consider the srcType a proper subtype.
    if (destType.props?.condition) {
        return false;
    }

    // Shortcut the check if either type is Any or Unknown.
    if (isAnyOrUnknown(destType) || isAnyOrUnknown(srcType)) {
        return true;
    }

    // Shortcut the check if either type is a class whose hierarchy contains an unknown type.
    if (isClass(destType) && destType.shared.mro.some((mro) => isAnyOrUnknown(mro))) {
        return true;
    }

    if (isClass(srcType) && srcType.shared.mro.some((mro) => isAnyOrUnknown(mro))) {
        return true;
    }

    return (
        assignType(
            evaluator,
            registry,
            state,
            destType,
            srcType,
            /* diag */ undefined,
            /* constraints */ undefined,
            AssignTypeFlags.Default,
            recursionCount
        ) &&
        !assignType(
            evaluator,
            registry,
            state,
            srcType,
            destType,
            /* diag */ undefined,
            /* constraints */ undefined,
            AssignTypeFlags.Default,
            recursionCount
        )
    );
}

// Determines whether a recursive type alias can be assigned to itself
// given the source and dest type args and computed variance for its type params.
export function assignRecursiveTypeAliasToSelf(
    evaluator: TypeEvaluator,
    registry: TypeRegistry,
    state: TypeEvaluatorState,
    destAliasInfo: TypeAliasInfo,
    srcAliasInfo: TypeAliasInfo,
    diag?: DiagnosticAddendum,
    constraints?: ConstraintTracker,
    flags = AssignTypeFlags.Default,
    recursionCount = 0
) {
    assert(destAliasInfo.typeArgs !== undefined);
    assert(srcAliasInfo.typeArgs !== undefined);

    let isAssignable = true;
    const srcTypeArgs = srcAliasInfo.typeArgs!;
    const variances = destAliasInfo.shared.computedVariance;

    destAliasInfo.typeArgs!.forEach((destTypeArg, index) => {
        const srcTypeArg = index < srcTypeArgs.length ? srcTypeArgs[index] : UnknownType.create();

        let adjFlags = flags;
        const variance = variances && index < variances.length ? variances[index] : Variance.Covariant;

        if (variance === Variance.Invariant) {
            adjFlags |= AssignTypeFlags.Invariant;
        } else if (variance === Variance.Contravariant) {
            adjFlags ^= AssignTypeFlags.Contravariant;
        }

        if (!assignType(evaluator, registry, state, destTypeArg, srcTypeArg, diag, constraints, adjFlags, recursionCount)) {
            isAssignable = false;
        }
    });

    return isAssignable;
}

export function assignConditionalTypeToTypeVar(
    evaluator: TypeEvaluator,
    registry: TypeRegistry,
    state: TypeEvaluatorState,
    destType: TypeVarType,
    srcType: Type,
    recursionCount: number
): boolean {
    // The srcType is assignable only if all of its subtypes are assignable.
    return !findSubtype(srcType, (srcSubtype) => {
        if (isTypeSame(destType, srcSubtype, { ignorePseudoGeneric: true }, recursionCount)) {
            return false;
        }

        if (isIncompleteUnknown(srcSubtype)) {
            return false;
        }

        const destTypeVarName = TypeVarType.getNameWithScope(destType);

        // Determine which conditions on this type apply to this type variable.
        const applicableConditions = (getTypeCondition(srcSubtype) ?? []).filter(
            (constraint) => constraint.typeVar.priv.nameWithScope === destTypeVarName
        );

        // If there are no applicable conditions, it's not assignable.
        if (applicableConditions.length === 0) {
            return true;
        }

        return !applicableConditions.some((condition) => {
            if (condition.typeVar.priv.nameWithScope === TypeVarType.getNameWithScope(destType)) {
                if (destType.shared.boundType) {
                    assert(
                        condition.constraintIndex === 0,
                        'Expected constraint for bound TypeVar to have index of 0'
                    );

                    return assignType(
                        evaluator,
                        registry,
                        state,
                        destType.shared.boundType,
                        srcSubtype,
                        /* diag */ undefined,
                        /* constraints */ undefined,
                        AssignTypeFlags.Default,
                        recursionCount
                    );
                }

                if (TypeVarType.hasConstraints(destType)) {
                    assert(
                        condition.constraintIndex < destType.shared.constraints.length,
                        'Constraint for constrained TypeVar is out of bounds'
                    );

                    return assignType(
                        evaluator,
                        registry,
                        state,
                        destType.shared.constraints[condition.constraintIndex],
                        srcSubtype,
                        /* diag */ undefined,
                        /* constraints */ undefined,
                        AssignTypeFlags.Default,
                        recursionCount
                    );
                }

                // This is a non-bound and non-constrained type variable with a matching condition.
                return true;
            }

            return false;
        });
    });
}

export function assignParam(
    evaluator: TypeEvaluator,
    registry: TypeRegistry,
    state: TypeEvaluatorState,
    destType: Type,
    srcType: Type,
    paramIndex: number | undefined,
    diag: DiagnosticAddendum | undefined,
    constraints: ConstraintTracker,
    flags: AssignTypeFlags,
    recursionCount: number
) {
    if (isTypeVarTuple(destType) && !isUnpacked(srcType)) {
        return false;
    }

    let specializedSrcType = srcType;
    let specializedDestType = destType;
    let doSpecializationStep = false;

    if ((flags & AssignTypeFlags.OverloadOverlap) === 0) {
        const isFirstPass = (flags & AssignTypeFlags.ArgAssignmentFirstPass) !== 0;

        if ((flags & AssignTypeFlags.Contravariant) === 0) {
            if (!isFirstPass) {
                specializedDestType = evaluator.solveAndApplyConstraints(
                    destType,
                    constraints,
                    /* applyOptions */ undefined,
                    { useLowerBoundOnly: true }
                );
            }
            doSpecializationStep = requiresSpecialization(specializedDestType);
        } else {
            if (!isFirstPass) {
                specializedSrcType = evaluator.solveAndApplyConstraints(srcType, constraints, /* applyOptions */ undefined, {
                    useLowerBoundOnly: true,
                });
            }
            doSpecializationStep = requiresSpecialization(specializedSrcType);
        }
    }

    // Is an additional specialization step required?
    if (doSpecializationStep) {
        if (
            assignType(
                evaluator,
                registry,
                state,
                specializedSrcType,
                specializedDestType,
                /* diag */ undefined,
                constraints,
                (flags ^ AssignTypeFlags.Contravariant) | AssignTypeFlags.RetainLiteralsForTypeVar,
                recursionCount
            )
        ) {
            specializedDestType = evaluator.solveAndApplyConstraints(destType, constraints);
        }
    }

    if (
        !assignType(
            evaluator,
            registry,
            state,
            specializedSrcType,
            specializedDestType,
            diag?.createAddendum(),
            constraints,
            flags,
            recursionCount
        )
    ) {
        if (diag && paramIndex !== undefined) {
            diag.addMessage(
                LocAddendum.paramAssignment().format({
                    index: paramIndex + 1,
                    sourceType: evaluator.printType(destType),
                    destType: evaluator.printType(srcType),
                })
            );
        }

        return false;
    }

    return true;
}

export function assignClass(
    evaluator: TypeEvaluator,
    registry: TypeRegistry,
    state: TypeEvaluatorState,
    destType: ClassType,
    srcType: ClassType,
    diag: DiagnosticAddendum | undefined,
    constraints: ConstraintTracker | undefined,
    flags: AssignTypeFlags,
    recursionCount: number,
    reportErrorsUsingObjType: boolean
): boolean {
    if (ClassType.isHierarchyPartiallyEvaluated(destType) || ClassType.isHierarchyPartiallyEvaluated(srcType)) {
        return true;
    }

    if (ClassType.isTypedDictClass(srcType)) {
        if (ClassType.isTypedDictClass(destType) && !ClassType.isSameGenericClass(destType, srcType)) {
            if (!assignTypedDictToTypedDict(evaluator, destType, srcType, diag, constraints, flags, recursionCount)) {
                return false;
            }
            if ((flags & AssignTypeFlags.Invariant) !== 0) {
                return assignTypedDictToTypedDict(evaluator, srcType, destType, undefined, undefined, flags, recursionCount);
            }
            return true;
        }

        if (ClassType.isBuiltIn(destType, 'Mapping')) {
            const mappingValueType = getTypedDictMappingEquivalent(evaluator, srcType);
            if (mappingValueType && registry.mappingClass && isInstantiableClass(registry.mappingClass) &&
                registry.strClass && isInstantiableClass(registry.strClass)) {
                srcType = ClassType.specialize(registry.mappingClass, [
                    ClassType.cloneAsInstance(registry.strClass), mappingValueType,
                ]);
            }
        } else if (ClassType.isBuiltIn(destType, ['dict', 'MutableMapping'])) {
            const dictValueType = getTypedDictDictEquivalent(evaluator, srcType, recursionCount);
            if (dictValueType && registry.dictClass && isInstantiableClass(registry.dictClass) &&
                registry.strClass && isInstantiableClass(registry.strClass)) {
                srcType = ClassType.specialize(registry.dictClass, [
                    ClassType.cloneAsInstance(registry.strClass), dictValueType,
                ]);
            }
        }
    }

    if (destType.priv.includePromotions) {
        const promotionList = typePromotions.get(destType.shared.fullName);
        if (promotionList && promotionList.some((srcName) =>
            srcType.shared.mro.some((mroClass) => isClass(mroClass) && srcName === mroClass.shared.fullName)
        )) {
            if ((flags & AssignTypeFlags.Invariant) === 0) {
                return true;
            }
        }
    }

    const inheritanceChain: InheritanceChain = [];
    const isDerivedFrom = ClassType.isDerivedFrom(srcType, destType, inheritanceChain);

    if (ClassType.isProtocolClass(destType) && !isDerivedFrom) {
        if (!assignClassToProtocol(evaluator, destType, ClassType.cloneAsInstance(srcType),
            diag?.createAddendum(), constraints, flags, recursionCount)) {
            diag?.addMessage(LocAddendum.protocolIncompatible().format({
                sourceType: evaluator.printType(convertToInstance(srcType)),
                destType: evaluator.printType(convertToInstance(destType)),
            }));
            return false;
        }
        return true;
    }

    if ((flags & AssignTypeFlags.Invariant) === 0 || ClassType.isSameGenericClass(srcType, destType)) {
        if (isDerivedFrom) {
            assert(inheritanceChain.length > 0);
            if (assignClassWithTypeArgs(evaluator, registry, state, destType, srcType, inheritanceChain,
                diag?.createAddendum(), constraints, flags, recursionCount)) {
                return true;
            }
        }
    }

    if (ClassType.isBuiltIn(destType, 'object')) {
        if ((flags & AssignTypeFlags.Invariant) === 0) {
            return true;
        }
    }

    if (diag) {
        const destErrorType = reportErrorsUsingObjType ? ClassType.cloneAsInstance(destType) : destType;
        const srcErrorType = reportErrorsUsingObjType ? ClassType.cloneAsInstance(srcType) : srcType;
        let destErrorTypeText = evaluator.printType(destErrorType);
        let srcErrorTypeText = evaluator.printType(srcErrorType);
        if (destErrorTypeText === srcErrorTypeText && destType.shared.fullName && srcType.shared.fullName) {
            destErrorTypeText = destType.shared.fullName;
            srcErrorTypeText = srcType.shared.fullName;
        }
        diag?.addMessage(LocAddendum.typeIncompatible().format({
            sourceType: srcErrorTypeText, destType: destErrorTypeText,
        }));
        if (ClassType.isBuiltIn(destType, 'bytes')) {
            const promotions = typePromotions.get(destType.shared.fullName);
            if (promotions && promotions.some((name) => name === srcType.shared.fullName)) {
                diag?.addMessage(LocAddendum.bytesTypePromotions());
            }
        }
    }

    return false;
}

export function assignClassToSelf(
    evaluator: TypeEvaluator,
    registry: TypeRegistry,
    state: TypeEvaluatorState,
    destType: ClassType,
    srcType: ClassType,
    assumedVariance: Variance,
    ignoreBaseClassVariance = true,
    recursionCount = 0
): boolean {
    assert(ClassType.isSameGenericClass(destType, srcType));
    assert(destType.shared.typeParams.length > 0);

    srcType = makeTypeVarsBound(srcType, getTypeVarScopeIds(srcType));
    destType = makeTypeVarsBound(destType, getTypeVarScopeIds(destType));

    let isAssignable = true;

    try {
        state.assignClassToSelfStack.push({ class: destType, assumedVariance });

        ClassType.getSymbolTable(destType).forEach((symbol, name) => {
            if (!isAssignable || symbol.isIgnoredForProtocolMatch()) {
                return;
            }
            if (name === '__new__' || name === '__init__') {
                return;
            }

            const memberInfo = lookUpClassMember(srcType, name);
            assert(memberInfo !== undefined);

            let destMemberType = evaluator.getEffectiveTypeOfSymbol(symbol);
            const srcMemberType = evaluator.getTypeOfMember(memberInfo!);
            destMemberType = partiallySpecializeType(destMemberType, destType, evaluator.getTypeClassType());

            if (isClassInstance(destMemberType) && ClassType.isPropertyClass(destMemberType) &&
                isClassInstance(srcMemberType) && ClassType.isPropertyClass(srcMemberType)) {
                if (!assignProperty(evaluator, ClassType.cloneAsInstantiable(destMemberType),
                    ClassType.cloneAsInstantiable(srcMemberType), destType, srcType,
                    undefined, undefined, undefined, recursionCount)) {
                    isAssignable = false;
                }
            } else {
                const primaryDecl = symbol.getDeclarations()[0];
                let flagsLocal = AssignTypeFlags.Default;
                if (primaryDecl?.type === DeclarationType.Variable &&
                    !evaluator.isFinalVariableDeclaration(primaryDecl) &&
                    !isMemberReadOnly(destType, name)) {
                    if (!isPrivateOrProtectedName(name)) {
                        flagsLocal |= AssignTypeFlags.Invariant;
                    }
                }
                if (!assignType(evaluator, registry, state, destMemberType, srcMemberType,
                    undefined, undefined, flagsLocal | AssignTypeFlags.SkipSelfClsParamCheck, recursionCount)) {
                    isAssignable = false;
                }
            }
        });

        if (!isAssignable) {
            return false;
        }

        destType.shared.baseClasses.forEach((baseClass) => {
            if (!isAssignable || !isInstantiableClass(baseClass) ||
                ClassType.isBuiltIn(baseClass, ['object', 'Protocol', 'Generic']) ||
                baseClass.shared.typeParams.length === 0) {
                return;
            }

            const specializedDestBaseClass = specializeForBaseClass(destType, baseClass);
            const specializedSrcBaseClass = specializeForBaseClass(srcType, baseClass);

            if (!ignoreBaseClassVariance) {
                specializedDestBaseClass.shared.typeParams.forEach((param, index) => {
                    if (isParamSpec(param) || isTypeVarTuple(param) || param.shared.isSynthesized) {
                        return;
                    }
                    if (!specializedSrcBaseClass.priv.typeArgs || index >= specializedSrcBaseClass.priv.typeArgs.length ||
                        !specializedDestBaseClass.priv.typeArgs || index >= specializedDestBaseClass.priv.typeArgs.length) {
                        return;
                    }
                    const paramVariance = param.shared.declaredVariance;
                    if (isTypeVar(specializedSrcBaseClass.priv.typeArgs[index])) {
                        if (paramVariance === Variance.Invariant || paramVariance === Variance.Contravariant) {
                            isAssignable = false;
                            return;
                        }
                    }
                    if (isTypeVar(specializedDestBaseClass.priv.typeArgs[index])) {
                        if (paramVariance === Variance.Invariant || paramVariance === Variance.Covariant) {
                            isAssignable = false;
                            return;
                        }
                    }
                });
            }

            if (!isAssignable) {
                return;
            }

            if (ClassType.isTupleClass(specializedDestBaseClass)) {
                return;
            }

            if (!assignClassToSelf(evaluator, registry, state, specializedDestBaseClass, specializedSrcBaseClass,
                assumedVariance, ignoreBaseClassVariance, recursionCount)) {
                isAssignable = false;
            }
        });

        return isAssignable;
    } finally {
        state.assignClassToSelfStack.pop();
    }
}

export function assignClassWithTypeArgs(
    evaluator: TypeEvaluator,
    registry: TypeRegistry,
    state: TypeEvaluatorState,
    destType: ClassType,
    srcType: ClassType,
    inheritanceChain: InheritanceChain,
    diag: DiagnosticAddendum | undefined,
    constraints: ConstraintTracker | undefined,
    flags: AssignTypeFlags,
    recursionCount: number
): boolean {
    let curSrcType = srcType;
    let prevSrcType: ClassType | undefined;

    evaluator.inferVarianceForClass(destType);

    if ((flags & AssignTypeFlags.Invariant) !== 0) {
        const srcIsLiteral = isLiteralLikeType(srcType);
        const destIsLiteral = isLiteralLikeType(destType);
        if (srcIsLiteral !== destIsLiteral) {
            return false;
        }
    }

    for (let ancestorIndex = inheritanceChain.length - 1; ancestorIndex >= 0; ancestorIndex--) {
        const ancestorTypeRaw = inheritanceChain[ancestorIndex];

        if (isUnknown(ancestorTypeRaw)) {
            return !isNoneTypeClass(destType);
        }

        const ancestorType = ancestorTypeRaw as ClassType;

        if (ancestorIndex < inheritanceChain.length - 1) {
            let effectiveCurSrcType = curSrcType;
            if (ClassType.isBuiltIn(curSrcType, 'NamedTuple') &&
                ClassType.isBuiltIn(ancestorType, 'tuple') && prevSrcType) {
                effectiveCurSrcType = prevSrcType;
            }
            curSrcType = specializeForBaseClass(effectiveCurSrcType, ancestorType);
        }

        const ancestorTypeParams = ClassType.getTypeParams(ancestorType);
        if (ancestorTypeParams.length === 0) {
            continue;
        }

        if (!ancestorType.priv.typeArgs) {
            return true;
        }

        prevSrcType = curSrcType;
    }

    if (destType.priv.tupleTypeArgs && curSrcType.priv.tupleTypeArgs) {
        return assignTupleTypeArgs(evaluator, destType, curSrcType, diag, constraints, flags, recursionCount);
    }

    if (destType.priv.typeArgs) {
        return assignTypeArgs(evaluator, registry, state, destType, curSrcType,
            (flags & AssignTypeFlags.Invariant) === 0 ? diag : undefined, constraints, flags, recursionCount);
    }

    if (constraints && curSrcType.priv.typeArgs) {
        const srcTypeArgs = curSrcType.priv.typeArgs;
        for (let i = 0; i < destType.shared.typeParams.length; i++) {
            let typeArgType: Type;
            const typeParam = destType.shared.typeParams[i];
            const variance = TypeVarType.getVariance(typeParam);

            if (curSrcType.priv.tupleTypeArgs) {
                typeArgType = convertToInstance(
                    makeTupleObject(evaluator, curSrcType.priv.tupleTypeArgs, true)
                );
            } else {
                typeArgType = i < srcTypeArgs.length ? srcTypeArgs[i] : UnknownType.create();
            }

            constraints.setBounds(
                typeParam,
                variance !== Variance.Contravariant ? typeArgType : undefined,
                variance !== Variance.Covariant ? typeArgType : undefined,
                true
            );
        }
    }

    return true;
}

export function assignTypeArgs(
    evaluator: TypeEvaluator,
    registry: TypeRegistry,
    state: TypeEvaluatorState,
    destType: ClassType,
    srcType: ClassType,
    diag: DiagnosticAddendum | undefined,
    constraints: ConstraintTracker | undefined,
    flags: AssignTypeFlags,
    recursionCount: number
): boolean {
    assert(ClassType.isSameGenericClass(destType, srcType));

    evaluator.inferVarianceForClass(destType);

    const destTypeParams = ClassType.getTypeParams(destType);
    let destTypeArgs: Type[];
    let srcTypeArgs: Type[] | undefined;

    const assignClassToSelfInfo = state.assignClassToSelfStack.find((info) =>
        ClassType.isSameGenericClass(info.class, destType)
    );
    const assumedVariance = assignClassToSelfInfo?.assumedVariance;

    if (!destType.priv.typeArgs || !srcType.priv.typeArgs) {
        return true;
    }

    if (ClassType.isTupleClass(destType)) {
        destTypeArgs = destType.priv.tupleTypeArgs?.map((t) => t.type) ?? [];
        srcTypeArgs = srcType.priv.tupleTypeArgs?.map((t) => t.type);
    } else {
        destTypeArgs = destType.priv.typeArgs;
        srcTypeArgs = srcType.priv.typeArgs;
    }

    let isCompatible = true;

    srcTypeArgs?.forEach((srcTypeArg, srcArgIndex) => {
        const destArgIndex = srcArgIndex >= destTypeArgs.length ? destTypeArgs.length - 1 : srcArgIndex;
        const destTypeArg = destArgIndex >= 0 ? destTypeArgs[destArgIndex] : UnknownType.create();
        const destTypeParam = destArgIndex < destTypeParams.length ? destTypeParams[destArgIndex] : undefined;
        const assignmentDiag = new DiagnosticAddendum();
        const variance = assumedVariance ?? (destTypeParam ? TypeVarType.getVariance(destTypeParam) : Variance.Covariant);
        let effectiveFlags: AssignTypeFlags;
        let errorSource: () => { format: (args: { name: string; sourceType: string; destType: string }) => string };
        let includeDiagAddendum = true;

        if (variance === Variance.Covariant) {
            effectiveFlags = flags | AssignTypeFlags.RetainLiteralsForTypeVar;
            errorSource = LocAddendum.typeVarIsCovariant;
        } else if (variance === Variance.Contravariant) {
            effectiveFlags = flags | AssignTypeFlags.Contravariant | AssignTypeFlags.RetainLiteralsForTypeVar;
            errorSource = LocAddendum.typeVarIsContravariant;
        } else {
            effectiveFlags = flags | AssignTypeFlags.Invariant | AssignTypeFlags.RetainLiteralsForTypeVar;
            errorSource = LocAddendum.typeVarIsInvariant;
            includeDiagAddendum = false;
        }

        if (ClassType.isBuiltIn(destType, 'TypeForm')) {
            effectiveFlags |= AssignTypeFlags.RetainLiteralsForTypeVar;
        }

        if (!assignType(evaluator, registry, state,
            variance === Variance.Contravariant ? srcTypeArg : destTypeArg,
            variance === Variance.Contravariant ? destTypeArg : srcTypeArg,
            assignmentDiag, constraints, effectiveFlags, recursionCount)) {
            if (!ClassType.isPseudoGenericClass(destType)) {
                if (diag) {
                    if (destTypeParam) {
                        const childDiag = diag.createAddendum();
                        childDiag.addMessage(errorSource().format({
                            name: TypeVarType.getReadableName(destTypeParam),
                            ...evaluator.printSrcDestTypes(srcTypeArg, destTypeArg),
                        }));
                        if (includeDiagAddendum) {
                            childDiag.addAddendum(assignmentDiag);
                        }
                        if (isCompatible && ClassType.isSameGenericClass(destType, srcType)) {
                            if (ClassType.isBuiltIn(destType, 'dict') && srcArgIndex === 1) {
                                childDiag.addMessage(LocAddendum.invariantSuggestionDict());
                            } else if (ClassType.isBuiltIn(destType, 'list')) {
                                childDiag.addMessage(LocAddendum.invariantSuggestionList());
                            } else if (ClassType.isBuiltIn(destType, 'set')) {
                                childDiag.addMessage(LocAddendum.invariantSuggestionSet());
                            }
                        }
                    } else {
                        diag.addAddendum(assignmentDiag);
                    }
                }
                isCompatible = false;
            }
        }
    });

    return isCompatible;
}

export function assignFromUnionType(
    evaluator: TypeEvaluator,
    registry: TypeRegistry,
    state: TypeEvaluatorState,
    destType: Type,
    srcType: UnionType,
    diag: DiagnosticAddendum | undefined,
    constraints: ConstraintTracker | undefined,
    flags: AssignTypeFlags,
    recursionCount: number
): boolean {
    // Start by checking for an exact match.
    if (isTypeSame(srcType, destType, {}, recursionCount)) {
        return true;
    }

    if (
        (flags & AssignTypeFlags.OverloadOverlap) !== 0 &&
        srcType.priv.subtypes.some((subtype) => isAnyOrUnknown(subtype))
    ) {
        return false;
    }

    let sortedSrcTypes: Type[] = sortTypes(srcType.priv.subtypes);
    let matchedSomeSubtypes = false;

    if (isUnion(destType)) {
        const nonAnySubtypes = destType.priv.subtypes.filter((t) => !isAnyOrUnknown(t));
        if (nonAnySubtypes.length === 1 && isTypeVar(nonAnySubtypes[0])) {
            assignType(evaluator, registry, state, nonAnySubtypes[0], srcType, undefined, constraints, flags, recursionCount);
            return true;
        }

        const remainingDestSubtypes: Type[] = [];
        let remainingSrcSubtypes: Type[] = sortedSrcTypes;
        let canUseFastPath = true;

        sortTypes(destType.priv.subtypes).forEach((destSubtype) => {
            if (requiresSpecialization(destSubtype)) {
                remainingDestSubtypes.push(destSubtype);
            } else {
                const srcTypeIndex = remainingSrcSubtypes.findIndex((srcSubtype) =>
                    isTypeSame(srcSubtype, destSubtype, {}, recursionCount)
                );
                if (srcTypeIndex >= 0) {
                    remainingSrcSubtypes.splice(srcTypeIndex, 1);
                    matchedSomeSubtypes = true;
                } else {
                    remainingDestSubtypes.push(destSubtype);
                }
            }
        });

        remainingSrcSubtypes.forEach((srcSubtype) => {
            const destTypeIndex = remainingDestSubtypes.findIndex((destSubtype) => {
                if (isTypeSame(destSubtype, srcSubtype)) {
                    return true;
                }
                if (isClass(srcSubtype) && isClass(destSubtype) &&
                    TypeBase.isInstance(srcSubtype) === TypeBase.isInstance(destSubtype)) {
                    if (ClassType.isSameGenericClass(srcSubtype, destSubtype)) {
                        return true;
                    }
                    if (ClassType.isTypedDictClass(srcSubtype) && ClassType.isTypedDictClass(destSubtype)) {
                        if (assignType(evaluator, registry, state, srcSubtype, destSubtype,
                            undefined, undefined, flags, recursionCount)) {
                            return true;
                        }
                    }
                }
                if (isFunctionOrOverloaded(srcSubtype) && isFunctionOrOverloaded(destSubtype)) {
                    return true;
                }
                return false;
            });

            if (destTypeIndex >= 0) {
                if (assignType(evaluator, registry, state, remainingDestSubtypes[destTypeIndex], srcSubtype,
                    undefined, constraints, flags, recursionCount)) {
                    matchedSomeSubtypes = true;
                } else {
                    canUseFastPath = false;
                }
                remainingDestSubtypes.splice(destTypeIndex, 1);
                remainingSrcSubtypes = remainingSrcSubtypes.filter((t) => t !== srcSubtype);
            }
        });

        if (canUseFastPath && (remainingDestSubtypes.length !== 0 || remainingSrcSubtypes.length !== 0)) {
            if ((flags & AssignTypeFlags.Invariant) !== 0) {
                if (remainingSrcSubtypes.length === 0) {
                    return remainingDestSubtypes.every((destSubtype) =>
                        isTypeSubsumedByOtherType(evaluator, registry, state, destSubtype, destType, true, recursionCount)
                    );
                }
            }

            const isContra = (flags & AssignTypeFlags.Contravariant) !== 0;
            const effectiveDestSubtypes = isContra ? remainingSrcSubtypes : remainingDestSubtypes;

            if (effectiveDestSubtypes.length === 0 || effectiveDestSubtypes.some((t) => !isTypeVar(t))) {
                canUseFastPath = false;
                sortedSrcTypes = remainingSrcSubtypes;
            } else if (remainingDestSubtypes.length === remainingSrcSubtypes.length) {
                const reorderedDestSubtypes = [...remainingDestSubtypes];

                for (let srcIndex = 0; srcIndex < remainingSrcSubtypes.length; srcIndex++) {
                    let foundMatchForSrc = false;
                    for (let destIndex = 0; destIndex < reorderedDestSubtypes.length; destIndex++) {
                        if (assignType(evaluator, registry, state, reorderedDestSubtypes[destIndex],
                            remainingSrcSubtypes[srcIndex], diag?.createAddendum(), constraints, flags, recursionCount)) {
                            foundMatchForSrc = true;
                            reorderedDestSubtypes.push(...reorderedDestSubtypes.splice(destIndex, 1));
                            break;
                        }
                    }
                    if (!foundMatchForSrc) {
                        canUseFastPath = false;
                        break;
                    }
                }
                sortedSrcTypes = remainingSrcSubtypes;
            } else if (remainingSrcSubtypes.length === 0) {
                if ((flags & AssignTypeFlags.PopulateExpectedType) !== 0) {
                    remainingDestSubtypes.forEach((destSubtype) => {
                        assignType(evaluator, registry, state, destSubtype, srcType, undefined, constraints, flags, recursionCount);
                    });
                }
            } else {
                if (!assignType(evaluator, registry, state,
                    isContra ? destType : remainingDestSubtypes[0],
                    isContra ? remainingSrcSubtypes[0] : combineTypes(remainingSrcSubtypes),
                    diag?.createAddendum(), constraints, flags, recursionCount)) {
                    canUseFastPath = false;
                }
            }
        }

        if (canUseFastPath) {
            return true;
        }

        if ((flags & AssignTypeFlags.PartialOverloadOverlap) !== 0 && matchedSomeSubtypes) {
            return true;
        }
    }

    let isIncompatible = false;

    sortedSrcTypes.forEach((subtype) => {
        if (isIncompatible) {
            return;
        }

        if (!assignType(evaluator, registry, state, destType, subtype, undefined, constraints, flags, recursionCount)) {
            const isSubtypeSubsumed = isTypeSubsumedByOtherType(evaluator, registry, state,
                subtype, srcType, false, recursionCount);

            if (!isSubtypeSubsumed &&
                !assignType(evaluator, registry, state, destType, subtype, diag?.createAddendum(), constraints, flags, recursionCount)) {
                isIncompatible = true;
            }
        } else {
            matchedSomeSubtypes = true;
        }
    }, /* sortSubtypes */ true);

    if (isIncompatible) {
        if ((flags & AssignTypeFlags.PartialOverloadOverlap) !== 0 && matchedSomeSubtypes) {
            return true;
        }
        diag?.addMessage(LocAddendum.typeAssignmentMismatch().format(evaluator.printSrcDestTypes(srcType, destType)));
        return false;
    }

    return true;
}

export function assignToUnionType(
    evaluator: TypeEvaluator,
    registry: TypeRegistry,
    state: TypeEvaluatorState,
    destType: UnionType,
    srcType: Type,
    diag: DiagnosticAddendum | undefined,
    constraints: ConstraintTracker | undefined,
    flags: AssignTypeFlags,
    recursionCount: number
): boolean {
    if (flags & AssignTypeFlags.Invariant) {
        let isIncompatible = false;

        doForEachSubtype(destType, (subtype, index) => {
            if (
                !isIncompatible &&
                !assignType(evaluator, registry, state, subtype, srcType, diag?.createAddendum(), constraints, flags, recursionCount)
            ) {
                let skipSubtype = false;
                if (!isAnyOrUnknown(subtype)) {
                    const adjSubtype = makeTypeVarsBound(subtype, undefined);
                    doForEachSubtype(destType, (otherSubtype, otherIndex) => {
                        if (index !== otherIndex && !skipSubtype) {
                            const adjOtherSubtype = makeTypeVarsBound(otherSubtype, undefined);
                            if (assignType(evaluator, registry, state, adjOtherSubtype, adjSubtype,
                                undefined, undefined, AssignTypeFlags.Default, recursionCount)) {
                                skipSubtype = true;
                            }
                        }
                    });
                }
                if (!skipSubtype) {
                    isIncompatible = true;
                }
            }
        });

        if (isIncompatible) {
            diag?.addMessage(LocAddendum.typeAssignmentMismatch().format(evaluator.printSrcDestTypes(srcType, destType)));
            return false;
        }

        return true;
    }

    const diagAddendum = diag ? new DiagnosticAddendum() : undefined;
    let foundMatch = false;

    if (!requiresSpecialization(destType)) {
        for (const subtype of destType.priv.subtypes) {
            if (assignType(evaluator, registry, state, subtype, srcType, diagAddendum?.createAddendum(), constraints, flags, recursionCount)) {
                foundMatch = true;
                break;
            }
        }
    } else {
        if (isNoneInstance(srcType) && isOptionalType(destType)) {
            foundMatch = true;
        } else {
            let bestConstraints: ConstraintTracker | undefined;
            let bestConstraintsScore: number | undefined;
            let nakedTypeVarMatches = 0;

            if (
                isClassInstance(srcType) && isLiteralType(srcType) &&
                UnionType.containsType(destType, srcType, undefined, undefined, recursionCount)
            ) {
                return true;
            }

            doForEachSubtype(destType, (subtype) => {
                const constraintsClone = constraints?.clone();
                if (assignType(evaluator, registry, state, subtype, srcType,
                    diagAddendum?.createAddendum(), constraintsClone, flags, recursionCount)) {
                    foundMatch = true;
                    if (constraintsClone) {
                        let constraintsScore = constraintsClone.getScore();
                        if (isTypeVar(subtype)) {
                            if (!constraints?.getMainConstraintSet().getTypeVar(subtype)) {
                                nakedTypeVarMatches++;
                                constraintsScore += 0.001;
                            }
                        }
                        if (isTypeSame(subtype, evaluator.stripLiteralValue(srcType))) {
                            constraintsScore = Number.POSITIVE_INFINITY;
                        }
                        if (bestConstraintsScore === undefined || bestConstraintsScore <= constraintsScore) {
                            bestConstraintsScore = constraintsScore;
                            bestConstraints = constraintsClone;
                        }
                    }
                }
            }, true);

            if (nakedTypeVarMatches > 1 && (flags & AssignTypeFlags.ArgAssignmentFirstPass) !== 0) {
                bestConstraints = undefined;
            }

            if (constraints && bestConstraints) {
                constraints.copyFromClone(bestConstraints);
            }
        }
    }

    if (!foundMatch) {
        if (isTypeVar(srcType) && TypeVarType.hasConstraints(srcType)) {
            foundMatch = assignType(evaluator, registry, state, destType,
                evaluator.makeTopLevelTypeVarsConcrete(srcType),
                diagAddendum?.createAddendum(), constraints, flags, recursionCount);
        }
    }

    if (!foundMatch) {
        if (diag && diagAddendum) {
            diag.addMessage(LocAddendum.typeAssignmentMismatch().format(evaluator.printSrcDestTypes(srcType, destType)));
            diag.addAddendum(diagAddendum);
        }
        return false;
    }

    return true;
}

// Helper: get return type, triggering inference if needed.
function getEffectiveReturnType(evaluator: TypeEvaluator, type: FunctionType): Type {
    return FunctionType.getEffectiveReturnType(type) ?? evaluator.getInferredReturnType(type);
}

export function assignFunction(
    evaluator: TypeEvaluator,
    registry: TypeRegistry,
    state: TypeEvaluatorState,
    destType: FunctionType,
    srcType: FunctionType,
    diag: DiagnosticAddendum | undefined,
    constraints: ConstraintTracker,
    flags: AssignTypeFlags,
    recursionCount: number
): boolean {
    let canAssign = true;
    const checkReturnType = (flags & AssignTypeFlags.SkipReturnTypeCheck) === 0;
    const isContra = (flags & AssignTypeFlags.Contravariant) !== 0;
    flags &= ~AssignTypeFlags.SkipReturnTypeCheck;

    const destParamSpec = FunctionType.getParamSpecFromArgsKwargs(destType);
    if (destParamSpec) {
        destType = FunctionType.cloneRemoveParamSpecArgsKwargs(destType);
    }

    const srcParamSpec = FunctionType.getParamSpecFromArgsKwargs(srcType);
    if (srcParamSpec) {
        srcType = FunctionType.cloneRemoveParamSpecArgsKwargs(srcType);
    }

    const destParamDetails = getParamListDetails(destType, {
        disallowExtraKwargsForTd: (flags & AssignTypeFlags.DisallowExtraKwargsForTd) !== 0,
    });
    const srcParamDetails = getParamListDetails(srcType, {
        disallowExtraKwargsForTd: (flags & AssignTypeFlags.DisallowExtraKwargsForTd) !== 0,
    });

    adjustSourceParamDetailsForDestVariadic(
        evaluator,
        isContra ? destParamDetails : srcParamDetails,
        isContra ? srcParamDetails : destParamDetails
    );

    const targetIncludesParamSpec = isContra ? !!srcParamSpec : !!destParamSpec;
    const destPositionalCount = destParamDetails.firstKeywordOnlyIndex ?? destParamDetails.params.length;
    const srcPositionalCount = srcParamDetails.firstKeywordOnlyIndex ?? srcParamDetails.params.length;
    const positionalsToMatch = Math.min(destPositionalCount, srcPositionalCount);
    const skippedPosParamIndices: number[] = [];

    // Match positional parameters.
    for (let paramIndex = 0; paramIndex < positionalsToMatch; paramIndex++) {
        if (paramIndex === 0 && destType.shared.methodClass &&
            (flags & AssignTypeFlags.SkipSelfClsParamCheck) !== 0) {
            if (FunctionType.isInstanceMethod(destType) || FunctionType.isClassMethod(destType)) {
                continue;
            }
        }

        if (paramIndex === destParamDetails.argsIndex) {
            if (!isUnpackedTypeVarTuple(destParamDetails.params[destParamDetails.argsIndex].type)) {
                skippedPosParamIndices.push(paramIndex);
            }
            continue;
        }

        const destParam = destParamDetails.params[paramIndex];
        const srcParam = srcParamDetails.params[paramIndex];
        const srcParamType = srcParam.type;
        const destParamType = destParam.type;
        const destParamName = destParam.param.name ?? '';
        const srcParamName = srcParam.param.name ?? '';

        if (destParamName) {
            const isDestPositionalOnly = destParam.kind === ParamKind.Positional || destParam.kind === ParamKind.ExpandedArgs;
            if (!isDestPositionalOnly && destParam.param.category !== ParamCategory.ArgsList &&
                srcParam.param.category !== ParamCategory.ArgsList) {
                if (srcParam.kind === ParamKind.Positional || srcParam.kind === ParamKind.ExpandedArgs) {
                    diag?.createAddendum().addMessage(LocAddendum.functionParamPositionOnly().format({ name: destParamName }));
                    canAssign = false;
                } else if (destParamName !== srcParamName) {
                    diag?.createAddendum().addMessage(LocAddendum.functionParamName().format({ srcName: srcParamName, destName: destParamName }));
                    canAssign = false;
                }
            }
        }

        if (destParam.defaultType) {
            if (!srcParam.defaultType && paramIndex !== srcParamDetails.argsIndex) {
                diag?.createAddendum().addMessage(LocAddendum.functionParamDefaultMissing().format({ name: srcParamName }));
                canAssign = false;
            }
            if ((flags & AssignTypeFlags.PartialOverloadOverlap) !== 0 && srcParam.defaultType) {
                continue;
            }
        }

        if (paramIndex === 0 && srcType.shared.name === '__init__' && FunctionType.isInstanceMethod(srcType) &&
            destType.shared.name === '__init__' && FunctionType.isInstanceMethod(destType) &&
            FunctionType.isOverloaded(destType) && FunctionParam.isTypeDeclared(destParam.param)) {
            continue;
        }

        if (isUnpacked(srcParamType)) {
            canAssign = false;
        } else if (!assignParam(evaluator, registry, state, destParamType, srcParamType, paramIndex,
            diag?.createAddendum(), constraints, flags, recursionCount)) {
            if ((flags & AssignTypeFlags.SkipSelfClsTypeCheck) === 0 ||
                !isTypeVar(srcParamType) || !srcParamType.shared.isSynthesized) {
                canAssign = false;
            }
        } else if (destParam.kind !== ParamKind.Positional && destParam.kind !== ParamKind.ExpandedArgs &&
            srcParam.kind === ParamKind.Positional && srcParamDetails.kwargsIndex === undefined &&
            !srcParamDetails.params.some((p) =>
                p.kind === ParamKind.Keyword && p.param.category === ParamCategory.Simple &&
                p.param.name === destParam.param.name)) {
            diag?.addMessage(LocAddendum.namedParamMissingInSource().format({ name: destParam.param.name ?? '' }));
            canAssign = false;
        }
    }

    if (!FunctionType.isGradualCallableForm(destType) &&
        destParamDetails.firstPositionOrKeywordIndex < srcParamDetails.positionOnlyParamCount &&
        !targetIncludesParamSpec) {
        diag?.createAddendum().addMessage(LocAddendum.argsPositionOnly().format({
            expected: srcParamDetails.positionOnlyParamCount,
            received: destParamDetails.firstPositionOrKeywordIndex,
        }));
        canAssign = false;
    }

    if (destPositionalCount < srcPositionalCount && !targetIncludesParamSpec) {
        for (let i = destPositionalCount; i < srcPositionalCount; i++) {
            skippedPosParamIndices.push(i);
        }

        for (const i of skippedPosParamIndices) {
            if (destParamDetails.argsIndex !== undefined) {
                const destArgsType = destParamDetails.params[destParamDetails.argsIndex].type;
                const srcParamType = srcParamDetails.params[i].type;
                if (!assignParam(evaluator, registry, state, destArgsType, srcParamType, i,
                    diag?.createAddendum(), constraints, flags, recursionCount)) {
                    canAssign = false;
                }
                continue;
            }

            const srcParam = srcParamDetails.params[i];
            if (srcParam.defaultType) {
                const paramInfo = srcParamDetails.params[i];
                const defaultArgType = paramInfo.defaultType ?? paramInfo.defaultType;
                if (defaultArgType && !assignType(evaluator, registry, state, paramInfo.type, defaultArgType,
                    diag?.createAddendum(), constraints, flags, recursionCount)) {
                    if ((flags & AssignTypeFlags.PartialOverloadOverlap) === 0) {
                        canAssign = false;
                    }
                }
                continue;
            }

            if (srcParam.kind === ParamKind.Standard) {
                continue;
            }
            if (srcParam.param.category === ParamCategory.ArgsList) {
                continue;
            }

            const nonDefaultSrcParamCount = srcParamDetails.params.filter(
                (p) => !!p.param.name && !p.defaultType && p.param.category === ParamCategory.Simple
            ).length;
            diag?.createAddendum().addMessage(LocAddendum.functionTooFewParams().format({
                expected: nonDefaultSrcParamCount, received: destPositionalCount,
            }));
            canAssign = false;
            break;
        }
    } else if (srcPositionalCount < destPositionalCount) {
        if (srcParamDetails.argsIndex !== undefined) {
            const srcArgsType = srcParamDetails.params[srcParamDetails.argsIndex].type;
            for (let paramIndex = srcPositionalCount; paramIndex < destPositionalCount; paramIndex++) {
                if (paramIndex === srcParamDetails.argsIndex) {
                    continue;
                }
                const destParamType = destParamDetails.params[paramIndex].type;
                if (isTypeVarTuple(destParamType) && !isTypeVarTuple(srcArgsType)) {
                    diag?.addMessage(LocAddendum.typeVarTupleRequiresKnownLength());
                    canAssign = false;
                } else {
                    if (!assignParam(evaluator, registry, state, destParamType, srcArgsType, paramIndex,
                        diag?.createAddendum(), constraints, flags, recursionCount)) {
                        canAssign = false;
                    }
                    const destParamKind = destParamDetails.params[paramIndex].kind;
                    if (destParamKind !== ParamKind.Positional && destParamKind !== ParamKind.ExpandedArgs &&
                        srcParamDetails.kwargsIndex === undefined) {
                        diag?.addMessage(LocAddendum.namedParamMissingInSource().format({
                            name: destParamDetails.params[paramIndex].param.name ?? '',
                        }));
                        canAssign = false;
                    }
                }
            }
        } else if (!srcParamDetails.paramSpec) {
            let adjDestPositionalCount = destPositionalCount;
            if (destParamDetails.argsIndex !== undefined && destParamDetails.argsIndex < destPositionalCount) {
                adjDestPositionalCount--;
            }
            if ((flags & AssignTypeFlags.PartialOverloadOverlap) !== 0) {
                while (adjDestPositionalCount > 0 && destParamDetails.params[adjDestPositionalCount - 1].defaultType) {
                    adjDestPositionalCount--;
                }
            }
            if (srcPositionalCount < adjDestPositionalCount) {
                diag?.addMessage(LocAddendum.functionTooManyParams().format({
                    expected: srcPositionalCount, received: destPositionalCount,
                }));
                canAssign = false;
            }
        }
    }

    // *args compatibility
    if (srcParamDetails.argsIndex !== undefined && destParamDetails.argsIndex !== undefined &&
        !FunctionType.isGradualCallableForm(destType)) {
        let destArgsType = destParamDetails.params[destParamDetails.argsIndex].type;
        let srcArgsType = srcParamDetails.params[srcParamDetails.argsIndex].type;
        if (!isUnpacked(destArgsType)) {
            destArgsType = makeTupleObject(evaluator, [{ type: destArgsType, isUnbounded: true }], true);
        }
        if (!isUnpacked(srcArgsType)) {
            srcArgsType = makeTupleObject(evaluator, [{ type: srcArgsType, isUnbounded: true }], true);
        }
        if (!assignParam(evaluator, registry, state, destArgsType, srcArgsType,
            destParamDetails.params[destParamDetails.argsIndex].index,
            diag?.createAddendum(), constraints, flags, recursionCount)) {
            canAssign = false;
        }
    }

    if (!FunctionType.isGradualCallableForm(destType) && srcParamDetails.argsIndex === undefined &&
        srcParamSpec === undefined && destParamDetails.argsIndex !== undefined &&
        !destParamDetails.hasUnpackedTypeVarTuple) {
        diag?.createAddendum().addMessage(LocAddendum.argsParamMissing().format({
            paramName: destParamDetails.params[destParamDetails.argsIndex].param.name ?? '',
        }));
        canAssign = false;
    }

    // Named (keyword) parameters
    if (!targetIncludesParamSpec) {
        const destParamMap = new Map<string, VirtualParamDetails>();
        if (destParamDetails.firstKeywordOnlyIndex !== undefined) {
            destParamDetails.params.forEach((param, index) => {
                if (index >= destParamDetails.firstKeywordOnlyIndex! &&
                    param.param.name && param.param.category === ParamCategory.Simple &&
                    param.kind !== ParamKind.Positional && param.kind !== ParamKind.ExpandedArgs) {
                    destParamMap.set(param.param.name, param);
                }
            });
        }

        let srcStartOfNamed = srcParamDetails.firstKeywordOnlyIndex !== undefined
            ? srcParamDetails.firstKeywordOnlyIndex : srcParamDetails.params.length;
        if (destPositionalCount < srcPositionalCount && destParamDetails.argsIndex === undefined) {
            srcStartOfNamed = destPositionalCount;
        }

        if (srcStartOfNamed >= 0) {
            srcParamDetails.params.forEach((srcParamInfo, index) => {
                if (index < srcStartOfNamed) return;
                if (!srcParamInfo.param.name || srcParamInfo.param.category !== ParamCategory.Simple ||
                    srcParamInfo.kind === ParamKind.Positional) return;

                const destParamInfo = destParamMap.get(srcParamInfo.param.name);
                const paramDiag = diag?.createAddendum();
                const srcParamType = srcParamInfo.type;

                if (!destParamInfo) {
                    if (destParamDetails.kwargsIndex === undefined && !srcParamInfo.defaultType) {
                        paramDiag?.addMessage(LocAddendum.namedParamMissingInDest().format({ name: srcParamInfo.param.name }));
                        canAssign = false;
                    } else if (destParamDetails.kwargsIndex !== undefined) {
                        if (!assignParam(evaluator, registry, state,
                            destParamDetails.params[destParamDetails.kwargsIndex].type, srcParamType,
                            destParamDetails.params[destParamDetails.kwargsIndex].index,
                            diag?.createAddendum(), constraints, flags, recursionCount)) {
                            canAssign = false;
                        }
                    } else if (srcParamInfo.defaultType) {
                        const defaultArgType = srcParamInfo.defaultType;
                        if (defaultArgType && !assignType(evaluator, registry, state, srcParamInfo.type, defaultArgType,
                            diag?.createAddendum(), constraints, flags, recursionCount)) {
                            if ((flags & AssignTypeFlags.PartialOverloadOverlap) === 0) {
                                canAssign = false;
                            }
                        }
                    }
                    return;
                }

                if (srcParamInfo.defaultType && destParamInfo.defaultType &&
                    (flags & AssignTypeFlags.PartialOverloadOverlap) !== 0) {
                    destParamMap.delete(srcParamInfo.param.name);
                    return;
                }

                const destParamType = destParamInfo.type;
                const specializedDestParamType = constraints
                    ? evaluator.solveAndApplyConstraints(destParamType, constraints) : destParamType;

                if (!assignParam(evaluator, registry, state, destParamInfo.type, srcParamType, undefined,
                    paramDiag?.createAddendum(), constraints, flags, recursionCount)) {
                    paramDiag?.addMessage(LocAddendum.namedParamTypeMismatch().format({
                        name: srcParamInfo.param.name,
                        sourceType: evaluator.printType(specializedDestParamType),
                        destType: evaluator.printType(srcParamType),
                    }));
                    canAssign = false;
                }

                if (destParamInfo.defaultType && !srcParamInfo.defaultType) {
                    diag?.createAddendum().addMessage(LocAddendum.functionParamDefaultMissing().format({
                        name: srcParamInfo.param.name,
                    }));
                    canAssign = false;
                }

                destParamMap.delete(srcParamInfo.param.name);
            });
        }

        destParamMap.forEach((destParamInfo, paramName) => {
            if (srcParamDetails.kwargsIndex !== undefined && destParamInfo.param.name) {
                if (!assignParam(evaluator, registry, state, destParamInfo.type,
                    srcParamDetails.params[srcParamDetails.kwargsIndex].type, destParamInfo.index,
                    diag?.createAddendum(), constraints, flags, recursionCount)) {
                    canAssign = false;
                }
                destParamMap.delete(paramName);
            } else {
                diag?.createAddendum().addMessage(LocAddendum.namedParamMissingInSource().format({ name: paramName }));
                canAssign = false;
            }
        });

        if (srcParamDetails.kwargsIndex !== undefined && destParamDetails.kwargsIndex !== undefined) {
            if (!assignParam(evaluator, registry, state,
                destParamDetails.params[destParamDetails.kwargsIndex].type,
                srcParamDetails.params[srcParamDetails.kwargsIndex].type,
                destParamDetails.params[destParamDetails.kwargsIndex].index,
                diag?.createAddendum(), constraints, flags, recursionCount)) {
                canAssign = false;
            }
        }

        if (!FunctionType.isGradualCallableForm(destType) && srcParamDetails.kwargsIndex === undefined &&
            srcParamSpec === undefined && destParamDetails.kwargsIndex !== undefined) {
            diag?.createAddendum().addMessage(LocAddendum.kwargsParamMissing().format({
                paramName: destParamDetails.params[destParamDetails.kwargsIndex].param.name!,
            }));
            canAssign = false;
        }
    }

    if ((flags & AssignTypeFlags.OverloadOverlap) !== 0) {
        if (FunctionType.isGradualCallableForm(srcType) && !FunctionType.isGradualCallableForm(destType)) {
            canAssign = false;
        }
        if (srcParamSpec && !destParamSpec) {
            canAssign = false;
        }
    }

    if (targetIncludesParamSpec && srcParamSpec?.priv.nameWithScope === destParamSpec?.priv.nameWithScope) {
        if (srcParamDetails.params.length !== destParamDetails.params.length) {
            canAssign = false;
        }
    }

    // ParamSpec handling
    if (targetIncludesParamSpec) {
        const effectiveSrcType = isContra ? destType : srcType;
        const effectiveDestType = isContra ? srcType : destType;
        const effectiveSrcParamSpec = isContra ? destParamSpec : srcParamSpec;
        const effectiveDestParamSpec = isContra ? srcParamSpec : destParamSpec;

        if (effectiveDestParamSpec) {
            const requiredMatchParamCount = effectiveDestType.shared.parameters.filter((p, i) => {
                if (!p.name) return false;
                const paramType = FunctionType.getParamType(effectiveDestType, i);
                if (p.category === ParamCategory.Simple && isParamSpec(paramType)) return false;
                return true;
            }).length;
            let matchedParamCount = 0;
            const remainingParams: FunctionParam[] = [];

            effectiveSrcType.shared.parameters.forEach((p, index) => {
                if (matchedParamCount < requiredMatchParamCount) {
                    if (p.name) matchedParamCount++;
                    if (p.category !== ParamCategory.ArgsList) return;
                }
                if (isPositionOnlySeparator(p) && remainingParams.length === 0) return;
                remainingParams.push(FunctionParam.create(
                    p.category, FunctionType.getParamType(effectiveSrcType, index), p.flags, p.name,
                    FunctionType.getParamDefaultType(effectiveSrcType, index), p.defaultExpr
                ));
            });

            if (remainingParams.length > 0 || !effectiveSrcParamSpec ||
                !isTypeSame(effectiveSrcParamSpec, effectiveDestParamSpec, { ignoreTypeFlags: true })) {
                const effectiveSrcPosCount = isContra ? destPositionalCount : srcPositionalCount;
                const effectiveDestPosCount = isContra ? srcPositionalCount : destPositionalCount;

                if (!effectiveSrcParamSpec || effectiveSrcPosCount >= effectiveDestPosCount) {
                    const remainingFunction = FunctionType.createInstance(
                        '', '', '',
                        effectiveSrcType.shared.flags | FunctionTypeFlags.SynthesizedMethod,
                        effectiveSrcType.shared.docString
                    );
                    remainingFunction.shared.deprecatedMessage = effectiveSrcType.shared.deprecatedMessage;
                    remainingFunction.shared.typeVarScopeId = effectiveSrcType.shared.typeVarScopeId;
                    remainingFunction.priv.constructorTypeVarScopeId = effectiveSrcType.priv.constructorTypeVarScopeId;
                    remainingFunction.shared.methodClass = effectiveSrcType.shared.methodClass;
                    remainingParams.forEach((param) => { FunctionType.addParam(remainingFunction, param); });
                    if (effectiveSrcParamSpec) {
                        FunctionType.addParamSpecVariadics(remainingFunction, convertToInstance(effectiveSrcParamSpec));
                    }

                    if (!assignType(evaluator, registry, state, effectiveDestParamSpec, remainingFunction,
                        undefined, constraints, flags)) {
                        if (remainingParams.length > 0 || !effectiveSrcParamSpec ||
                            !assignType(evaluator, registry, state,
                                convertToInstance(effectiveDestParamSpec), convertToInstance(effectiveSrcParamSpec),
                                undefined, constraints, flags)) {
                            canAssign = false;
                        }
                    }
                }
            }
        }
    }

    // Return type matching
    if (checkReturnType) {
        const destReturnType = getEffectiveReturnType(evaluator, destType);
        if (!isAnyOrUnknown(destReturnType)) {
            const srcReturnType = evaluator.solveAndApplyConstraints(
                getEffectiveReturnType(evaluator, srcType), constraints);
            const returnDiag = diag?.createAddendum();
            let isReturnTypeCompatible = false;
            let effectiveFlags = flags;

            if (srcType.shared.declaredReturnType &&
                containsLiteralType(srcType.shared.declaredReturnType, true)) {
                effectiveFlags |= AssignTypeFlags.RetainLiteralsForTypeVar;
            }

            if (assignType(evaluator, registry, state, destReturnType, srcReturnType,
                returnDiag?.createAddendum(), constraints, effectiveFlags, recursionCount)) {
                isReturnTypeCompatible = true;
            } else {
                if (isClassInstance(srcReturnType) &&
                    ClassType.isBuiltIn(srcReturnType, ['TypeGuard', 'TypeIs']) &&
                    registry.boolClass && isInstantiableClass(registry.boolClass)) {
                    if (assignType(evaluator, registry, state, destReturnType,
                        ClassType.cloneAsInstance(registry.boolClass),
                        returnDiag?.createAddendum(), constraints, flags, recursionCount)) {
                        isReturnTypeCompatible = true;
                    }
                }
            }

            if (!isReturnTypeCompatible) {
                returnDiag?.addMessage(LocAddendum.functionReturnTypeMismatch().format({
                    sourceType: evaluator.printType(srcReturnType),
                    destType: evaluator.printType(destReturnType),
                }));
                canAssign = false;
            }
        }
    }

    return canAssign;
}

// Determines if the source type can be assigned to the dest type.
export function assignType(
    evaluator: TypeEvaluator,
    registry: TypeRegistry,
    state: TypeEvaluatorState,
    destType: Type,
    srcType: Type,
    diag?: DiagnosticAddendum,
    constraints?: ConstraintTracker,
    flags = AssignTypeFlags.Default,
    recursionCount = 0
): boolean {
    if (destType === srcType && !requiresSpecialization(destType)) {
        return true;
    }

    const specialForm = srcType.props?.specialForm;
    if (specialForm) {
        let isSpecialFormExempt = false;
        if ((flags & AssignTypeFlags.AllowIsinstanceSpecialForms) !== 0) {
            if (ClassType.isBuiltIn(specialForm, ['Callable', 'UnionType', 'Generic'])) {
                isSpecialFormExempt = true;
            }
        }
        if (!isSpecialFormExempt) {
            if (srcType.props?.typeForm && !specialForm.props?.typeForm) {
                srcType = TypeBase.cloneWithTypeForm(specialForm, srcType.props.typeForm);
            } else {
                srcType = specialForm;
            }
        }
    }

    if (isInstantiableClass(srcType) && ClassType.isNewTypeClass(srcType) && !srcType.priv.includeSubclasses) {
        if (registry.functionClass && isInstantiableClass(registry.functionClass)) {
            srcType = ClassType.cloneAsInstance(registry.functionClass);
        }
    }

    if (recursionCount > maxTypeRecursionCount) {
        return true;
    }
    recursionCount++;

    if (isTypeVar(destType) && destType.shared.recursiveAlias &&
        isTypeVar(srcType) && srcType.shared.recursiveAlias) {
        const destAliasInfo = destType.props?.typeAliasInfo;
        const srcAliasInfo = srcType.props?.typeAliasInfo;

        if (destAliasInfo?.typeArgs && srcAliasInfo?.typeArgs &&
            destType.shared.recursiveAlias.typeVarScopeId === srcType.shared.recursiveAlias.typeVarScopeId) {
            return assignRecursiveTypeAliasToSelf(evaluator, registry, state,
                destAliasInfo, srcAliasInfo, diag, constraints, flags, recursionCount);
        } else {
            if ((flags & AssignTypeFlags.SkipRecursiveTypeCheck) !== 0) {
                return true;
            }
            flags |= AssignTypeFlags.SkipRecursiveTypeCheck;
        }
    }

    if (TypeBase.isInstantiable(destType) && TypeBase.isInstantiable(srcType)) {
        if (TypeBase.getInstantiableDepth(destType) > 0 || TypeBase.getInstantiableDepth(srcType) > 0) {
            return assignType(evaluator, registry, state, convertToInstance(destType), convertToInstance(srcType),
                diag, constraints, flags, recursionCount);
        }
    }

    const transformedDestType = transformPossibleRecursiveTypeAlias(destType);
    const transformedSrcType = transformPossibleRecursiveTypeAlias(srcType);

    if ((transformedDestType !== destType && isUnion(transformedDestType)) ||
        (transformedSrcType !== srcType && isUnion(transformedSrcType))) {
        if (recursionCount > maxRecursiveTypeAliasRecursionCount) {
            if (isClassInstance(srcType) && ClassType.isBuiltIn(srcType, 'str') && isUnion(transformedDestType)) {
                return transformedDestType.priv.subtypes.some(
                    (subtype) => isClassInstance(subtype) && ClassType.isBuiltIn(subtype, ['object', 'str'])
                );
            }
            return true;
        }
    }

    destType = transformedDestType;
    srcType = transformedSrcType;

    if (isUnbound(destType) || isUnbound(srcType)) {
        return true;
    }

    if (isTypeVar(destType)) {
        if (isTypeVarSame(destType, srcType)) {
            return true;
        }

        if (assignConditionalTypeToTypeVar(evaluator, registry, state, destType, srcType, recursionCount)) {
            return true;
        }

        const destTypeVar = destType;
        if (TypeBase.isInstantiable(destType) === TypeBase.isInstantiable(srcType) &&
            srcType.props?.condition &&
            srcType.props.condition.some((cond) => {
                return !TypeVarType.hasConstraints(cond.typeVar) &&
                    cond.typeVar.priv.nameWithScope === destTypeVar.priv.nameWithScope;
            })) {
            return true;
        }

        if (isUnion(srcType)) {
            const srcWithoutAny = removeFromUnion(srcType, (type) => isAnyOrUnknown(type));
            if (isTypeSame(destType, srcWithoutAny)) {
                return true;
            }
        }

        if (isTypeVar(srcType) && TypeVarType.isSelf(srcType) && TypeVarType.hasBound(srcType) &&
            TypeVarType.isSelf(destType) && TypeVarType.hasBound(destType) &&
            TypeVarType.isBound(destType) === TypeVarType.isBound(srcType) &&
            TypeBase.isInstance(srcType) === TypeBase.isInstance(destType)) {
            if ((flags & AssignTypeFlags.Contravariant) === 0 && constraints) {
                assignTypeVar(evaluator, destType, srcType, diag, constraints, flags, recursionCount);
            }
            return true;
        }

        if (isTypeVarTuple(destType) && isClassInstance(srcType) && isTupleClass(srcType) &&
            srcType.priv.tupleTypeArgs && srcType.priv.tupleTypeArgs.length === 1) {
            if (isTypeSame(destType, srcType.priv.tupleTypeArgs[0].type, {}, recursionCount)) {
                return true;
            }
        }

        if ((flags & AssignTypeFlags.Contravariant) === 0 || !isTypeVar(srcType)) {
            if (!assignTypeVar(evaluator, destType, srcType, diag, constraints, flags, recursionCount)) {
                return false;
            }
            if (isAnyOrUnknown(srcType) && (flags & AssignTypeFlags.OverloadOverlap) !== 0) {
                return false;
            }
            return true;
        }
    }

    if (isTypeVar(srcType)) {
        if ((flags & AssignTypeFlags.Contravariant) !== 0) {
            if (TypeVarType.isBound(srcType)) {
                return assignType(evaluator, registry, state,
                    evaluator.makeTopLevelTypeVarsConcrete(destType),
                    evaluator.makeTopLevelTypeVarsConcrete(srcType),
                    diag, undefined, flags, recursionCount);
            }

            if (assignTypeVar(evaluator, srcType, destType, diag, constraints, flags, recursionCount)) {
                return true;
            }

            let isAssignable = false;
            if (isUnion(destType)) {
                doForEachSubtype(destType, (destSubtype) => {
                    if (assignTypeVar(evaluator, srcType as TypeVarType, destSubtype, diag, constraints, flags, recursionCount)) {
                        isAssignable = true;
                    }
                });
            }
            return isAssignable;
        }

        if ((flags & AssignTypeFlags.Invariant) !== 0) {
            if (isAnyOrUnknown(destType)) {
                return true;
            }
            if (isParamSpec(srcType) && isFunction(destType) &&
                FunctionType.isGradualCallableForm(destType) && destType.shared.parameters.length <= 2) {
                return true;
            }
            if (isUnpackedTypeVarTuple(srcType) && isClassInstance(destType) && isUnpackedClass(destType) &&
                destType.priv.tupleTypeArgs && destType.priv.tupleTypeArgs.length === 1 &&
                destType.priv.tupleTypeArgs[0].isUnbounded && isAnyOrUnknown(destType.priv.tupleTypeArgs[0].type)) {
                return true;
            }
            if (!isUnion(destType)) {
                diag?.addMessage(LocAddendum.typeAssignmentMismatch().format(evaluator.printSrcDestTypes(srcType, destType)));
                return false;
            }
        }
    }

    if (isAnyOrUnknown(destType)) {
        return true;
    }

    if (isAnyOrUnknown(srcType) && !srcType.props?.specialForm) {
        if (constraints) {
            const typeVarSubstitution = isEllipsisType(srcType) ? AnyType.create() : srcType;
            setConstraintsForFreeTypeVars(destType, typeVarSubstitution, constraints);
        }
        if ((flags & AssignTypeFlags.OverloadOverlap) === 0) {
            return true;
        }
    }

    if (isNever(srcType)) {
        if ((flags & AssignTypeFlags.Invariant) !== 0) {
            if (isNever(destType)) {
                return true;
            }
            diag?.addMessage(LocAddendum.typeAssignmentMismatch().format(evaluator.printSrcDestTypes(srcType, destType)));
            return false;
        }
        if (constraints) {
            setConstraintsForFreeTypeVars(destType, UnknownType.create(), constraints);
        }
        return true;
    }

    if (isUnion(destType)) {
        if (isUnion(srcType)) {
            return assignFromUnionType(evaluator, registry, state, destType, srcType, diag, constraints, flags, recursionCount);
        }
        const clonedConstraints = constraints?.clone();
        if (assignToUnionType(evaluator, registry, state, destType, srcType, undefined, clonedConstraints, flags, recursionCount)) {
            if (constraints && clonedConstraints) {
                constraints.copyFromClone(clonedConstraints);
            }
            return true;
        }
    }

    const expandedSrcType = evaluator.makeTopLevelTypeVarsConcrete(srcType);
    if (isUnion(expandedSrcType)) {
        return assignFromUnionType(evaluator, registry, state, destType, expandedSrcType, diag, constraints, flags, recursionCount);
    }

    if (isUnion(destType)) {
        return assignToUnionType(evaluator, registry, state, destType, srcType, diag, constraints, flags, recursionCount);
    }

    // Is the src a specialized "type" object?
    if (isClassInstance(expandedSrcType) && ClassType.isBuiltIn(expandedSrcType, 'type')) {
        const srcTypeArgs = expandedSrcType.priv.typeArgs;
        let typeTypeArg: Type;
        if (srcTypeArgs && srcTypeArgs.length >= 1) {
            typeTypeArg = srcTypeArgs[0];
        } else {
            typeTypeArg = UnknownType.create();
        }

        if (isAnyOrUnknown(typeTypeArg)) {
            if (isEffectivelyInstantiable(destType)) {
                return true;
            }
        } else if (isClassInstance(typeTypeArg) || isTypeVar(typeTypeArg)) {
            if (assignType(evaluator, registry, state, destType, convertToInstantiable(typeTypeArg),
                diag?.createAddendum(), constraints, flags, recursionCount)) {
                return true;
            }
            diag?.addMessage(LocAddendum.typeAssignmentMismatch().format(evaluator.printSrcDestTypes(srcType, destType)));
            return false;
        }
    }

    if (isInstantiableClass(destType)) {
        if (isInstantiableClass(expandedSrcType)) {
            if (ClassType.isProtocolClass(destType)) {
                if ((flags & AssignTypeFlags.AllowProtocolClassSource) === 0 &&
                    ClassType.isProtocolClass(expandedSrcType) && isInstantiableClass(srcType) &&
                    !srcType.priv.includeSubclasses) {
                    diag?.addMessage(LocAddendum.protocolSourceIsNotConcrete().format({
                        sourceType: evaluator.printType(convertToInstance(srcType)),
                        destType: evaluator.printType(destType),
                    }));
                    return false;
                }
            }

            if (ClassType.isBuiltIn(destType, 'type') && (srcType.props?.instantiableDepth ?? 0) > 0) {
                return true;
            }

            if (isSpecialFormClass(expandedSrcType, flags)) {
                const destSpecialForm = destType.props?.specialForm ?? destType;
                if (isSpecialFormClass(destSpecialForm, flags)) {
                    return assignType(evaluator, registry, state, destSpecialForm, expandedSrcType, diag, constraints, flags, recursionCount);
                }
            } else if (assignClass(evaluator, registry, state, destType, expandedSrcType, diag, constraints, flags,
                recursionCount, false)) {
                return true;
            }

            diag?.addMessage(LocAddendum.typeAssignmentMismatch().format(evaluator.printSrcDestTypes(srcType, destType)));
            return false;
        }
    }

    if (isClassInstance(destType)) {
        if (ClassType.isBuiltIn(destType, 'type')) {
            if (isInstantiableClass(srcType) && isSpecialFormClass(srcType, flags) &&
                TypeBase.getInstantiableDepth(srcType) === 0) {
                return false;
            }
            if (isAnyOrUnknown(srcType) && (flags & AssignTypeFlags.OverloadOverlap) !== 0) {
                return false;
            }
            const destTypeArgs = destType.priv.typeArgs;
            if (destTypeArgs && destTypeArgs.length >= 1) {
                if (TypeBase.isInstance(destTypeArgs[0]) && TypeBase.isInstantiable(srcType)) {
                    return assignType(evaluator, registry, state, destTypeArgs[0], convertToInstance(srcType),
                        diag, constraints, flags, recursionCount);
                }
            }
            if (TypeBase.isInstantiable(srcType)) {
                const isLiteral = isClass(srcType) && srcType.priv.literalValue !== undefined;
                return !isLiteral;
            }
        }

        let concreteSrcType = evaluator.makeTopLevelTypeVarsConcrete(srcType);

        if (ClassType.isBuiltIn(destType, 'TypeForm')) {
            const destTypeArg = destType.priv.typeArgs && destType.priv.typeArgs.length > 0
                ? destType.priv.typeArgs[0] : UnknownType.create();
            let srcTypeArg: Type | undefined;
            if (isClassInstance(concreteSrcType) && ClassType.isBuiltIn(concreteSrcType, 'type')) {
                srcTypeArg = concreteSrcType;
            } else if (isInstantiableClass(concreteSrcType)) {
                srcTypeArg = convertToInstance(concreteSrcType);
            }
            if (srcTypeArg) {
                return assignType(evaluator, registry, state, destTypeArg, srcTypeArg, diag, constraints, flags, recursionCount);
            }
        }

        if (isClass(concreteSrcType) && TypeBase.isInstance(concreteSrcType)) {
            if (!destType.priv.isUnpacked && concreteSrcType.priv.isUnpacked && concreteSrcType.priv.tupleTypeArgs) {
                return assignType(evaluator, registry, state, destType,
                    combineTupleTypeArgs(concreteSrcType.priv.tupleTypeArgs), diag, constraints, flags, recursionCount);
            }

            if (destType.priv.literalValue !== undefined && ClassType.isSameGenericClass(destType, concreteSrcType)) {
                const srcLiteral = concreteSrcType.priv.literalValue;
                if (srcLiteral === undefined || !ClassType.isLiteralValueSame(concreteSrcType, destType)) {
                    diag?.addMessage(LocAddendum.literalAssignmentMismatch().format({
                        sourceType: evaluator.printType(srcType),
                        destType: evaluator.printType(destType),
                    }));
                    return false;
                }
            }

            if (ClassType.isBuiltIn(destType, 'LiteralString')) {
                if (ClassType.isBuiltIn(concreteSrcType, 'str') && concreteSrcType.priv.literalValue !== undefined) {
                    return (flags & AssignTypeFlags.Invariant) === 0;
                } else if (ClassType.isBuiltIn(concreteSrcType, 'LiteralString')) {
                    return true;
                }
            } else if (ClassType.isBuiltIn(concreteSrcType, 'LiteralString') &&
                registry.strClass && isInstantiableClass(registry.strClass) &&
                (flags & AssignTypeFlags.Invariant) === 0) {
                concreteSrcType = ClassType.cloneAsInstance(registry.strClass);
            }

            if (!assignClass(evaluator, registry, state, ClassType.cloneAsInstantiable(destType),
                ClassType.cloneAsInstantiable(concreteSrcType), diag, constraints, flags, recursionCount, true)) {
                return false;
            }
            return true;
        } else if (isFunctionOrOverloaded(concreteSrcType)) {
            const destCallbackType = evaluator.getCallbackProtocolType(destType, recursionCount);
            if (destCallbackType) {
                return assignType(evaluator, registry, state, destCallbackType, concreteSrcType, diag, constraints, flags, recursionCount);
            }
            const altClass = isMethodType(concreteSrcType) ? registry.methodClass : registry.functionClass;
            if (altClass) {
                return assignType(evaluator, registry, state, destType, convertToInstance(altClass), diag, constraints, flags, recursionCount);
            }
        } else if (isModule(concreteSrcType)) {
            if (ClassType.isBuiltIn(destType, 'ModuleType')) {
                return true;
            }
            if (ClassType.isProtocolClass(destType)) {
                return assignModuleToProtocol(evaluator, ClassType.cloneAsInstantiable(destType),
                    concreteSrcType, diag, constraints, flags, recursionCount);
            }
        } else if (isInstantiableClass(concreteSrcType)) {
            const callbackType = evaluator.getCallbackProtocolType(destType, recursionCount);
            if (callbackType) {
                return assignType(evaluator, registry, state, callbackType, concreteSrcType, diag, constraints, flags, recursionCount);
            }
            if (ClassType.isProtocolClass(destType)) {
                return assignClassToProtocol(evaluator, ClassType.cloneAsInstantiable(destType),
                    concreteSrcType, diag, constraints, flags, recursionCount);
            }
            const metaclass = concreteSrcType.shared.effectiveMetaclass;
            if (metaclass) {
                if (!isAnyOrUnknown(metaclass)) {
                    if (assignClass(evaluator, registry, state, ClassType.cloneAsInstantiable(destType), metaclass,
                        undefined, constraints, flags, recursionCount, true)) {
                        return true;
                    }
                }
            }
        } else if (isAnyOrUnknown(concreteSrcType) && !concreteSrcType.props?.specialForm) {
            return (flags & AssignTypeFlags.OverloadOverlap) === 0;
        } else if (isUnion(concreteSrcType)) {
            return assignType(evaluator, registry, state, destType, concreteSrcType, diag, constraints, flags, recursionCount);
        }
    }

    if (isFunction(destType)) {
        let concreteSrcType = evaluator.makeTopLevelTypeVarsConcrete(srcType);

        if (isClassInstance(concreteSrcType)) {
            const boundMethod = evaluator.getBoundMagicMethod(
                concreteSrcType, '__call__', undefined, undefined, undefined, recursionCount);
            if (boundMethod) {
                concreteSrcType = boundMethod;
            }
        }

        if (isInstantiableClass(concreteSrcType) && concreteSrcType.priv.literalValue === undefined) {
            const constructor = createFunctionFromConstructor(evaluator, concreteSrcType,
                isTypeVar(srcType) ? convertToInstance(srcType) : undefined, recursionCount);
            if (constructor) {
                concreteSrcType = constructor;
                if (isUnion(concreteSrcType)) {
                    return assignType(evaluator, registry, state, destType, concreteSrcType, diag, constraints, flags, recursionCount);
                }
            }
        }

        if (isAnyOrUnknown(concreteSrcType)) {
            return (flags & AssignTypeFlags.OverloadOverlap) === 0;
        }

        if (isOverloaded(concreteSrcType)) {
            if ((flags & AssignTypeFlags.ArgAssignmentFirstPass) !== 0) {
                return true;
            }
            const overloads = OverloadedType.getOverloads(concreteSrcType);
            const filteredOverloads: FunctionType[] = [];
            const typeVarSignatures: ConstraintSet[] = [];

            overloads.forEach((overload) => {
                const overloadScopeId = getTypeVarScopeId(overload) ?? '';
                const constraintsClone = constraints?.cloneWithSignature(overloadScopeId);
                if (assignType(evaluator, registry, state, destType, overload, undefined, constraintsClone, flags, recursionCount)) {
                    filteredOverloads.push(overload);
                    if (constraintsClone) {
                        appendArray(typeVarSignatures, constraintsClone.getConstraintSets());
                    }
                }
            });

            if (filteredOverloads.length === 0) {
                diag?.addMessage(LocAddendum.noOverloadAssignable().format({ type: evaluator.printType(destType) }));
                return false;
            }
            if (filteredOverloads.length === 1 || (flags & AssignTypeFlags.ArgAssignmentFirstPass) === 0) {
                if (constraints) {
                    constraints.addConstraintSets(typeVarSignatures);
                }
            }
            return true;
        }

        if (isFunction(concreteSrcType)) {
            if (assignFunction(evaluator, registry, state, destType, concreteSrcType,
                diag?.createAddendum(), constraints ?? new ConstraintTracker(), flags, recursionCount)) {
                return true;
            }
        }
    }

    if (isOverloaded(destType)) {
        const overloadDiag = diag?.createAddendum();
        const destOverloads = OverloadedType.getOverloads(destType);

        if (isOverloaded(srcType)) {
            const srcOverloads = OverloadedType.getOverloads(srcType);
            if (destOverloads.length === srcOverloads.length) {
                if (destOverloads.every((destOverload, index) => {
                    const srcOverload = srcOverloads[index];
                    return assignType(evaluator, registry, state, destOverload, srcOverload,
                        undefined, constraints, flags, recursionCount);
                })) {
                    return true;
                }
            }
        }

        const isAssignable = destOverloads.every((destOverload) => {
            return assignType(evaluator, registry, state, destOverload, srcType,
                overloadDiag?.createAddendum(), constraints, flags, recursionCount);
        });

        if (!isAssignable) {
            const overloads = OverloadedType.getOverloads(destType);
            if (overloadDiag && overloads.length > 0) {
                overloadDiag.addMessage(LocAddendum.overloadNotAssignable().format({ name: overloads[0].shared.name }));
            }
            return false;
        }
        return true;
    }

    if (isClass(destType) && ClassType.isBuiltIn(destType, 'object')) {
        if ((isInstantiableClass(destType) && TypeBase.isInstantiable(srcType)) || isClassInstance(destType)) {
            if ((flags & AssignTypeFlags.Invariant) === 0) {
                return true;
            }
        }
    }

    if (isNoneInstance(srcType) && isClassInstance(destType) && ClassType.isProtocolClass(destType)) {
        if (registry.noneTypeClass && isInstantiableClass(registry.noneTypeClass)) {
            return assignClassToProtocol(evaluator, ClassType.cloneAsInstantiable(destType),
                ClassType.cloneAsInstance(registry.noneTypeClass), diag, constraints, flags, recursionCount);
        }
    }

    if (isNoneInstance(destType)) {
        diag?.addMessage(LocAddendum.assignToNone());
        return false;
    }

    diag?.addMessage(LocAddendum.typeAssignmentMismatch().format(evaluator.printSrcDestTypes(srcType, destType)));
    return false;
}

// If the expected type is an explicit TypeForm type, see if the source
// type has an implicit TypeForm type that can be assigned to it. If so,
// convert to an explicit TypeForm type.
export function convertToTypeFormType(
    evaluator: TypeEvaluator,
    registry: TypeRegistry,
    state: TypeEvaluatorState,
    expectedType: Type,
    srcType: Type
): Type {
    // Is the source is a TypeForm type?
    if (!srcType.props?.typeForm) {
        return srcType;
    }

    let srcTypeFormType: Type | undefined;

    // Is the source is a TypeForm type?
    if (srcType.props?.typeForm) {
        srcTypeFormType = srcType.props.typeForm;
    } else if (isClass(srcType)) {
        if (TypeBase.isInstantiable(srcType)) {
            if (!ClassType.isSpecialBuiltIn(srcType)) {
                srcTypeFormType = ClassType.cloneAsInstance(srcType);
            }
        } else if (ClassType.isBuiltIn(srcType, 'type')) {
            srcTypeFormType =
                srcType.priv.typeArgs?.length && srcType.priv.typeArgs.length > 0
                    ? srcType.priv.typeArgs[0]
                    : UnknownType.create();
        }
    } else if (isTypeVar(srcType) && TypeBase.isInstantiable(srcType)) {
        if (!isTypeVarTuple(srcType) || !srcType.priv.isInUnion) {
            srcTypeFormType = convertToInstance(srcType);
        }
    }

    if (!srcTypeFormType) {
        return srcType;
    }

    let resultType: Type | undefined;

    doForEachSubtype(expectedType, (subtype) => {
        if (resultType || !isClassInstance(subtype) || !ClassType.isBuiltIn(subtype, 'TypeForm')) {
            return;
        }

        const destTypeFormType =
            subtype.priv.typeArgs && subtype.priv.typeArgs.length > 0
                ? subtype.priv.typeArgs[0]
                : UnknownType.create();

        if (assignType(evaluator, registry, state, destTypeFormType, srcTypeFormType)) {
            resultType = ClassType.specialize(subtype, [srcTypeFormType]);
        }
    });

    return resultType ?? srcType;
}

export function isTypeComparable(
    evaluator: TypeEvaluator,
    registry: TypeRegistry,
    state: TypeEvaluatorState,
    leftType: Type,
    rightType: Type,
    assumeIsOperator = false
) {
    if (isAnyOrUnknown(leftType) || isAnyOrUnknown(rightType)) {
        return true;
    }

    if (isNever(leftType) || isNever(rightType)) {
        return false;
    }

    if (isModule(leftType) || isModule(rightType)) {
        return isTypeSame(leftType, rightType, { ignoreConditions: true });
    }

    const isLeftCallable = isFunctionOrOverloaded(leftType);
    const isRightCallable = isFunctionOrOverloaded(rightType);

    // If either type is a function, assume that it may be comparable. The other
    // operand might be a callable object, an 'object' instance, etc. We could
    // make this more precise for specific cases (e.g. if the other operand is
    // None or a literal or an instance of a nominal class that doesn't override
    // __call__ and is marked final, etc.), but coming up with a comprehensive
    // list is probably not feasible.
    if (isLeftCallable || isRightCallable) {
        return true;
    }

    if (isInstantiableClass(leftType) || (isClassInstance(leftType) && ClassType.isBuiltIn(leftType, 'type'))) {
        if (
            isInstantiableClass(rightType) ||
            (isClassInstance(rightType) && ClassType.isBuiltIn(rightType, 'type'))
        ) {
            const genericLeftType = ClassType.specialize(leftType, /* typeArgs */ undefined);
            const genericRightType = ClassType.specialize(rightType, /* typeArgs */ undefined);

            if (
                assignType(evaluator, registry, state, genericLeftType, genericRightType) ||
                assignType(evaluator, registry, state, genericRightType, genericLeftType)
            ) {
                return true;
            }
        }

        // Does the class have an operator overload for eq?
        const metaclass = leftType.shared.effectiveMetaclass;
        if (metaclass && isClass(metaclass)) {
            if (lookUpClassMember(metaclass, '__eq__', MemberAccessFlags.SkipObjectBaseClass)) {
                return true;
            }
        }

        return false;
    }

    if (isClassInstance(leftType)) {
        if (isClass(rightType)) {
            const genericLeftType = ClassType.specialize(leftType, /* typeArgs */ undefined);
            const genericRightType = ClassType.specialize(rightType, /* typeArgs */ undefined);

            if (
                assignType(evaluator, registry, state, genericLeftType, genericRightType) ||
                assignType(evaluator, registry, state, genericRightType, genericLeftType)
            ) {
                return true;
            }

            // Check for the "is None" or "is not None" case.
            if (assumeIsOperator && isNoneInstance(rightType)) {
                if (isNoneInstance(leftType)) {
                    return true;
                }

                // The LHS could be a protocol or 'object', in which case None is
                // potentially comparable to it. In other cases, None is not comparable
                // because the types are disjoint.
                return assignType(evaluator, registry, state, leftType, rightType);
            }

            // Assume that if the types are disjoint and built-in classes that they
            // will never be comparable.
            if (ClassType.isBuiltIn(leftType) && ClassType.isBuiltIn(rightType) && TypeBase.isInstance(rightType)) {
                // We need to be careful with bool and int literals because
                // they are comparable under certain circumstances.
                let boolType: ClassType | undefined;
                let intType: ClassType | undefined;
                if (ClassType.isBuiltIn(leftType, 'bool') && ClassType.isBuiltIn(rightType, 'int')) {
                    boolType = leftType;
                    intType = rightType;
                } else if (ClassType.isBuiltIn(rightType, 'bool') && ClassType.isBuiltIn(leftType, 'int')) {
                    boolType = rightType;
                    intType = leftType;
                }

                if (boolType && intType) {
                    const intVal = intType.priv?.literalValue as number | BigInt | undefined;
                    if (intVal === undefined) {
                        return true;
                    }
                    if (intVal !== 0 && intVal !== 1) {
                        return false;
                    }

                    const boolVal = boolType.priv?.literalValue as boolean | undefined;
                    if (boolVal === undefined) {
                        return true;
                    }

                    return boolVal === (intVal === 1);
                }

                return false;
            }
        }

        // Does the class have an operator overload for eq?
        const eqMethod = lookUpClassMember(
            ClassType.cloneAsInstantiable(leftType),
            '__eq__',
            MemberAccessFlags.SkipObjectBaseClass
        );

        if (eqMethod) {
            // If this is a synthesized method for a dataclass, we can assume
            // that other dataclass types will not be comparable.
            if (ClassType.isDataClass(leftType) && eqMethod.symbol.getSynthesizedType()) {
                return false;
            }

            return true;
        }

        return false;
    }

    return true;
}
