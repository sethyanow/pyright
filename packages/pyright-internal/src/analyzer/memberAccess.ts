// Member access, descriptor protocol, and method binding functions
// extracted from typeEvaluator.ts.

import { assert } from '../common/debug';
import { DiagnosticAddendum } from '../common/diagnostic';
import { LocMessage } from '../localization/localize';
import { DiagnosticRule } from '../common/diagnosticRules';
import { ArgCategory, ExpressionNode, ParamCategory } from '../parser/parseNodes';
import * as ParseTreeUtils from './parseTreeUtils';
import { ConstraintTracker } from './constraintTracker';
import * as specialForms from './specialForms';
import { makeTupleObject } from './tuples';
import { TypeRegistry } from './typeRegistry';
import {
    Arg,
    AssignTypeFlags,
    CallResult,
    EvalFlags,
    MagicMethodDeprecationInfo,
    TypeEvaluator,
    TypeResult,
} from './typeEvaluatorTypes';
import {
    AnyType,
    ClassType,
    FunctionParam,
    FunctionParamFlags,
    FunctionType,
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
    isTypeVar,
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
    isInstantiableMetaclass,
    isNoneInstance,
    isNoneTypeClass,
    isSentinelLiteral,
    isTypeAliasPlaceholder,
    makeTypeVarsBound,
    mapSignatures,
    mapSubtypes,
    partiallySpecializeType,
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
            defaultType = makeTupleObject(evaluator, [{ type: UnknownType.create(), isUnbounded: true }], /* isUnpacked */ true);
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
            typeFormType = specializeTypeAliasWithDefaults(evaluator, registry, typeFormType, /* errorNode */ undefined);
        }

        type = TypeBase.cloneWithTypeForm(type, convertToInstance(typeFormType));
    }

    return type;
}
