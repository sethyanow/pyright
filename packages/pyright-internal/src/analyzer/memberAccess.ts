// Member access, descriptor protocol, and method binding functions
// extracted from typeEvaluator.ts.

import { AnalyzerFileInfo } from './analyzerFileInfo';
import * as AnalyzerNodeInfo from './analyzerNodeInfo';
import { assert } from '../common/debug';
import { DiagnosticAddendum } from '../common/diagnostic';
import { LocAddendum, LocMessage } from '../localization/localize';
import { DiagnosticRule } from '../common/diagnosticRules';
import { ArgCategory, ExpressionNode, ParamCategory, ParseNode } from '../parser/parseNodes';
import * as ParseTreeUtils from './parseTreeUtils';
import { ConstraintTracker } from './constraintTracker';
import { DeclarationType, VariableDeclaration } from './declaration';
import * as specialForms from './specialForms';
import { makeTupleObject } from './tuples';
import { Symbol } from './symbol';
import { isEffectivelyClassVar } from './symbolUtils';
import { TypeEvaluatorState } from './typeEvaluatorState';
import { TypeRegistry } from './typeRegistry';
import * as TypePrinter from './typePrinter';
import * as typeAssignment from './typeAssignment';
import {
    Arg,
    AssignTypeFlags,
    CallResult,
    ClassMemberLookup,
    EvalFlags,
    EvaluatorUsage,
    MagicMethodDeprecationInfo,
    MemberAccessDeprecationInfo,
    TypeEvaluator,
    TypeResult,
} from './typeEvaluatorTypes';
import {
    AnyType,
    ClassType,
    findSubtype,
    FunctionParam,
    FunctionParamFlags,
    FunctionType,
    FunctionTypeFlags,
    isAnyOrUnknown,
    isClass,
    isClassInstance,
    isFunction,
    isFunctionOrOverloaded,
    isInstantiableClass,
    isNever,
    isParamSpec,
    isTypeVarTuple,
    isOverloaded,
    isTypeSame,
    isTypeVar,
    maxTypeRecursionCount,
    OverloadedType,
    Type,
    TypeBase,
    TypeVarType,
    UnknownType,
} from './types';
import {
    ClassMember,
    convertToInstance,
    convertToInstantiable,
    InferenceContext,
    isDescriptorInstance,
    getUnknownTypeForCallable,
    isInstantiableMetaclass,
    lookUpClassMember,
    MemberAccessFlags,
    isNoneInstance,
    isNoneTypeClass,
    isSentinelLiteral,
    isTypeAliasPlaceholder,
    makeFunctionTypeVarsBound,
    makeTypeVarsBound,
    mapSignatures,
    mapSubtypes,
    partiallySpecializeType,
    requiresSpecialization,
    selfSpecializeClass,
    specializeWithDefaultTypeArgs,
} from './typeUtils';

// If the function includes a `**kwargs: Unpack[TypedDict]` parameter, the
// parameter is expanded to include individual keyword args.
export function expandTypedKwargs(functionType: FunctionType): FunctionType {
    const kwargsIndex = functionType.shared.parameters.findIndex(
        (param) => param.category === ParamCategory.KwargsDict
    );
    if (kwargsIndex < 0) {
        return functionType;
    }
    assert(kwargsIndex === functionType.shared.parameters.length - 1);

    const kwargsType = FunctionType.getParamType(functionType, kwargsIndex);
    if (!isClassInstance(kwargsType) || !ClassType.isTypedDictClass(kwargsType) || !kwargsType.priv.isUnpacked) {
        return functionType;
    }

    const tdEntries = kwargsType.priv.typedDictNarrowedEntries ?? kwargsType.shared.typedDictEntries?.knownItems;
    if (!tdEntries) {
        return functionType;
    }

    const newFunction = FunctionType.clone(functionType);
    newFunction.shared.parameters.splice(kwargsIndex);
    if (newFunction.priv.specializedTypes) {
        newFunction.priv.specializedTypes.parameterTypes.splice(kwargsIndex);
    }

    const kwSeparatorIndex = functionType.shared.parameters.findIndex(
        (param) => param.category === ParamCategory.ArgsList
    );

    // Add a keyword separator if necessary.
    if (kwSeparatorIndex < 0 && tdEntries.size > 0) {
        FunctionType.addKeywordOnlyParamSeparator(newFunction);
    }

    tdEntries.forEach((tdEntry, name) => {
        FunctionType.addParam(
            newFunction,
            FunctionParam.create(
                ParamCategory.Simple,
                tdEntry.valueType,
                FunctionParamFlags.TypeDeclared,
                name,
                tdEntry.isRequired ? undefined : tdEntry.valueType
            )
        );
    });

    const extraItemsType = kwargsType.shared.typedDictEntries?.extraItems?.valueType;

    if (extraItemsType && !isNever(extraItemsType)) {
        FunctionType.addParam(
            newFunction,
            FunctionParam.create(ParamCategory.KwargsDict, extraItemsType, FunctionParamFlags.TypeDeclared, 'kwargs')
        );
    }

    return newFunction;
}

export function getTypeOfMember(evaluator: TypeEvaluator, member: ClassMember): Type {
    if (isInstantiableClass(member.classType)) {
        return partiallySpecializeType(
            evaluator.getEffectiveTypeOfSymbol(member.symbol),
            member.classType,
            evaluator.getTypeClassType(),
            /* selfClass */ undefined
        );
    }
    return UnknownType.create();
}

export function getGetterTypeFromProperty(evaluator: TypeEvaluator, propertyClass: ClassType): Type | undefined {
    if (!ClassType.isPropertyClass(propertyClass)) {
        return undefined;
    }

    if (propertyClass.priv.fgetInfo) {
        return (
            FunctionType.getEffectiveReturnType(propertyClass.priv.fgetInfo.methodType) ??
            evaluator.getInferredReturnType(propertyClass.priv.fgetInfo.methodType)
        );
    }

    return undefined;
}

export function bindFunctionToClassOrObject(
    evaluator: TypeEvaluator,
    baseType: ClassType | undefined,
    memberType: FunctionType | OverloadedType,
    memberClass?: ClassType,
    treatConstructorAsClassMethod = false,
    selfType?: ClassType | TypeVarType,
    diag?: DiagnosticAddendum,
    recursionCount = 0
): FunctionType | OverloadedType | undefined {
    return mapSignatures(memberType, (functionType) => {
        // If the caller specified no base type, always strip the
        // first parameter. This is used in cases like constructors.
        if (!baseType) {
            return FunctionType.clone(functionType, /* stripFirstParam */ true);
        }

        // If the first parameter was already stripped, it has already been
        // bound. Don't attempt to rebind.
        if (functionType.priv.strippedFirstParamType) {
            return functionType;
        }

        if (FunctionType.isInstanceMethod(functionType)) {
            // If the baseType is a metaclass, don't specialize the function.
            if (isInstantiableMetaclass(baseType)) {
                return functionType;
            }

            const baseObj: ClassType = isClassInstance(baseType)
                ? baseType
                : ClassType.cloneAsInstance(specializeWithDefaultTypeArgs(baseType));

            let stripFirstParam = false;
            if (isClassInstance(baseType)) {
                stripFirstParam = true;
            } else if (memberClass && isInstantiableMetaclass(memberClass)) {
                stripFirstParam = true;
            }

            return partiallySpecializeBoundMethod(
                evaluator,
                baseType,
                functionType,
                diag,
                recursionCount,
                selfType ?? baseObj,
                stripFirstParam
            );
        }

        if (
            FunctionType.isClassMethod(functionType) ||
            (treatConstructorAsClassMethod && FunctionType.isConstructorMethod(functionType))
        ) {
            const baseClass = isInstantiableClass(baseType) ? baseType : ClassType.cloneAsInstantiable(baseType);
            const clsType = selfType ? (convertToInstantiable(selfType) as ClassType | TypeVarType) : undefined;

            return partiallySpecializeBoundMethod(
                evaluator,
                baseClass,
                functionType,
                diag,
                recursionCount,
                clsType ?? baseClass,
                /* stripFirstParam */ true
            );
        }

        if (FunctionType.isStaticMethod(functionType)) {
            const baseClass = isInstantiableClass(baseType) ? baseType : ClassType.cloneAsInstantiable(baseType);

            return partiallySpecializeBoundMethod(
                evaluator,
                baseClass,
                functionType,
                diag,
                recursionCount,
                /* firstParamType */ undefined,
                /* stripFirstParam */ false
            );
        }

        return functionType;
    });
}

// Specializes the specified function for the specified class,
// optionally stripping the first first parameter (the "self" or "cls")
// off of the specialized function in the process. The baseType
// is the type used to reference the member.
function partiallySpecializeBoundMethod(
    evaluator: TypeEvaluator,
    baseType: ClassType,
    memberType: FunctionType,
    diag: DiagnosticAddendum | undefined,
    recursionCount: number,
    firstParamType: ClassType | TypeVarType | undefined,
    stripFirstParam = true
): FunctionType | undefined {
    const constraints = new ConstraintTracker();

    if (firstParamType) {
        if (memberType.shared.parameters.length > 0) {
            const memberTypeFirstParam = memberType.shared.parameters[0];
            const memberTypeFirstParamType = FunctionType.getParamType(memberType, 0);

            if (
                isTypeVar(memberTypeFirstParamType) &&
                memberTypeFirstParamType.shared.boundType &&
                isClassInstance(memberTypeFirstParamType.shared.boundType) &&
                ClassType.isProtocolClass(memberTypeFirstParamType.shared.boundType)
            ) {
                // Handle the protocol class specially. Some protocol classes
                // contain references to themselves or their subclasses, so if
                // we attempt to call assignType, we'll risk infinite recursion.
                // Instead, we'll assume it's assignable.
                constraints.setBounds(
                    memberTypeFirstParamType,
                    TypeBase.isInstantiable(memberTypeFirstParamType)
                        ? convertToInstance(firstParamType)
                        : firstParamType
                );
            } else {
                const subDiag = diag?.createAddendum();

                // Protect against the case where a callback protocol is being
                // bound to its own __call__ method but the first parameter
                // is annotated with its own callable type. This can lead to
                // infinite recursion.
                if (isFunctionOrOverloaded(memberTypeFirstParamType)) {
                    if (isClassInstance(firstParamType) && ClassType.isProtocolClass(firstParamType)) {
                        if (subDiag) {
                            subDiag.addMessage(
                                LocMessage.bindTypeMismatch().format({
                                    type: evaluator.printType(firstParamType),
                                    methodName: memberType.shared.name || '<anonymous>',
                                    paramName: memberTypeFirstParam.name || '__p0',
                                })
                            );
                        }
                        return undefined;
                    }
                }

                if (
                    !evaluator.assignType(
                        memberTypeFirstParamType,
                        firstParamType,
                        subDiag?.createAddendum(),
                        constraints,
                        AssignTypeFlags.AllowUnspecifiedTypeArgs,
                        recursionCount
                    )
                ) {
                    if (
                        memberTypeFirstParam.name &&
                        !FunctionParam.isNameSynthesized(memberTypeFirstParam) &&
                        FunctionParam.isTypeDeclared(memberTypeFirstParam)
                    ) {
                        if (subDiag) {
                            subDiag.addMessage(
                                LocMessage.bindTypeMismatch().format({
                                    type: evaluator.printType(firstParamType),
                                    methodName: memberType.shared.name || '<anonymous>',
                                    paramName: memberTypeFirstParam.name,
                                })
                            );
                        }
                        return undefined;
                    }
                }
            }
        } else {
            const subDiag = diag?.createAddendum();
            if (subDiag) {
                subDiag.addMessage(
                    LocMessage.bindParamMissing().format({
                        methodName: memberType.shared.name || '<anonymous>',
                    })
                );
            }
            return undefined;
        }
    }

    // Get the effective return type, which will have the side effect of lazily
    // evaluating (and caching) the inferred return type if there is no defined return type.
    FunctionType.getEffectiveReturnType(memberType) ?? evaluator.getInferredReturnType(memberType);

    const specializedFunction = evaluator.solveAndApplyConstraints(memberType, constraints);
    if (isFunction(specializedFunction)) {
        return FunctionType.clone(specializedFunction, stripFirstParam, baseType);
    }

    if (isOverloaded(specializedFunction)) {
        // For overloaded functions, use the first overload. This isn't
        // strictly correct, but this is an extreme edge case.
        return FunctionType.clone(OverloadedType.getOverloads(specializedFunction)[0], stripFirstParam, baseType);
    }

    return undefined;
}

export function getTypeOfMagicMethodCall(
    evaluator: TypeEvaluator,
    registry: TypeRegistry,
    objType: Type,
    methodName: string,
    argList: TypeResult[],
    errorNode: ExpressionNode,
    inferenceContext?: InferenceContext,
    diag?: DiagnosticAddendum
): TypeResult | undefined {
    let magicMethodSupported = true;
    let isIncomplete = false;
    let deprecationInfo: MagicMethodDeprecationInfo | undefined;
    const overloadsUsedForCall: FunctionType[] = [];

    // Create a helper lambda for object subtypes.
    const handleSubtype = (subtype: ClassType | TypeVarType) => {
        let magicMethodType: Type | undefined;
        const concreteSubtype = evaluator.makeTopLevelTypeVarsConcrete(subtype);

        if (isClass(concreteSubtype)) {
            magicMethodType = evaluator.getBoundMagicMethod(concreteSubtype, methodName, subtype, errorNode, diag);
        }

        if (magicMethodType) {
            const functionArgs: Arg[] = argList.map((arg) => {
                return {
                    argCategory: ArgCategory.Simple,
                    typeResult: arg,
                };
            });

            let callResult: CallResult | undefined;

            callResult = evaluator.useSpeculativeMode(errorNode, () => {
                assert(magicMethodType !== undefined);
                return evaluator.validateCallArgs(
                    errorNode,
                    functionArgs,
                    { type: magicMethodType },
                    /* constraints */ undefined,
                    /* skipUnknownArgCheck */ true,
                    inferenceContext
                );
            });

            // If there were errors with the expected type, try
            // to evaluate without the expected type.
            if (callResult.argumentErrors && inferenceContext) {
                callResult = evaluator.useSpeculativeMode(errorNode, () => {
                    assert(magicMethodType !== undefined);
                    return evaluator.validateCallArgs(
                        errorNode,
                        functionArgs,
                        { type: magicMethodType },
                        /* constraints */ undefined,
                        /* skipUnknownArgCheck */ true,
                        /* inferenceContext */ undefined
                    );
                });
            }

            if (callResult.argumentErrors) {
                magicMethodSupported = false;
            } else if (callResult.overloadsUsedForCall) {
                callResult.overloadsUsedForCall.forEach((overload) => {
                    overloadsUsedForCall.push(overload);

                    // If one of the overloads is deprecated, note the message.
                    if (overload.shared.deprecatedMessage && isClass(concreteSubtype)) {
                        deprecationInfo = {
                            deprecatedMessage: overload.shared.deprecatedMessage,
                            className: concreteSubtype.shared.name,
                            methodName,
                        };
                    }
                });
            }

            if (callResult.isTypeIncomplete) {
                isIncomplete = true;
            }

            return callResult.returnType;
        }

        magicMethodSupported = false;
        return undefined;
    };

    const returnType = mapSubtypes(objType, (subtype) => {
        if (isAnyOrUnknown(subtype)) {
            return subtype;
        }

        if (isClassInstance(subtype) || isInstantiableClass(subtype) || isTypeVar(subtype)) {
            return handleSubtype(subtype);
        }

        if (isNoneInstance(subtype)) {
            if (registry.objectClass && isInstantiableClass(registry.objectClass)) {
                // Use 'object' for 'None'.
                return handleSubtype(ClassType.cloneAsInstance(registry.objectClass));
            }
        }

        if (isNoneTypeClass(subtype)) {
            if (registry.typeClass && isInstantiableClass(registry.typeClass)) {
                // Use 'type' for 'type[None]'.
                return handleSubtype(ClassType.cloneAsInstance(registry.typeClass));
            }
        }

        magicMethodSupported = false;
        return undefined;
    });

    if (!magicMethodSupported) {
        return undefined;
    }

    return { type: returnType, isIncomplete, magicMethodDeprecationInfo: deprecationInfo, overloadsUsedForCall };
}

export function isSymbolValidTypeExpression(type: Type, includesVarDecl: boolean): boolean {
    // Verify that the name does not refer to a (non type alias) variable.
    if (!includesVarDecl || type.props?.typeAliasInfo) {
        return true;
    }

    if (isTypeAliasPlaceholder(type)) {
        return true;
    }

    if (isTypeVar(type)) {
        if (type.props?.specialForm || type.props?.typeAliasInfo) {
            return true;
        }
    }

    // Exempts class types that are created by calling NewType, NamedTuple, etc.
    if (isClass(type) && !type.priv.includeSubclasses && ClassType.isValidTypeAliasClass(type)) {
        return true;
    }

    if (isSentinelLiteral(type)) {
        return true;
    }

    return false;
}

export function specializeTypeAliasWithDefaults(
    evaluator: TypeEvaluator,
    registry: TypeRegistry,
    type: Type,
    errorNode: ExpressionNode | undefined
) {
    // Is this a type alias?
    const aliasInfo = type.props?.typeAliasInfo;
    if (!aliasInfo) {
        return type;
    }

    // Is this a generic type alias that needs specializing?
    if (!aliasInfo.shared.typeParams || aliasInfo.shared.typeParams.length === 0 || aliasInfo.typeArgs) {
        return type;
    }

    let reportDiag = false;
    const defaultTypeArgs: Type[] = [];
    const constraints = new ConstraintTracker();

    aliasInfo.shared.typeParams.forEach((param) => {
        if (!param.shared.isDefaultExplicit) {
            reportDiag = true;
        }

        let defaultType: Type;
        if (param.shared.isDefaultExplicit || isParamSpec(param)) {
            defaultType = evaluator.solveAndApplyConstraints(param, constraints, {
                replaceUnsolved: {
                    scopeIds: [aliasInfo.shared.typeVarScopeId],
                    tupleClassType: evaluator.getTupleClassType(),
                },
            });
        } else if (isTypeVarTuple(param) && registry.tupleClass && isInstantiableClass(registry.tupleClass)) {
            defaultType = makeTupleObject(
                evaluator,
                [{ type: UnknownType.create(), isUnbounded: true }],
                /* isUnpacked */ true
            );
        } else {
            defaultType = UnknownType.create();
        }

        defaultTypeArgs.push(defaultType);
        constraints.setBounds(param, defaultType);
    });

    if (reportDiag && errorNode) {
        evaluator.addDiagnostic(
            DiagnosticRule.reportMissingTypeArgument,
            LocMessage.typeArgsMissingForAlias().format({
                name: aliasInfo.shared.name,
            }),
            errorNode
        );
    }

    type = TypeBase.cloneForTypeAlias(
        evaluator.solveAndApplyConstraints(type, constraints, {
            replaceUnsolved: {
                scopeIds: [aliasInfo.shared.typeVarScopeId],
                tupleClassType: evaluator.getTupleClassType(),
            },
        }),
        { ...aliasInfo, typeArgs: defaultTypeArgs }
    );

    return type;
}

export function addTypeFormForSymbol(
    evaluator: TypeEvaluator,
    registry: TypeRegistry,
    node: ExpressionNode,
    type: Type,
    flags: EvalFlags,
    includesVarDecl: boolean
): Type {
    if (!specialForms.isTypeFormSupported(node)) {
        return type;
    }

    const isValid = isSymbolValidTypeExpression(type, includesVarDecl);

    // If the type already has type information associated with it, don't replace.
    if (type.props?.typeForm) {
        // If the NoConvertSpecialForm flag is set, we are evaluating in
        // the interior of a type expression, so variables are not allowed.
        // Clear any existing type form type for this symbol in this case.
        if ((flags & EvalFlags.NoConvertSpecialForm) !== 0 && !isValid) {
            type = TypeBase.cloneWithTypeForm(type, undefined);
        }
        return type;
    }

    // If the symbol is not valid for a type expression (e.g. it's a variable),
    // don't add TypeForm info.
    if (!isValid) {
        return type;
    }

    if (isTypeVar(type) && type.priv.scopeId && !type.shared.isSynthesized) {
        if (!isTypeVarTuple(type) || !type.priv.isInUnion) {
            const liveScopeIds = ParseTreeUtils.getTypeVarScopesForNode(node);
            type = TypeBase.cloneWithTypeForm(type, convertToInstance(makeTypeVarsBound(type, liveScopeIds)));
        }
    } else if (isInstantiableClass(type) && !type.priv.includeSubclasses && !ClassType.isSpecialBuiltIn(type)) {
        if (ClassType.isBuiltIn(type, 'Any')) {
            type = TypeBase.cloneWithTypeForm(type, AnyType.create());
        } else {
            type = TypeBase.cloneWithTypeForm(type, ClassType.cloneAsInstance(specializeWithDefaultTypeArgs(type)));
        }
    }

    if (type.props?.typeAliasInfo && TypeBase.isInstantiable(type)) {
        let typeFormType = type;
        if ((flags & EvalFlags.NoSpecialize) === 0) {
            typeFormType = specializeTypeAliasWithDefaults(
                evaluator,
                registry,
                typeFormType,
                /* errorNode */ undefined
            );
        }

        type = TypeBase.cloneWithTypeForm(type, convertToInstance(typeFormType));
    }

    return type;
}

export function setSymbolAccessed(
    state: TypeEvaluatorState,
    fileInfo: AnalyzerFileInfo,
    symbol: Symbol,
    node: ParseNode
) {
    if (!state.isSpeculativeModeInUse(node)) {
        fileInfo.accessedSymbolSet.add(symbol.id);
    }
}

export function isAsymmetricDescriptorClass(evaluator: TypeEvaluator, classType: ClassType): boolean {
    // If the value has already been cached in this type, return the cached value.
    if (classType.priv.isAsymmetricDescriptor !== undefined) {
        return classType.priv.isAsymmetricDescriptor;
    }

    let isAsymmetric = false;

    const getterSymbolResult = lookUpClassMember(classType, '__get__', MemberAccessFlags.SkipBaseClasses);
    const setterSymbolResult = lookUpClassMember(classType, '__set__', MemberAccessFlags.SkipBaseClasses);

    if (!getterSymbolResult || !setterSymbolResult) {
        isAsymmetric = false;
    } else {
        let getterType = getTypeOfMember(evaluator, getterSymbolResult);
        const setterType = getTypeOfMember(evaluator, setterSymbolResult);

        // If this is an overload, find the appropriate overload.
        if (isOverloaded(getterType)) {
            const getOverloads = OverloadedType.getOverloads(getterType).filter((overload) => {
                if (overload.shared.parameters.length < 2) {
                    return false;
                }
                const param1Type = FunctionType.getParamType(overload, 1);
                return !isNoneInstance(param1Type);
            });

            if (getOverloads.length === 1) {
                getterType = getOverloads[0];
            } else {
                isAsymmetric = true;
            }
        }

        // If this is an overload, find the appropriate overload.
        if (isOverloaded(setterType)) {
            isAsymmetric = true;
        }

        // If either the setter or getter is an overload (or some other non-function type),
        // conservatively assume that it's not asymmetric.
        if (isFunction(getterType) && isFunction(setterType)) {
            // If there's no declared return type on the getter, assume it's symmetric.
            if (setterType.shared.parameters.length >= 3 && getterType.shared.declaredReturnType) {
                const setterValueType = FunctionType.getParamType(setterType, 2);
                const getterReturnType = FunctionType.getEffectiveReturnType(getterType) ?? UnknownType.create();

                if (!isTypeSame(setterValueType, getterReturnType)) {
                    isAsymmetric = true;
                }
            }
        }
    }

    // Cache the value for next time.
    classType.priv.isAsymmetricDescriptor = isAsymmetric;
    return isAsymmetric;
}

export function isClassWithAsymmetricAttributeAccessor(evaluator: TypeEvaluator, classType: ClassType): boolean {
    // If the value has already been cached in this type, return the cached value.
    if (classType.priv.isAsymmetricAttributeAccessor !== undefined) {
        return classType.priv.isAsymmetricAttributeAccessor;
    }

    let isAsymmetric = false;

    const getterSymbolResult = lookUpClassMember(classType, '__getattr__', MemberAccessFlags.SkipBaseClasses);
    const setterSymbolResult = lookUpClassMember(classType, '__setattr__', MemberAccessFlags.SkipBaseClasses);

    if (!getterSymbolResult || !setterSymbolResult) {
        isAsymmetric = false;
    } else {
        const getterType = evaluator.getEffectiveTypeOfSymbol(getterSymbolResult.symbol);
        const setterType = evaluator.getEffectiveTypeOfSymbol(setterSymbolResult.symbol);

        // If either the setter or getter is an overload (or some other non-function type),
        // conservatively assume that it's not asymmetric.
        if (isFunction(getterType) && isFunction(setterType)) {
            // If there's no declared return type on the getter, assume it's symmetric.
            if (setterType.shared.parameters.length >= 3 && getterType.shared.declaredReturnType) {
                const setterValueType = FunctionType.getParamType(setterType, 2);
                const getterReturnType = FunctionType.getEffectiveReturnType(getterType) ?? UnknownType.create();

                if (!isTypeSame(setterValueType, getterReturnType)) {
                    isAsymmetric = true;
                }
            }
        }
    }

    // Cache the value for next time.
    classType.priv.isAsymmetricAttributeAccessor = isAsymmetric;
    return isAsymmetric;
}

export interface MemberAccessTypeResult {
    type: Type;
    isDescriptorApplied?: boolean;
    isAsymmetricAccessor?: boolean;
    memberAccessDeprecationInfo?: import('./typeEvaluatorTypes').MemberAccessDeprecationInfo;
    typeErrors?: boolean;
}

// Applies the __getattr__, __setattr__ or __delattr__ method if present.
// If it's not applicable, returns undefined.
export function applyAttributeAccessOverride(
    evaluator: TypeEvaluator,
    state: TypeEvaluatorState,
    registry: TypeRegistry,
    errorNode: ExpressionNode,
    classType: ClassType,
    usage: EvaluatorUsage,
    memberName: string,
    selfType?: ClassType | TypeVarType
): MemberAccessTypeResult | undefined {
    const getAttributeAccessMemberType = (name: string) => {
        return getTypeOfBoundMember(
            evaluator,
            state,
            registry,
            errorNode,
            classType,
            name,
            /* usage */ undefined,
            /* diag */ undefined,
            MemberAccessFlags.SkipInstanceMembers |
                MemberAccessFlags.SkipObjectBaseClass |
                MemberAccessFlags.SkipTypeBaseClass |
                MemberAccessFlags.SkipAttributeAccessOverride,
            selfType
        )?.type;
    };

    let accessMemberType: Type | undefined;
    if (usage.method === 'get') {
        accessMemberType =
            getAttributeAccessMemberType('__getattribute__') ?? getAttributeAccessMemberType('__getattr__');
    } else if (usage.method === 'set') {
        accessMemberType = getAttributeAccessMemberType('__setattr__');
    } else {
        assert(usage.method === 'del');
        accessMemberType = getAttributeAccessMemberType('__delattr__');
    }

    if (!accessMemberType) {
        return undefined;
    }

    const argList: Arg[] = [];

    // Provide "name" argument.
    argList.push({
        argCategory: ArgCategory.Simple,
        typeResult: {
            type:
                registry.strClass && isInstantiableClass(registry.strClass)
                    ? ClassType.cloneWithLiteral(ClassType.cloneAsInstance(registry.strClass), memberName)
                    : AnyType.create(),
        },
    });

    if (usage.method === 'set') {
        // Provide "value" argument.
        argList.push({
            argCategory: ArgCategory.Simple,
            typeResult: {
                type: usage.setType?.type ?? UnknownType.create(),
                isIncomplete: !!usage.setType?.isIncomplete,
            },
        });
    }

    if (!isFunctionOrOverloaded(accessMemberType)) {
        if (isAnyOrUnknown(accessMemberType)) {
            return { type: accessMemberType };
        }

        // TODO - emit an error for this condition.
        return undefined;
    }

    const callResult = evaluator.validateCallArgs(
        errorNode,
        argList,
        { type: accessMemberType },
        /* constraints */ undefined,
        /* skipUnknownArgCheck */ true,
        /* inferenceContext */ undefined
    );

    let isAsymmetricAccessor = false;
    if (usage.method === 'set') {
        isAsymmetricAccessor = isClassWithAsymmetricAttributeAccessor(evaluator, classType);
    }

    return {
        type: callResult.returnType ?? UnknownType.create(),
        typeErrors: callResult.argumentErrors,
        isAsymmetricAccessor,
    };
}

export function bindMethodForMemberAccess(
    evaluator: TypeEvaluator,
    type: Type,
    concreteType: FunctionType | OverloadedType,
    memberInfo: ClassMember | undefined,
    classType: ClassType,
    selfType: ClassType | TypeVarType | undefined,
    flags: MemberAccessFlags,
    memberName: string,
    usage: EvaluatorUsage,
    diag: DiagnosticAddendum | undefined,
    recursionCount = 0
): TypeResult {
    // Check for an attempt to overwrite a final method.
    if (usage.method === 'set') {
        const impl = isFunction(concreteType) ? concreteType : OverloadedType.getImplementation(concreteType);

        if (impl && isFunction(impl) && FunctionType.isFinal(impl) && memberInfo && isClass(memberInfo.classType)) {
            diag?.addMessage(
                LocMessage.finalMethodOverride().format({
                    name: memberName,
                    className: memberInfo.classType.shared.name,
                })
            );

            return { type: UnknownType.create(), typeErrors: true };
        }
    }

    // If this function is an instance member (e.g. a lambda that was
    // assigned to an instance variable), don't perform any binding.
    if (TypeBase.isInstance(classType)) {
        if (!memberInfo || memberInfo.isInstanceMember) {
            return { type: type };
        }
    }

    const boundType = bindFunctionToClassOrObject(
        evaluator,
        classType,
        concreteType,
        memberInfo && isInstantiableClass(memberInfo.classType) ? memberInfo.classType : undefined,
        (flags & MemberAccessFlags.TreatConstructorAsClassMethod) !== 0,
        selfType && isClass(selfType) ? ClassType.cloneIncludeSubclasses(selfType) : selfType,
        diag,
        recursionCount
    );

    return { type: boundType ?? UnknownType.create(), typeErrors: !boundType };
}

export function applyDescriptorAccessMethod(
    evaluator: TypeEvaluator,
    state: TypeEvaluatorState,
    registry: TypeRegistry,
    memberType: Type,
    concreteMemberType: ClassType,
    memberInfo: ClassMember | undefined,
    classType: ClassType,
    selfType: ClassType | TypeVarType | undefined,
    flags: MemberAccessFlags,
    errorNode: ExpressionNode,
    memberName: string,
    usage: EvaluatorUsage,
    diag: DiagnosticAddendum | undefined
): MemberAccessTypeResult {
    const isAccessedThroughObject = TypeBase.isInstance(classType);

    let accessMethodName: string;
    if (usage.method === 'get') {
        accessMethodName = '__get__';
    } else if (usage.method === 'set') {
        accessMethodName = '__set__';
    } else {
        accessMethodName = '__delete__';
    }

    const subDiag = diag ? new DiagnosticAddendum() : undefined;

    const methodTypeResult = getTypeOfBoundMember(
        evaluator,
        state,
        registry,
        errorNode,
        concreteMemberType,
        accessMethodName,
        /* usage */ undefined,
        subDiag,
        MemberAccessFlags.SkipInstanceMembers | MemberAccessFlags.SkipAttributeAccessOverride
    );

    if (!methodTypeResult || methodTypeResult.typeErrors) {
        // Provide special error messages for properties.
        if (ClassType.isPropertyClass(concreteMemberType) && usage.method !== 'get') {
            const message =
                usage.method === 'set' ? LocAddendum.propertyMissingSetter() : LocAddendum.propertyMissingDeleter();
            diag?.addMessage(message.format({ name: memberName }));
            return { type: AnyType.create(), typeErrors: true };
        }

        if (classType.shared.typeVarScopeId) {
            memberType = makeTypeVarsBound(memberType, [classType.shared.typeVarScopeId]);
        }

        return { type: memberType };
    }

    const methodClassType = methodTypeResult.classType;
    let methodType = methodTypeResult.type;

    if (methodTypeResult.typeErrors || !methodClassType) {
        if (diag && subDiag) {
            diag.addAddendum(subDiag);
        }
        return { type: UnknownType.create(), typeErrors: true };
    }

    if (!isFunctionOrOverloaded(methodType)) {
        if (isAnyOrUnknown(methodType)) {
            return { type: methodType };
        }

        // TODO - emit an error for this condition.
        return { type: memberType, typeErrors: true };
    }

    // Special-case logic for properties.
    if (
        ClassType.isPropertyClass(concreteMemberType) &&
        memberInfo &&
        isInstantiableClass(memberInfo.classType) &&
        methodType
    ) {
        if ((flags & MemberAccessFlags.SkipInstanceMembers) !== 0 && ClassType.isProtocolClass(classType)) {
            diag?.addMessage(LocAddendum.propertyAccessFromProtocolClass());
            return { type: memberType, typeErrors: true };
        }

        evaluator.inferReturnTypeIfNecessary(methodType);

        let accessMethodClass: ClassType | undefined;
        if (usage.method === 'get') {
            accessMethodClass = concreteMemberType.priv.fgetInfo?.classType;
        } else if (usage.method === 'set') {
            accessMethodClass = concreteMemberType.priv.fsetInfo?.classType;
        } else {
            accessMethodClass = concreteMemberType.priv.fdelInfo?.classType;
        }

        if (accessMethodClass) {
            const constraints = new ConstraintTracker();
            accessMethodClass = selfSpecializeClass(accessMethodClass);
            evaluator.assignType(
                ClassType.cloneAsInstance(accessMethodClass),
                ClassType.cloneAsInstance(memberInfo.classType),
                /* diag */ undefined,
                constraints
            );
            accessMethodClass = evaluator.solveAndApplyConstraints(accessMethodClass, constraints) as ClassType;

            const specializedType = partiallySpecializeType(
                methodType,
                accessMethodClass,
                evaluator.getTypeClassType(),
                selfType ? (convertToInstantiable(selfType) as ClassType | TypeVarType) : classType
            );

            if (isFunctionOrOverloaded(specializedType)) {
                methodType = specializedType;
            }
        }
    }

    // Determine if we're calling __set__ on an asymmetric descriptor or property.
    let isAsymmetricAccessor = false;
    if (usage.method === 'set' && isClass(methodClassType)) {
        if (isAsymmetricDescriptorClass(evaluator, methodClassType)) {
            isAsymmetricAccessor = true;
        }
    }

    if (!methodType) {
        diag?.addMessage(
            LocAddendum.descriptorAccessBindingFailed().format({
                name: accessMethodName,
                className: evaluator.printType(convertToInstance(methodClassType)),
            })
        );

        return {
            type: UnknownType.create(),
            typeErrors: true,
            isDescriptorApplied: true,
            isAsymmetricAccessor,
        };
    }

    // Simulate a call to the access method.
    const argList: Arg[] = [];

    // Provide "obj" argument.
    let objArgType: Type;
    if (ClassType.isClassProperty(concreteMemberType)) {
        objArgType = isAccessedThroughObject ? ClassType.cloneAsInstantiable(classType) : classType;
    } else if (isAccessedThroughObject) {
        objArgType = selfType ?? ClassType.cloneAsInstance(classType);
    } else {
        objArgType = evaluator.getNoneType();
    }

    argList.push({
        argCategory: ArgCategory.Simple,
        typeResult: { type: objArgType },
    });

    if (usage.method === 'get') {
        let classArgType: Type;
        if (selfType) {
            classArgType = convertToInstantiable(selfType);
        } else {
            classArgType = isAccessedThroughObject ? ClassType.cloneAsInstantiable(classType) : classType;
        }

        // Provide "owner" argument.
        argList.push({
            argCategory: ArgCategory.Simple,
            typeResult: { type: classArgType },
        });
    } else if (usage.method === 'set') {
        // Provide "value" argument.
        argList.push({
            argCategory: ArgCategory.Simple,
            typeResult: {
                type: usage.setType?.type ?? UnknownType.create(),
                isIncomplete: !!usage.setType?.isIncomplete,
            },
        });
    }

    // Suppress diagnostics for these method calls because they would be redundant.
    const callResult = state.suppressDiagnostics(
        errorNode,
        () => {
            return evaluator.validateCallArgs(
                errorNode,
                argList,
                { type: methodType },
                /* constraints */ undefined,
                /* skipUnknownArgCheck */ true,
                /* inferenceContext */ undefined
            );
        },
        (suppressedDiags) => {
            if (diag) {
                suppressedDiags.forEach((message) => {
                    diag?.addMessageMultiline(message);
                });
            }
        }
    );

    // Collect deprecation information associated with the member access method.
    let deprecationInfo: MemberAccessDeprecationInfo | undefined;
    if (callResult.overloadsUsedForCall && callResult.overloadsUsedForCall.length >= 1) {
        const overloadUsed = callResult.overloadsUsedForCall[0];
        if (overloadUsed.shared.deprecatedMessage) {
            deprecationInfo = {
                deprecatedMessage: overloadUsed.shared.deprecatedMessage,
                accessType: ClassType.isPropertyClass(concreteMemberType) ? 'property' : 'descriptor',
                accessMethod: usage.method,
            };
        }
    }

    if (!callResult.argumentErrors) {
        return {
            // For set or delete, always return Any.
            type: usage.method === 'get' ? callResult.returnType ?? UnknownType.create() : AnyType.create(),
            isDescriptorApplied: true,
            isAsymmetricAccessor,
            memberAccessDeprecationInfo: deprecationInfo,
        };
    }

    return {
        type: UnknownType.create(),
        typeErrors: true,
        isDescriptorApplied: true,
        isAsymmetricAccessor,
        memberAccessDeprecationInfo: deprecationInfo,
    };
}

export function validateSymbolIsTypeExpression(
    evaluator: TypeEvaluator,
    node: ExpressionNode,
    type: Type,
    includesVarDecl: boolean
): Type {
    if (isSymbolValidTypeExpression(type, includesVarDecl)) {
        return type;
    }

    // Disable for assignments in the typings.pyi file, since it defines special forms.
    const fileInfo = AnalyzerNodeInfo.getFileInfo(node);
    if (fileInfo.isTypingStubFile) {
        return type;
    }

    evaluator.addDiagnostic(DiagnosticRule.reportInvalidTypeForm, LocMessage.typeAnnotationVariable(), node);
    return UnknownType.create();
}

export function getTypeOfMemberInternal(
    evaluator: TypeEvaluator,
    errorNode: ExpressionNode | undefined,
    member: ClassMember,
    selfClass: ClassType | TypeVarType | undefined,
    flags: MemberAccessFlags
): TypeResult | undefined {
    if (isAnyOrUnknown(member.classType)) {
        return {
            type: member.classType,
            isIncomplete: false,
        };
    }

    if (!isInstantiableClass(member.classType)) {
        return undefined;
    }

    const typeResult = evaluator.getEffectiveTypeOfSymbolForUsage(member.symbol);

    if (!typeResult) {
        return undefined;
    }

    // Report inappropriate use of variables in type expressions.
    if ((flags & MemberAccessFlags.TypeExpression) !== 0 && errorNode) {
        typeResult.type = validateSymbolIsTypeExpression(
            evaluator,
            errorNode,
            typeResult.type,
            !!typeResult.includesVariableDecl
        );
    }

    // If the type is a function or overloaded function, infer
    // and cache the return type if necessary. This needs to be done
    // prior to specializing.
    evaluator.inferReturnTypeIfNecessary(typeResult.type);

    // Check for ambiguous accesses to attributes with generic types?
    if (
        errorNode &&
        selfClass &&
        isClass(selfClass) &&
        member.isInstanceMember &&
        isClass(member.unspecializedClassType) &&
        (flags & MemberAccessFlags.DisallowGenericInstanceVariableAccess) !== 0 &&
        requiresSpecialization(typeResult.type, { ignoreSelf: true, ignoreImplicitTypeArgs: true })
    ) {
        const specializedType = partiallySpecializeType(
            typeResult.type,
            member.unspecializedClassType,
            evaluator.getTypeClassType(),
            selfSpecializeClass(selfClass, { overrideTypeArgs: true })
        );

        if (
            findSubtype(
                specializedType,
                (subtype) =>
                    !isFunctionOrOverloaded(subtype) &&
                    requiresSpecialization(subtype, { ignoreSelf: true, ignoreImplicitTypeArgs: true })
            )
        ) {
            evaluator.addDiagnostic(
                DiagnosticRule.reportGeneralTypeIssues,
                LocMessage.genericInstanceVariableAccess(),
                errorNode
            );
        }
    }

    return {
        type: partiallySpecializeType(typeResult.type, member.classType, evaluator.getTypeClassType(), selfClass),
        isIncomplete: !!typeResult.isIncomplete,
    };
}

export function getTypeOfClassMemberName(
    evaluator: TypeEvaluator,
    state: TypeEvaluatorState,
    registry: TypeRegistry,
    errorNode: ExpressionNode | undefined,
    classType: ClassType,
    memberName: string,
    usage: EvaluatorUsage,
    diag: DiagnosticAddendum | undefined,
    flags: MemberAccessFlags,
    selfType?: ClassType | TypeVarType,
    recursionCount = 0
): ClassMemberLookup | undefined {
    const isAccessedThroughObject = TypeBase.isInstance(classType);

    // Always look for a member with a declared type first.
    let memberInfo = lookUpClassMember(classType, memberName, flags | MemberAccessFlags.DeclaredTypesOnly);

    // If we couldn't find a symbol with a declared type, use
    // a symbol with an inferred type.
    if (!memberInfo) {
        memberInfo = lookUpClassMember(classType, memberName, flags);
    }

    if (!memberInfo) {
        if ((flags & MemberAccessFlags.SkipAttributeAccessOverride) === 0 && errorNode) {
            const generalAttrType = applyAttributeAccessOverride(
                evaluator,
                state,
                registry,
                errorNode,
                classType,
                usage,
                memberName,
                selfType
            );
            if (generalAttrType) {
                return {
                    symbol: undefined,
                    type: generalAttrType.type,
                    isTypeIncomplete: false,
                    isDescriptorError: false,
                    isClassMember: false,
                    isClassVar: false,
                    isAsymmetricAccessor: !!generalAttrType.isAsymmetricAccessor,
                };
            }
        }

        diag?.addMessage(LocAddendum.memberUnknown().format({ name: memberName }));
        return undefined;
    }

    let type: Type | undefined;
    let isTypeIncomplete = false;
    let narrowedTypeForSet: Type | undefined;

    if (memberInfo.symbol.isInitVar()) {
        diag?.addMessage(LocAddendum.memberIsInitVar().format({ name: memberName }));
        return undefined;
    }

    if (usage.method !== 'get' && errorNode) {
        const containingClass = ParseTreeUtils.getEnclosingClass(errorNode);
        if (containingClass) {
            const containingClassType = evaluator.getTypeOfClass(containingClass)?.classType;
            if (
                containingClassType &&
                isInstantiableClass(containingClassType) &&
                ClassType.isSameGenericClass(
                    isAccessedThroughObject ? ClassType.cloneAsInstance(containingClassType) : containingClassType,
                    classType
                )
            ) {
                type = evaluator.getDeclaredTypeOfSymbol(memberInfo.symbol)?.type;
                if (type && isInstantiableClass(memberInfo.classType)) {
                    type = partiallySpecializeType(type, memberInfo.classType, /* typeClassType */ undefined, selfType);
                }

                if (
                    usage.method === 'set' &&
                    isEffectivelyClassVar(memberInfo.symbol, ClassType.isDataClass(containingClassType)) &&
                    isAccessedThroughObject
                ) {
                    const selfClass = selfType ?? memberName === '__new__' ? undefined : classType;
                    const typeResult = getTypeOfMemberInternal(evaluator, errorNode, memberInfo, selfClass, flags);

                    if (typeResult) {
                        if (isDescriptorInstance(typeResult.type, /* requireSetter */ true)) {
                            type = typeResult.type;
                            flags &= MemberAccessFlags.DisallowClassVarWrites;
                        }
                    }
                }

                if (!type) {
                    type = UnknownType.create();
                }
            }
        }
    }

    if (!type) {
        let selfClass: ClassType | TypeVarType | undefined;

        if (selfType) {
            selfClass = convertToInstantiable(selfType) as TypeVarType | ClassType;
        } else {
            if (memberName !== '__new__') {
                selfClass = classType;
            }
        }

        const typeResult = getTypeOfMemberInternal(evaluator, errorNode, memberInfo, selfClass, flags);

        type = typeResult?.type ?? UnknownType.create();
        if (typeResult?.isIncomplete) {
            isTypeIncomplete = true;
        }
    }

    // Don't include variables within typed dict classes.
    if (isClass(memberInfo.classType) && ClassType.isTypedDictClass(memberInfo.classType)) {
        const typedDecls = memberInfo.symbol.getTypedDeclarations();
        if (typedDecls.length > 0 && typedDecls[0].type === DeclarationType.Variable) {
            diag?.addMessage(LocAddendum.memberUnknown().format({ name: memberName }));
            return undefined;
        }
    }

    if (usage.method === 'get') {
        if (
            errorNode &&
            isInstantiableClass(memberInfo.classType) &&
            ClassType.isSameGenericClass(
                memberInfo.classType,
                isAccessedThroughObject ? ClassType.cloneAsInstantiable(classType) : classType
            )
        ) {
            setSymbolAccessed(state, AnalyzerNodeInfo.getFileInfo(errorNode), memberInfo.symbol, errorNode);
        }

        if (memberName === '__init_subclass__' || memberName === '__class_getitem__') {
            if (isFunction(type) && !FunctionType.isClassMethod(type)) {
                type = FunctionType.cloneWithNewFlags(type, type.shared.flags | FunctionTypeFlags.ClassMethod);
            }
        }
    }

    let isDescriptorError = false;
    let isAsymmetricAccessor = false;
    let isDescriptorApplied = false;
    let memberAccessDeprecationInfo: MemberAccessDeprecationInfo | undefined;

    type = mapSubtypes(
        type,
        (subtype) => {
            const concreteSubtype = evaluator.makeTopLevelTypeVarsConcrete(subtype);
            const isClassMember = !memberInfo || (memberInfo.isClassMember && !memberInfo.isSlotsMember);
            let resultType: Type;

            if (isClass(concreteSubtype) && isClassMember && errorNode) {
                const descResult = applyDescriptorAccessMethod(
                    evaluator,
                    state,
                    registry,
                    subtype,
                    concreteSubtype,
                    memberInfo,
                    classType,
                    selfType,
                    flags,
                    errorNode,
                    memberName,
                    usage,
                    diag
                );

                if (descResult.isAsymmetricAccessor) {
                    isAsymmetricAccessor = true;
                }

                if (descResult.memberAccessDeprecationInfo) {
                    memberAccessDeprecationInfo = descResult.memberAccessDeprecationInfo;
                }

                if (descResult.typeErrors) {
                    isDescriptorError = true;
                }

                if (descResult.isDescriptorApplied) {
                    isDescriptorApplied = true;
                }

                resultType = descResult.type;
            } else if (isFunctionOrOverloaded(concreteSubtype) && TypeBase.isInstance(concreteSubtype)) {
                const typeResult = bindMethodForMemberAccess(
                    evaluator,
                    subtype,
                    concreteSubtype,
                    memberInfo,
                    classType,
                    selfType,
                    flags,
                    memberName,
                    usage,
                    diag,
                    recursionCount
                );

                resultType = typeResult.type;
                if (typeResult.typeErrors) {
                    isDescriptorError = true;
                }
            } else {
                resultType = subtype;
            }

            if (usage.method === 'get') {
                return resultType;
            }

            if (
                !isDescriptorApplied &&
                memberInfo &&
                isEffectivelyClassVar(memberInfo.symbol, ClassType.isDataClass(classType)) &&
                (flags & MemberAccessFlags.DisallowClassVarWrites) !== 0
            ) {
                diag?.addMessage(LocAddendum.memberSetClassVar().format({ name: memberName }));
                isDescriptorError = true;
            }

            const finalVarTypeDecl = memberInfo?.symbol
                .getDeclarations()
                .find((decl) => evaluator.isFinalVariableDeclaration(decl));

            if (
                finalVarTypeDecl &&
                errorNode &&
                !ParseTreeUtils.isNodeContainedWithin(errorNode, finalVarTypeDecl.node)
            ) {
                const enclosingFunctionNode = ParseTreeUtils.getEnclosingFunction(errorNode);
                if (
                    !enclosingFunctionNode ||
                    enclosingFunctionNode.d.name.d.value !== '__init__' ||
                    (finalVarTypeDecl as VariableDeclaration).inferredTypeSource !== undefined ||
                    isInstantiableClass(classType)
                ) {
                    diag?.addMessage(LocMessage.finalReassigned().format({ name: memberName }));
                    isDescriptorError = true;
                }
            }

            if (memberInfo?.isInstanceMember && isClass(memberInfo.classType) && memberInfo.isReadOnly) {
                diag?.addMessage(LocAddendum.readOnlyAttribute().format({ name: memberName }));
                isDescriptorError = true;
            }

            return resultType;
        },
        { retainTypeAlias: true }
    );

    if (!isDescriptorError && usage.method === 'set' && usage.setType) {
        if (errorNode && memberInfo.symbol.hasTypedDeclarations()) {
            narrowedTypeForSet = isDescriptorApplied
                ? usage.setType.type
                : typeAssignment.narrowTypeBasedOnAssignment(evaluator, registry, state, type, usage.setType).type;
        }

        if (!evaluator.assignType(type, usage.setType.type, diag?.createAddendum())) {
            if (!usage.setType.isIncomplete) {
                diag?.addMessage(
                    LocAddendum.memberAssignment().format({
                        type: evaluator.printType(usage.setType.type),
                        name: memberName,
                        classType: TypePrinter.printObjectTypeForClass(
                            classType,
                            state.evaluatorOptions.printTypeFlags,
                            (t: FunctionType) =>
                                FunctionType.getEffectiveReturnType(t) ?? evaluator.getInferredReturnType(t)
                        ),
                    })
                );
            }

            narrowedTypeForSet = type;
            isDescriptorError = true;
        }

        if (
            isInstantiableClass(memberInfo.classType) &&
            ClassType.isDataClassFrozen(memberInfo.classType) &&
            isAccessedThroughObject
        ) {
            diag?.addMessage(
                LocAddendum.dataClassFrozen().format({
                    name: evaluator.printType(ClassType.cloneAsInstance(memberInfo.classType)),
                })
            );

            isDescriptorError = true;
        }
    }

    return {
        symbol: memberInfo.symbol,
        type,
        isTypeIncomplete,
        isDescriptorError,
        isClassMember: !memberInfo.isInstanceMember,
        isClassVar: memberInfo.isClassVar,
        classType: memberInfo.classType,
        isAsymmetricAccessor,
        narrowedTypeForSet,
        memberAccessDeprecationInfo,
    };
}

export function getTypeOfBoundMember(
    evaluator: TypeEvaluator,
    state: TypeEvaluatorState,
    registry: TypeRegistry,
    errorNode: ExpressionNode | undefined,
    objectType: ClassType,
    memberName: string,
    usage: EvaluatorUsage = { method: 'get' },
    diag: DiagnosticAddendum | undefined = undefined,
    flags = MemberAccessFlags.Default,
    selfType?: ClassType | TypeVarType,
    recursionCount = 0
): TypeResult | undefined {
    if (ClassType.isPartiallyEvaluated(objectType)) {
        if (errorNode) {
            evaluator.addDiagnostic(
                DiagnosticRule.reportGeneralTypeIssues,
                LocMessage.classDefinitionCycle().format({ name: objectType.shared.name }),
                errorNode
            );
        }
        return { type: UnknownType.create() };
    }

    if (
        isInstantiableClass(objectType) &&
        !objectType.priv.includeSubclasses &&
        objectType.shared.typeParams.length > 0
    ) {
        if ((flags & MemberAccessFlags.SkipAttributeAccessOverride) === 0) {
            objectType = specializeWithDefaultTypeArgs(objectType);
        }
    }

    const objectTypeIsInstantiable = TypeBase.isInstantiable(objectType);
    const metaclass = objectType.shared.effectiveMetaclass;

    let memberInfo: ClassMemberLookup | undefined;

    let skipObjectTypeLookup = objectTypeIsInstantiable && (flags & MemberAccessFlags.SkipInstanceMembers) !== 0;

    if (
        usage.method === 'get' &&
        objectTypeIsInstantiable &&
        metaclass &&
        isInstantiableClass(metaclass) &&
        !ClassType.isBuiltIn(metaclass, 'type') &&
        !ClassType.isSameGenericClass(metaclass, objectType)
    ) {
        const descMemberInfo = getTypeOfClassMemberName(
            evaluator,
            state,
            registry,
            errorNode,
            metaclass,
            memberName,
            usage,
            /* diag */ undefined,
            flags | MemberAccessFlags.SkipAttributeAccessOverride | MemberAccessFlags.SkipTypedDictEntries,
            objectType,
            recursionCount
        );

        if (descMemberInfo) {
            const isProperty = isClassInstance(descMemberInfo.type) && ClassType.isPropertyClass(descMemberInfo.type);
            if (isDescriptorInstance(descMemberInfo.type, /* requireSetter */ true) || isProperty) {
                skipObjectTypeLookup = true;
            }
        }
    }

    let subDiag: DiagnosticAddendum | undefined;

    if (!skipObjectTypeLookup) {
        let effectiveFlags = flags | MemberAccessFlags.SkipTypedDictEntries;

        if (objectTypeIsInstantiable) {
            effectiveFlags |=
                MemberAccessFlags.SkipInstanceMembers |
                MemberAccessFlags.SkipAttributeAccessOverride |
                MemberAccessFlags.DisallowGenericInstanceVariableAccess;
            effectiveFlags &= ~MemberAccessFlags.SkipClassMembers;
        } else {
            effectiveFlags |= MemberAccessFlags.DisallowClassVarWrites;
        }

        subDiag = diag ? new DiagnosticAddendum() : undefined;

        memberInfo = getTypeOfClassMemberName(
            evaluator,
            state,
            registry,
            errorNode,
            objectType,
            memberName,
            usage,
            subDiag,
            effectiveFlags,
            selfType,
            recursionCount
        );
    }

    if (!memberInfo && metaclass && isInstantiableClass(metaclass)) {
        let effectiveFlags = flags;

        if (!objectTypeIsInstantiable) {
            effectiveFlags |=
                MemberAccessFlags.SkipClassMembers |
                MemberAccessFlags.SkipAttributeAccessOverride |
                MemberAccessFlags.SkipTypeBaseClass;
            effectiveFlags &= ~MemberAccessFlags.SkipInstanceMembers;
        }

        const metaclassDiag = diag ? new DiagnosticAddendum() : undefined;
        memberInfo = getTypeOfClassMemberName(
            evaluator,
            state,
            registry,
            errorNode,
            ClassType.cloneAsInstance(metaclass),
            memberName,
            usage,
            metaclassDiag,
            effectiveFlags,
            objectTypeIsInstantiable ? objectType : ClassType.cloneAsInstantiable(objectType),
            recursionCount
        );

        if (memberInfo?.isDescriptorError) {
            subDiag = metaclassDiag;
        }
    }

    if (memberInfo) {
        if (memberInfo.isDescriptorError && diag && subDiag) {
            diag.addAddendum(subDiag);
        }

        return {
            type: memberInfo.type,
            classType: memberInfo.classType,
            isIncomplete: !!memberInfo.isTypeIncomplete,
            isAsymmetricAccessor: memberInfo.isAsymmetricAccessor,
            narrowedTypeForSet: memberInfo.narrowedTypeForSet,
            memberAccessDeprecationInfo: memberInfo.memberAccessDeprecationInfo,
            typeErrors: memberInfo.isDescriptorError,
        };
    }

    if (isClassInstance(objectType) && ClassType.isBuiltIn(objectType, 'type') && objectType.priv.includeSubclasses) {
        if ((flags & (MemberAccessFlags.SkipTypeBaseClass | MemberAccessFlags.SkipAttributeAccessOverride)) === 0) {
            const typeArg =
                objectType.priv.typeArgs && objectType.priv.typeArgs.length >= 1
                    ? objectType.priv.typeArgs[0]
                    : UnknownType.create();

            if (isAnyOrUnknown(typeArg)) {
                return { type: typeArg, classType: UnknownType.create() };
            }
        }
    }

    if (diag && subDiag) {
        diag.addAddendum(subDiag);
    }

    return undefined;
}

export function getBoundMagicMethod(
    evaluator: TypeEvaluator,
    state: TypeEvaluatorState,
    registry: TypeRegistry,
    classType: ClassType,
    memberName: string,
    selfType?: ClassType | TypeVarType | undefined,
    errorNode?: ExpressionNode | undefined,
    diag?: DiagnosticAddendum,
    recursionCount = 0
): FunctionType | OverloadedType | undefined {
    const boundMethodResult = getTypeOfBoundMember(
        evaluator,
        state,
        registry,
        errorNode,
        classType,
        memberName,
        /* usage */ undefined,
        diag,
        MemberAccessFlags.SkipInstanceMembers | MemberAccessFlags.SkipAttributeAccessOverride,
        selfType,
        recursionCount
    );

    if (!boundMethodResult || boundMethodResult.typeErrors) {
        return undefined;
    }

    if (isFunctionOrOverloaded(boundMethodResult.type)) {
        return boundMethodResult.type;
    }

    if (isClassInstance(boundMethodResult.type)) {
        if (recursionCount > maxTypeRecursionCount) {
            return undefined;
        }
        recursionCount++;

        return getBoundMagicMethod(
            evaluator,
            state,
            registry,
            boundMethodResult.type,
            '__call__',
            /* selfType */ undefined,
            errorNode,
            diag,
            recursionCount
        );
    }

    if (isAnyOrUnknown(boundMethodResult.type)) {
        return getUnknownTypeForCallable();
    }

    return undefined;
}

export function getCallbackProtocolType(
    evaluator: TypeEvaluator,
    state: TypeEvaluatorState,
    registry: TypeRegistry,
    objType: ClassType,
    recursionCount = 0
): FunctionType | OverloadedType | undefined {
    if (!isClassInstance(objType) || !ClassType.isProtocolClass(objType)) {
        return undefined;
    }

    for (const mroClass of objType.shared.mro) {
        if (isClass(mroClass) && ClassType.isProtocolClass(mroClass)) {
            for (const field of ClassType.getSymbolTable(mroClass)) {
                const fieldName = field[0];
                const fieldSymbol = field[1];

                if (fieldName === '__call__' || fieldName === '__slots__') {
                    continue;
                }

                if (fieldSymbol.isIgnoredForProtocolMatch()) {
                    continue;
                }

                let fieldIsPartOfFunction = false;

                if (registry.functionClass && isClass(registry.functionClass)) {
                    if (ClassType.getSymbolTable(registry.functionClass).has(field[0])) {
                        fieldIsPartOfFunction = true;
                    }
                }

                if (!fieldIsPartOfFunction) {
                    return undefined;
                }
            }
        }
    }

    const callType = getBoundMagicMethod(
        evaluator,
        state,
        registry,
        objType,
        '__call__',
        /* selfType */ undefined,
        /* errorNode */ undefined,
        /* diag */ undefined,
        recursionCount
    );

    if (!callType) {
        return undefined;
    }

    return makeFunctionTypeVarsBound(callType);
}
