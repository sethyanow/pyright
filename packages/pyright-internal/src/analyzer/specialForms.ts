/*
 * specialForms.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 *
 * Functions for creating special Python type constructs (Callable, Union,
 * Optional, Literal, TypeVar, ParamSpec, TypeVarTuple, Annotated, etc.)
 * extracted from the createTypeEvaluator closure.
 */

import { assert } from '../common/debug';
import { appendArray } from '../common/collectionUtils';
import { DiagnosticRule } from '../common/diagnosticRules';
import { LocMessage } from '../localization/localize';
import {
    ArgCategory,
    ExpressionNode,
    FunctionNode,
    IndexNode,
    ParamCategory,
    ParseNode,
    ParseNodeType,
    TypeParameterNode,
} from '../parser/parseNodes';
import {
    PythonVersion,
    pythonVersion3_13,
} from '../common/pythonVersion';
import { KeywordType, OperatorType, StringTokenFlags } from '../parser/tokenizerTypes';
import * as AnalyzerNodeInfo from './analyzerNodeInfo';
import { SpecialBuiltInClassDeclaration } from './declaration';
import { getFunctionInfoFromDecorators } from './decorators';
import * as ParseTreeUtils from './parseTreeUtils';
import { ConstraintTracker } from './constraintTracker';
import { Arg, EvalFlags, TypeEvaluator, TypeResult, TypeResultWithNode } from './typeEvaluatorTypes';
import { TypeRegistry } from './typeRegistry';
import {
    AnyType,
    ClassType,
    ClassTypeFlags,
    FunctionParam,
    FunctionParamFlags,
    FunctionType,
    FunctionTypeFlags,
    LiteralValue,
    NeverType,
    OverloadedType,
    ParamSpecType,
    TupleTypeArg,
    Type,
    TypeBase,
    TypeVarScopeId,
    TypeVarScopeType,
    TypeVarTupleType,
    TypeVarType,
    UnknownType,
    Variance,
    combineTypes,
    isAnyOrUnknown,
    isClassInstance,
    isInstantiableClass,
    isParamSpec,
    isTypeVar,
    isTypeVarTuple,
    isTypeSame,
    isUnion,
    isUnpackedClass,
    isClass,
    isUnpackedTypeVarTuple,
    TypeVarKind,
} from './types';
import {
    addTypeVarsToListIfUnique,
    computeMroLinearization,
    convertToInstance,
    doForEachSubtype,
    getTypeVarArgsRecursive,
    getTypeVarScopeId,
    isEffectivelyInstantiable,
    isEllipsisType,
    isInstantiableMetaclass,
    isNoneInstance,
    isNoneTypeClass,
    isTupleClass,
    isUnboundedTupleClass,
    getTypeVarScopeIds,
    requiresSpecialization,
    specializeTupleClass,
    synthesizeTypeVarForSelfCls,
} from './typeUtils';
import { Symbol, SymbolFlags } from './symbol';
import { makeTupleObject } from './tuples';

// Local definition — matches the interface in typeEvaluator.ts.
// Avoids importing from typeEvaluator.ts (anti-pattern: circular dep risk).
export interface AliasMapEntry {
    alias?: string;
    module: 'builtins' | 'collections' | 'internals' | 'self';
    implicitBaseClass?: string;
    isSpecialForm?: boolean;
    isIllegalInIsinstance?: boolean;
    typeParamVariance?: Variance;
}

// ---- Helpers with no closure dependencies ----

export function isTypeFormSupported(node: ParseNode): boolean {
    const fileInfo = AnalyzerNodeInfo.getFileInfo(node);
    return fileInfo.diagnosticRuleSet.enableExperimentalFeatures;
}

export function getFunctionFullName(functionNode: ParseNode, moduleName: string, functionName: string): string {
    const nameParts: string[] = [functionName];
    let curNode: ParseNode | undefined = functionNode;

    while (curNode) {
        curNode = ParseTreeUtils.getEnclosingClassOrFunction(curNode);
        if (curNode) {
            nameParts.push(curNode.d.name.d.value);
        }
    }

    nameParts.push(moduleName);
    return nameParts.reverse().join('.');
}

export function applyUnpackToTupleLike(type: Type): Type | undefined {
    if (isTypeVarTuple(type)) {
        if (!type.priv.isUnpacked) {
            return TypeVarType.cloneForUnpacked(type);
        }
        return undefined;
    }

    if (isParamSpec(type)) {
        return undefined;
    }

    if (isTypeVar(type)) {
        const upperBound = type.shared.boundType;
        if (upperBound && isClassInstance(upperBound) && isTupleClass(upperBound)) {
            return TypeVarType.cloneForUnpacked(type);
        }
        return undefined;
    }

    if (isInstantiableClass(type) && !type.priv.includeSubclasses) {
        if (isTupleClass(type)) {
            return ClassType.cloneForUnpacked(type);
        }
    }

    return undefined;
}

// ---- Helpers with evaluator dependency ----

export function getBooleanValue(evaluator: TypeEvaluator, node: ExpressionNode): boolean {
    if (node.nodeType === ParseNodeType.Constant) {
        if (node.d.constType === KeywordType.False) {
            return false;
        } else if (node.d.constType === KeywordType.True) {
            return true;
        }
    }

    evaluator.addDiagnostic(DiagnosticRule.reportGeneralTypeIssues, LocMessage.expectedBoolLiteral(), node);
    return false;
}

export function validateTypeVarTupleIsUnpacked(
    evaluator: TypeEvaluator,
    type: TypeVarTupleType,
    node: ParseNode
): boolean {
    if (!type.priv.isUnpacked) {
        evaluator.addDiagnostic(
            DiagnosticRule.reportInvalidTypeForm,
            LocMessage.unpackedTypeVarTupleExpected().format({
                name1: type.shared.name,
                name2: type.shared.name,
            }),
            node
        );
        return false;
    }
    return true;
}

// ---- Leaf create* functions ----

export function createFinalType(
    evaluator: TypeEvaluator,
    classType: ClassType,
    errorNode: ParseNode,
    typeArgs: TypeResultWithNode[] | undefined,
    flags: EvalFlags
): Type {
    if (flags & EvalFlags.NoFinal) {
        if ((flags & EvalFlags.TypeExpression) !== 0) {
            evaluator.addDiagnostic(DiagnosticRule.reportInvalidTypeForm, LocMessage.finalContext(), errorNode);
        }
        return classType;
    }

    if ((flags & EvalFlags.TypeExpression) === 0 || !typeArgs || typeArgs.length === 0) {
        return classType;
    }

    if (typeArgs.length > 1) {
        evaluator.addDiagnostic(DiagnosticRule.reportInvalidTypeForm, LocMessage.finalTooManyArgs(), errorNode);
    }

    return TypeBase.cloneAsSpecialForm(typeArgs[0].type, classType);
}

export function createClassVarType(
    evaluator: TypeEvaluator,
    classType: ClassType,
    errorNode: ParseNode,
    typeArgs: TypeResultWithNode[] | undefined,
    flags: EvalFlags
): Type {
    if (flags & EvalFlags.NoClassVar) {
        evaluator.addDiagnostic(DiagnosticRule.reportInvalidTypeForm, LocMessage.classVarNotAllowed(), errorNode);
        return AnyType.create();
    }

    if (!typeArgs) {
        return classType;
    } else if (typeArgs.length === 0) {
        evaluator.addDiagnostic(DiagnosticRule.reportInvalidTypeForm, LocMessage.classVarFirstArgMissing(), errorNode);
        return UnknownType.create();
    } else if (typeArgs.length > 1) {
        evaluator.addDiagnostic(
            DiagnosticRule.reportInvalidTypeForm,
            LocMessage.classVarTooManyArgs(),
            typeArgs[1].node
        );
        return UnknownType.create();
    }

    const type = typeArgs[0].type;

    if (requiresSpecialization(type, { ignorePseudoGeneric: true, ignoreSelf: true })) {
        evaluator.addDiagnostic(
            DiagnosticRule.reportGeneralTypeIssues,
            LocMessage.classVarWithTypeVar(),
            typeArgs[0].node ?? errorNode
        );
    }

    return type;
}

export function createUnpackType(
    evaluator: TypeEvaluator,
    classType: ClassType,
    errorNode: ParseNode,
    typeArgs: TypeResultWithNode[] | undefined,
    flags: EvalFlags
): Type {
    if (!typeArgs || typeArgs.length !== 1) {
        if ((flags & EvalFlags.TypeExpression) !== 0) {
            evaluator.addDiagnostic(DiagnosticRule.reportInvalidTypeForm, LocMessage.unpackArgCount(), errorNode);
        }
        return classType;
    }

    const typeArgType = typeArgs[0].type;

    if ((flags & EvalFlags.AllowUnpackedTuple) !== 0) {
        const unpackedType = applyUnpackToTupleLike(typeArgType);
        if (unpackedType) {
            return unpackedType;
        }

        if ((flags & EvalFlags.TypeExpression) === 0) {
            return classType;
        }
        evaluator.addDiagnostic(
            DiagnosticRule.reportGeneralTypeIssues,
            LocMessage.unpackExpectedTypeVarTuple(),
            errorNode
        );
        return UnknownType.create();
    }

    if ((flags & EvalFlags.AllowUnpackedTypedDict) !== 0) {
        if (isInstantiableClass(typeArgType) && ClassType.isTypedDictClass(typeArgType)) {
            return ClassType.cloneForUnpacked(typeArgType);
        }

        if ((flags & EvalFlags.TypeExpression) === 0) {
            return classType;
        }
        evaluator.addDiagnostic(
            DiagnosticRule.reportGeneralTypeIssues,
            LocMessage.unpackExpectedTypedDict(),
            errorNode
        );
        return UnknownType.create();
    }

    if ((flags & EvalFlags.TypeExpression) === 0) {
        return classType;
    }
    evaluator.addDiagnostic(DiagnosticRule.reportGeneralTypeIssues, LocMessage.unpackNotAllowed(), errorNode);
    return UnknownType.create();
}

export function createTypeFormType(
    evaluator: TypeEvaluator,
    classType: ClassType,
    errorNode: ExpressionNode,
    typeArgs: TypeResultWithNode[] | undefined
): Type {
    if (!typeArgs || typeArgs.length === 0) {
        return ClassType.specialize(classType, [UnknownType.create()]);
    }

    if (typeArgs.length > 1) {
        evaluator.addDiagnostic(
            DiagnosticRule.reportInvalidTypeForm,
            LocMessage.typeArgsTooMany().format({
                name: classType.priv.aliasName || classType.shared.name,
                expected: 1,
                received: typeArgs.length,
            }),
            typeArgs[1].node
        );
        return UnknownType.create();
    }

    const convertedTypeArgs = typeArgs.map((typeArg) => {
        return convertToInstance(evaluator.validateTypeArg(typeArg) ? typeArg.type : UnknownType.create());
    });
    let resultType = ClassType.specialize(classType, convertedTypeArgs);

    if (isTypeFormSupported(errorNode)) {
        resultType = TypeBase.cloneWithTypeForm(resultType, convertToInstance(resultType));
    }

    return resultType;
}

export function createTypeGuardType(
    evaluator: TypeEvaluator,
    classType: ClassType,
    errorNode: ParseNode,
    typeArgs: TypeResultWithNode[] | undefined,
    flags: EvalFlags
): Type {
    if (!typeArgs) {
        if ((flags & EvalFlags.TypeExpression) !== 0) {
            evaluator.addDiagnostic(DiagnosticRule.reportInvalidTypeForm, LocMessage.typeGuardArgCount(), errorNode);
        }
        return classType;
    } else if (typeArgs.length !== 1) {
        evaluator.addDiagnostic(DiagnosticRule.reportInvalidTypeForm, LocMessage.typeGuardArgCount(), errorNode);
        return UnknownType.create();
    }

    const convertedTypeArgs = typeArgs.map((typeArg) => {
        return convertToInstance(evaluator.validateTypeArg(typeArg) ? typeArg.type : UnknownType.create());
    });

    let resultType = ClassType.specialize(classType, convertedTypeArgs);

    if (isTypeFormSupported(errorNode)) {
        resultType = TypeBase.cloneWithTypeForm(resultType, convertToInstance(resultType));
    }

    return resultType;
}

export function createOptionalType(
    evaluator: TypeEvaluator,
    classType: ClassType,
    errorNode: ParseNode,
    typeArgs: TypeResultWithNode[] | undefined,
    flags: EvalFlags,
    registry: TypeRegistry
): Type {
    if (!typeArgs) {
        if ((flags & EvalFlags.TypeExpression) !== 0) {
            evaluator.addDiagnostic(DiagnosticRule.reportInvalidTypeForm, LocMessage.optionalExtraArgs(), errorNode);
            return UnknownType.create();
        }
        return classType;
    }

    if (typeArgs.length !== 1) {
        evaluator.addDiagnostic(DiagnosticRule.reportInvalidTypeForm, LocMessage.optionalExtraArgs(), errorNode);
        return UnknownType.create();
    }

    let typeArg0Type = typeArgs[0].type;
    if (!evaluator.validateTypeArg(typeArgs[0])) {
        typeArg0Type = UnknownType.create();
    }

    let optionalType = combineTypes([typeArg0Type, registry.noneTypeClass ?? UnknownType.create()]);
    if (registry.unionTypeClass && isInstantiableClass(registry.unionTypeClass)) {
        optionalType = TypeBase.cloneAsSpecialForm(
            optionalType,
            ClassType.cloneAsInstance(registry.unionTypeClass)
        );
    }

    if (typeArg0Type.props?.typeForm) {
        const typeFormType = combineTypes([
            typeArg0Type.props.typeForm,
            convertToInstance(registry.noneTypeClass ?? UnknownType.create()),
        ]);
        optionalType = TypeBase.cloneWithTypeForm(optionalType, typeFormType);
    }

    return optionalType;
}

export function createRequiredOrReadOnlyType(
    evaluator: TypeEvaluator,
    classType: ClassType,
    errorNode: ParseNode,
    typeArgs: TypeResultWithNode[] | undefined,
    flags: EvalFlags
): TypeResult {
    if (!typeArgs && (flags & EvalFlags.TypeExpression) === 0) {
        return { type: classType };
    }

    if (!typeArgs || typeArgs.length !== 1) {
        if ((flags & EvalFlags.TypeExpression) !== 0) {
            evaluator.addDiagnostic(
                DiagnosticRule.reportInvalidTypeForm,
                classType.shared.name === 'ReadOnly'
                    ? LocMessage.readOnlyArgCount()
                    : classType.shared.name === 'Required'
                    ? LocMessage.requiredArgCount()
                    : LocMessage.notRequiredArgCount(),
                errorNode
            );
        }
        return { type: classType };
    }

    const typeArgType = typeArgs[0].type;

    const containingClassNode = ParseTreeUtils.getEnclosingClass(errorNode, /* stopAtFunction */ true);
    const classTypeInfo = containingClassNode ? evaluator.getTypeOfClass(containingClassNode) : undefined;

    let isUsageLegal = false;

    if (
        classTypeInfo &&
        isInstantiableClass(classTypeInfo.classType) &&
        ClassType.isTypedDictClass(classTypeInfo.classType)
    ) {
        if (ParseTreeUtils.isNodeContainedWithinNodeType(errorNode, ParseNodeType.TypeAnnotation)) {
            isUsageLegal = true;
        }
    }

    let isReadOnly = typeArgs[0].isReadOnly;
    let isRequired = typeArgs[0].isRequired;
    let isNotRequired = typeArgs[0].isNotRequired;

    if (classType.shared.name === 'ReadOnly') {
        if ((flags & EvalFlags.AllowReadOnly) !== 0) {
            isUsageLegal = true;
        }
        if (typeArgs[0].isReadOnly) {
            isUsageLegal = false;
        }
        isReadOnly = true;
    } else {
        if ((flags & EvalFlags.AllowRequired) !== 0) {
            isUsageLegal = true;
        }
        if (typeArgs[0].isRequired || typeArgs[0].isNotRequired) {
            isUsageLegal = false;
        }
        isRequired = classType.shared.name === 'Required';
        isNotRequired = classType.shared.name === 'NotRequired';
    }

    if (!isUsageLegal) {
        if ((flags & EvalFlags.TypeExpression) !== 0) {
            evaluator.addDiagnostic(
                DiagnosticRule.reportInvalidTypeForm,
                classType.shared.name === 'ReadOnly'
                    ? LocMessage.readOnlyNotInTypedDict()
                    : classType.shared.name === 'Required'
                    ? LocMessage.requiredNotInTypedDict()
                    : LocMessage.notRequiredNotInTypedDict(),
                errorNode
            );
        }
        return { type: classType };
    }

    return { type: typeArgType, isReadOnly, isRequired, isNotRequired };
}

export function createSelfType(
    evaluator: TypeEvaluator,
    classType: ClassType,
    errorNode: ParseNode,
    typeArgs: TypeResultWithNode[] | undefined,
    flags: EvalFlags
): Type {
    if (typeArgs && typeArgs.length > 0) {
        evaluator.addDiagnostic(
            DiagnosticRule.reportInvalidTypeArguments,
            LocMessage.typeArgsExpectingNone().format({
                name: classType.shared.name,
            }),
            typeArgs[0].node ?? errorNode
        );
    }

    let enclosingClass = ParseTreeUtils.getEnclosingClass(errorNode);

    if (enclosingClass && !ParseTreeUtils.isNodeContainedWithin(errorNode, enclosingClass.d.suite)) {
        enclosingClass = undefined;
    }

    const enclosingClassTypeResult = enclosingClass ? evaluator.getTypeOfClass(enclosingClass) : undefined;
    if (!enclosingClassTypeResult) {
        if ((flags & (EvalFlags.TypeExpression | EvalFlags.InstantiableType)) !== 0) {
            evaluator.addDiagnostic(DiagnosticRule.reportGeneralTypeIssues, LocMessage.selfTypeContext(), errorNode);
        }
        return UnknownType.create();
    } else if (isInstantiableMetaclass(enclosingClassTypeResult.classType)) {
        evaluator.addDiagnostic(DiagnosticRule.reportGeneralTypeIssues, LocMessage.selfTypeMetaclass(), errorNode);
        return UnknownType.create();
    }

    const enclosingFunction = ParseTreeUtils.getEnclosingFunction(errorNode);
    if (enclosingFunction) {
        const functionInfo = getFunctionInfoFromDecorators(
            evaluator,
            enclosingFunction,
            /* isInClass */ true
        );

        const isInnerFunction = !!ParseTreeUtils.getEnclosingFunction(enclosingFunction);
        if (!isInnerFunction) {
            if (functionInfo.flags & FunctionTypeFlags.StaticMethod) {
                evaluator.addDiagnostic(
                    DiagnosticRule.reportGeneralTypeIssues,
                    LocMessage.selfTypeContext(),
                    errorNode
                );
                return UnknownType.create();
            }

            if (enclosingFunction.d.params.length > 0) {
                const firstParamTypeAnnotation = ParseTreeUtils.getTypeAnnotationForParam(enclosingFunction, 0);
                if (
                    firstParamTypeAnnotation &&
                    !ParseTreeUtils.isNodeContainedWithin(errorNode, firstParamTypeAnnotation)
                ) {
                    const annotationType = evaluator.getTypeOfAnnotation(firstParamTypeAnnotation, {
                        typeVarGetsCurScope: true,
                    });
                    if (!isTypeVar(annotationType) || !TypeVarType.isSelf(annotationType)) {
                        evaluator.addDiagnostic(
                            DiagnosticRule.reportGeneralTypeIssues,
                            LocMessage.selfTypeWithTypedSelfOrCls(),
                            errorNode
                        );
                    }
                }
            }
        }
    }

    let result = synthesizeTypeVarForSelfCls(enclosingClassTypeResult.classType, /* isClsParam */ true);

    if (enclosingClass) {
        const enclosingSuite = ParseTreeUtils.getEnclosingClassOrFunctionSuite(errorNode);

        if (enclosingSuite && ParseTreeUtils.isNodeContainedWithin(enclosingSuite, enclosingClass)) {
            if (enclosingClass.d.suite !== enclosingSuite) {
                result = TypeVarType.cloneAsBound(result);
            }
        }
    }

    return result;
}

export function createAnnotatedType(
    evaluator: TypeEvaluator,
    classType: ClassType,
    errorNode: ExpressionNode,
    typeArgs: TypeResultWithNode[] | undefined,
    flags: EvalFlags
): TypeResult {
    let type: Type | undefined;

    const typeExprFlags = EvalFlags.TypeExpression | EvalFlags.NoConvertSpecialForm;
    if ((flags & typeExprFlags) === 0) {
        type = ClassType.cloneAsInstance(classType);

        if (typeArgs && typeArgs.length >= 1 && typeArgs[0].type.props?.typeForm) {
            type = TypeBase.cloneWithTypeForm(type, typeArgs[0].type.props.typeForm);
        }

        return { type };
    }

    if (typeArgs && typeArgs.length > 0) {
        type = typeArgs[0].type;

        if (typeArgs.length < 2) {
            evaluator.addDiagnostic(
                DiagnosticRule.reportInvalidTypeForm,
                LocMessage.annotatedTypeArgMissing(),
                errorNode
            );
        } else {
            type = validateAnnotatedMetadata(errorNode, typeArgs[0].type, typeArgs.slice(1));
        }
    }

    if (!type || !typeArgs || typeArgs.length === 0) {
        return { type: AnyType.create() };
    }

    if (typeArgs[0].typeList) {
        evaluator.addDiagnostic(
            DiagnosticRule.reportInvalidTypeForm,
            LocMessage.typeArgListNotAllowed(),
            typeArgs[0].node
        );
    }

    return {
        type: TypeBase.cloneAsSpecialForm(type, ClassType.cloneAsInstance(classType)),
        isReadOnly: typeArgs[0].isReadOnly,
        isRequired: typeArgs[0].isRequired,
        isNotRequired: typeArgs[0].isNotRequired,
    };
}

// Helper for createAnnotatedType — PEP 746 metadata validation
function validateAnnotatedMetadata(
    errorNode: ExpressionNode,
    baseType: Type,
    metaArgs: TypeResultWithNode[]
): Type {
    for (const metaArg of metaArgs) {
        validateTypeMetadata(errorNode, baseType, metaArg);
    }
    return baseType;
}

function validateTypeMetadata(errorNode: ExpressionNode, baseType: Type, metaArg: TypeResultWithNode): boolean {
    // Removed for now while PEP 746 is being revised.
    return true;
}

// ---- Dispatch functions that call other extracted functions ----

export function createSpecialType(
    evaluator: TypeEvaluator,
    classType: ClassType,
    typeArgs: TypeResultWithNode[] | undefined,
    paramLimit?: number,
    allowParamSpec = false,
    isSpecialForm = true
): Type {
    const isTupleTypeParam = ClassType.isTupleClass(classType);

    if (typeArgs) {
        if (isTupleTypeParam && typeArgs.length === 1 && typeArgs[0].isEmptyTupleShorthand) {
            typeArgs = [];
        } else {
            let sawUnpacked = false;
            const noteSawUnpacked = (typeArg: TypeResultWithNode) => {
                if (sawUnpacked) {
                    if (!reportedUnpackedError) {
                        evaluator.addDiagnostic(
                            DiagnosticRule.reportInvalidTypeForm,
                            LocMessage.variadicTypeArgsTooMany(),
                            typeArg.node
                        );
                        reportedUnpackedError = true;
                    }
                }
                sawUnpacked = true;
            };
            let reportedUnpackedError = false;

            typeArgs.forEach((typeArg, index) => {
                assert(typeArgs !== undefined);
                if (isEllipsisType(typeArg.type)) {
                    if (!isTupleTypeParam) {
                        if (!allowParamSpec) {
                            evaluator.addDiagnostic(
                                DiagnosticRule.reportInvalidTypeForm,
                                LocMessage.ellipsisContext(),
                                typeArg.node
                            );
                        }
                    } else if (typeArgs!.length !== 2 || index !== 1) {
                        evaluator.addDiagnostic(
                            DiagnosticRule.reportInvalidTypeForm,
                            LocMessage.ellipsisSecondArg(),
                            typeArg.node
                        );
                    } else {
                        if (isTypeVarTuple(typeArgs![0].type) && !typeArgs![0].type.priv.isInUnion) {
                            evaluator.addDiagnostic(
                                DiagnosticRule.reportInvalidTypeForm,
                                LocMessage.typeVarTupleContext(),
                                typeArgs![0].node
                            );
                        } else if (isUnpackedClass(typeArgs![0].type)) {
                            evaluator.addDiagnostic(
                                DiagnosticRule.reportInvalidTypeForm,
                                LocMessage.ellipsisAfterUnpacked(),
                                typeArg.node
                            );
                        }
                    }
                } else if (isParamSpec(typeArg.type) && allowParamSpec) {
                    // Nothing to do - this is allowed.
                } else if (paramLimit === undefined && isTypeVarTuple(typeArg.type)) {
                    if (!typeArg.type.priv.isInUnion) {
                        noteSawUnpacked(typeArg);
                    }
                    validateTypeVarTupleIsUnpacked(evaluator, typeArg.type, typeArg.node);
                } else if (paramLimit === undefined && isUnpackedClass(typeArg.type)) {
                    if (isUnboundedTupleClass(typeArg.type)) {
                        noteSawUnpacked(typeArg);
                    }
                    evaluator.validateTypeArg(typeArg, { allowUnpackedTuples: true });
                } else {
                    evaluator.validateTypeArg(typeArg);
                }
            });
        }
    }

    let typeArgTypes = typeArgs ? typeArgs.map((t) => convertToInstance(t.type)) : [];

    if (paramLimit !== undefined) {
        if (typeArgs && typeArgTypes.length > paramLimit) {
            evaluator.addDiagnostic(
                DiagnosticRule.reportInvalidTypeForm,
                LocMessage.typeArgsTooMany().format({
                    name: classType.priv.aliasName || classType.shared.name,
                    expected: paramLimit,
                    received: typeArgTypes.length,
                }),
                typeArgs[paramLimit].node
            );
            typeArgTypes = typeArgTypes.slice(0, paramLimit);
        } else if (typeArgTypes.length < paramLimit) {
            while (typeArgTypes.length < paramLimit) {
                typeArgTypes.push(UnknownType.create());
            }
        }
    }

    let returnType: Type;
    if (isTupleTypeParam) {
        const tupleTypeArgTypes: TupleTypeArg[] = [];

        if (!typeArgs) {
            tupleTypeArgTypes.push({ type: UnknownType.create(), isUnbounded: true });
        } else {
            typeArgs.forEach((typeArg, index) => {
                if (index === 1 && isEllipsisType(typeArgTypes[index])) {
                    if (tupleTypeArgTypes.length === 1 && !tupleTypeArgTypes[0].isUnbounded) {
                        tupleTypeArgTypes[0] = { type: tupleTypeArgTypes[0].type, isUnbounded: true };
                    }
                } else if (isUnpackedClass(typeArg.type) && typeArg.type.priv.tupleTypeArgs) {
                    appendArray(tupleTypeArgTypes, typeArg.type.priv.tupleTypeArgs);
                } else {
                    tupleTypeArgTypes.push({ type: typeArgTypes[index], isUnbounded: false });
                }
            });
        }

        returnType = specializeTupleClass(classType, tupleTypeArgTypes, typeArgs !== undefined);
    } else {
        returnType = ClassType.specialize(classType, typeArgTypes, typeArgs !== undefined);
    }

    if (isSpecialForm) {
        returnType = TypeBase.cloneAsSpecialForm(returnType, classType);
    }

    return returnType;
}

export function createConcatenateType(
    evaluator: TypeEvaluator,
    classType: ClassType,
    errorNode: ParseNode,
    typeArgs: TypeResultWithNode[] | undefined,
    flags: EvalFlags
): Type {
    if ((flags & EvalFlags.AllowConcatenate) === 0) {
        if ((flags & EvalFlags.TypeExpression) !== 0) {
            evaluator.addDiagnostic(DiagnosticRule.reportInvalidTypeForm, LocMessage.concatenateContext(), errorNode);
        }
        return classType;
    }

    if (!typeArgs || typeArgs.length === 0) {
        evaluator.addDiagnostic(
            DiagnosticRule.reportInvalidTypeForm,
            LocMessage.concatenateTypeArgsMissing(),
            errorNode
        );
    } else {
        typeArgs.forEach((typeArg, index) => {
            if (index === typeArgs.length - 1) {
                if (!isParamSpec(typeArg.type) && !isEllipsisType(typeArg.type)) {
                    evaluator.addDiagnostic(
                        DiagnosticRule.reportInvalidTypeForm,
                        LocMessage.concatenateParamSpecMissing(),
                        typeArg.node
                    );
                }
            } else {
                if (isParamSpec(typeArg.type)) {
                    evaluator.addDiagnostic(
                        DiagnosticRule.reportInvalidTypeForm,
                        LocMessage.paramSpecContext(),
                        typeArg.node
                    );
                } else if (isUnpackedTypeVarTuple(typeArg.type)) {
                    evaluator.addDiagnostic(
                        DiagnosticRule.reportInvalidTypeForm,
                        LocMessage.typeVarTupleContext(),
                        typeArg.node
                    );
                } else if (isUnpackedClass(typeArg.type)) {
                    evaluator.addDiagnostic(
                        DiagnosticRule.reportInvalidTypeForm,
                        LocMessage.unpackedArgInTypeArgument(),
                        typeArg.node
                    );
                }
            }
        });
    }

    return createSpecialType(evaluator, classType, typeArgs, /* paramLimit */ undefined, /* allowParamSpec */ true);
}

export function createGenericType(
    evaluator: TypeEvaluator,
    classType: ClassType,
    errorNode: ParseNode,
    typeArgs: TypeResultWithNode[] | undefined,
    flags: EvalFlags
): Type {
    if (!typeArgs) {
        if ((flags & (EvalFlags.TypeExpression | EvalFlags.NoNakedGeneric)) !== 0) {
            evaluator.addDiagnostic(DiagnosticRule.reportInvalidTypeForm, LocMessage.genericTypeArgMissing(), errorNode);
        }
        return classType;
    }

    const uniqueTypeVars: TypeVarType[] = [];
    if (typeArgs) {
        if (typeArgs.length === 0) {
            evaluator.addDiagnostic(DiagnosticRule.reportInvalidTypeForm, LocMessage.genericTypeArgMissing(), errorNode);
        }

        typeArgs.forEach((typeArg) => {
            if (!isTypeVar(typeArg.type)) {
                evaluator.addDiagnostic(
                    DiagnosticRule.reportInvalidTypeForm,
                    LocMessage.genericTypeArgTypeVar(),
                    typeArg.node
                );
            } else {
                if (uniqueTypeVars.some((t) => isTypeSame(t, typeArg.type))) {
                    evaluator.addDiagnostic(
                        DiagnosticRule.reportInvalidTypeForm,
                        LocMessage.genericTypeArgUnique(),
                        typeArg.node
                    );
                }
                uniqueTypeVars.push(typeArg.type);
            }
        });
    }

    return createSpecialType(evaluator, classType, typeArgs, /* paramLimit */ undefined, /* allowParamSpec */ true);
}

export function createUnionType(
    evaluator: TypeEvaluator,
    classType: ClassType,
    errorNode: ParseNode,
    typeArgs: TypeResultWithNode[] | undefined,
    flags: EvalFlags,
    registry: TypeRegistry
): Type {
    const fileInfo = AnalyzerNodeInfo.getFileInfo(errorNode);
    const types: Type[] = [];
    let allowSingleTypeArg = false;
    let isValidTypeForm = true;

    if (!typeArgs) {
        if ((flags & EvalFlags.TypeExpression) !== 0) {
            evaluator.addDiagnostic(DiagnosticRule.reportInvalidTypeForm, LocMessage.unionTypeArgCount(), errorNode);
            return NeverType.createNever();
        }
        return classType;
    }

    for (const typeArg of typeArgs) {
        let typeArgType = typeArg.type;

        if (
            !evaluator.validateTypeArg(typeArg, {
                allowTypeVarTuple: fileInfo.diagnosticRuleSet.enableExperimentalFeatures,
            })
        ) {
            typeArgType = UnknownType.create();
        }

        if (isTypeVar(typeArgType) && isUnpackedTypeVarTuple(typeArgType)) {
            if (fileInfo.diagnosticRuleSet.enableExperimentalFeatures) {
                typeArgType = TypeVarType.cloneForUnpacked(typeArgType, /* isInUnion */ true);
                allowSingleTypeArg = true;
            } else {
                evaluator.addDiagnostic(
                    DiagnosticRule.reportGeneralTypeIssues,
                    LocMessage.unionUnpackedTypeVarTuple(),
                    errorNode
                );
                typeArgType = UnknownType.create();
                isValidTypeForm = false;
            }
        }

        types.push(typeArgType);
    }

    if (types.length === 1 && !allowSingleTypeArg && !isNoneInstance(types[0])) {
        if ((flags & EvalFlags.TypeExpression) !== 0) {
            evaluator.addDiagnostic(
                DiagnosticRule.reportInvalidTypeArguments,
                LocMessage.unionTypeArgCount(),
                errorNode
            );
        }
        isValidTypeForm = false;
    }

    let unionType = combineTypes(types, { skipElideRedundantLiterals: true });
    if (registry.unionTypeClass && isInstantiableClass(registry.unionTypeClass)) {
        unionType = TypeBase.cloneAsSpecialForm(unionType, ClassType.cloneAsInstance(registry.unionTypeClass));
    }

    if (!isValidTypeForm || types.some((t) => !t.props?.typeForm)) {
        if (unionType.props?.typeForm) {
            unionType = TypeBase.cloneWithTypeForm(unionType, undefined);
        }
    } else if (isTypeFormSupported(errorNode)) {
        const typeFormType = combineTypes(types.map((t) => t.props!.typeForm!));
        unionType = TypeBase.cloneWithTypeForm(unionType, typeFormType);
    }

    return unionType;
}

// ---- Placeholder exports for functions not yet extracted ----
// These will be replaced with real implementations as extraction continues.

export function createCallableType(
    evaluator: TypeEvaluator,
    classType: ClassType,
    typeArgs: TypeResultWithNode[] | undefined,
    errorNode: ParseNode
): FunctionType {
    let functionType = FunctionType.createInstantiable(FunctionTypeFlags.None);
    let paramSpec: ParamSpecType | undefined;
    let isValidTypeForm = true;

    TypeBase.setSpecialForm(functionType, ClassType.cloneAsInstance(classType));
    functionType.shared.declaredReturnType = UnknownType.create();
    functionType.shared.typeVarScopeId = ParseTreeUtils.getScopeIdForNode(errorNode);

    if (typeArgs && typeArgs.length > 0) {
        functionType.priv.isCallableWithTypeArgs = true;

        if (typeArgs[0].typeList) {
            const typeList = typeArgs[0].typeList;
            let sawUnpacked = false;
            let reportedUnpackedError = false;
            const noteSawUnpacked = (entry: TypeResultWithNode) => {
                if (sawUnpacked) {
                    if (!reportedUnpackedError) {
                        evaluator.addDiagnostic(
                            DiagnosticRule.reportInvalidTypeForm,
                            LocMessage.variadicTypeArgsTooMany(),
                            entry.node
                        );
                        reportedUnpackedError = true;
                        isValidTypeForm = false;
                    }
                }
                sawUnpacked = true;
            };

            typeList.forEach((entry, index) => {
                let entryType = entry.type;
                let paramCategory: ParamCategory = ParamCategory.Simple;
                const paramName = `__p${index.toString()}`;

                if (isTypeVarTuple(entryType)) {
                    validateTypeVarTupleIsUnpacked(evaluator, entryType, entry.node);
                    paramCategory = ParamCategory.ArgsList;
                    noteSawUnpacked(entry);
                } else if (evaluator.validateTypeArg(entry, { allowUnpackedTuples: true })) {
                    if (isUnpackedClass(entryType)) {
                        paramCategory = ParamCategory.ArgsList;

                        if (
                            entryType.priv.tupleTypeArgs?.some(
                                (typeArg) => isTypeVarTuple(typeArg.type) || typeArg.isUnbounded
                            )
                        ) {
                            noteSawUnpacked(entry);
                        }
                    }
                } else {
                    entryType = UnknownType.create();
                }

                FunctionType.addParam(
                    functionType,
                    FunctionParam.create(
                        paramCategory,
                        convertToInstance(entryType),
                        FunctionParamFlags.NameSynthesized | FunctionParamFlags.TypeDeclared,
                        paramName
                    )
                );
            });

            if (typeList.length > 0) {
                FunctionType.addPositionOnlyParamSeparator(functionType);
            }
        } else if (isEllipsisType(typeArgs[0].type)) {
            FunctionType.addDefaultParams(functionType);
            functionType.shared.flags |= FunctionTypeFlags.GradualCallableForm;
        } else if (isParamSpec(typeArgs[0].type)) {
            paramSpec = typeArgs[0].type;
        } else {
            if (isInstantiableClass(typeArgs[0].type) && ClassType.isBuiltIn(typeArgs[0].type, 'Concatenate')) {
                const concatTypeArgs = typeArgs[0].type.priv.typeArgs;
                if (concatTypeArgs && concatTypeArgs.length > 0) {
                    concatTypeArgs.forEach((typeArg, index) => {
                        if (index === concatTypeArgs.length - 1) {
                            FunctionType.addPositionOnlyParamSeparator(functionType);

                            if (isParamSpec(typeArg)) {
                                paramSpec = typeArg;
                            } else if (isEllipsisType(typeArg)) {
                                FunctionType.addDefaultParams(functionType);
                                functionType.shared.flags |= FunctionTypeFlags.GradualCallableForm;
                            }
                        } else {
                            FunctionType.addParam(
                                functionType,
                                FunctionParam.create(
                                    ParamCategory.Simple,
                                    typeArg,
                                    FunctionParamFlags.NameSynthesized | FunctionParamFlags.TypeDeclared,
                                    `__p${index}`
                                )
                            );
                        }
                    });
                }
            } else {
                evaluator.addDiagnostic(
                    DiagnosticRule.reportInvalidTypeForm,
                    LocMessage.callableFirstArg(),
                    typeArgs[0].node
                );
                isValidTypeForm = false;
            }
        }

        if (typeArgs.length > 1) {
            let typeArg1Type = typeArgs[1].type;
            if (!evaluator.validateTypeArg(typeArgs[1])) {
                typeArg1Type = UnknownType.create();
            }
            functionType.shared.declaredReturnType = convertToInstance(typeArg1Type);
        } else {
            evaluator.addDiagnostic(
                DiagnosticRule.reportMissingTypeArgument,
                LocMessage.callableSecondArg(),
                errorNode
            );
            functionType.shared.declaredReturnType = UnknownType.create();
            isValidTypeForm = false;
        }

        if (typeArgs.length > 2) {
            evaluator.addDiagnostic(
                DiagnosticRule.reportInvalidTypeForm,
                LocMessage.callableExtraArgs(),
                typeArgs[2].node
            );
            isValidTypeForm = false;
        }
    } else {
        FunctionType.addDefaultParams(functionType, /* useUnknown */ true);
        functionType.shared.flags |= FunctionTypeFlags.GradualCallableForm;

        if (typeArgs && typeArgs.length === 0) {
            isValidTypeForm = false;
        }
    }

    if (paramSpec) {
        FunctionType.addParamSpecVariadics(functionType, convertToInstance(paramSpec));
    }

    if (isTypeFormSupported(errorNode) && isValidTypeForm) {
        functionType = TypeBase.cloneWithTypeForm(functionType, convertToInstance(functionType));
    }

    return functionType;
}

function cloneBuiltinClassWithLiteral(
    evaluator: TypeEvaluator,
    node: ParseNode,
    literalClassType: ClassType,
    builtInName: string,
    value: LiteralValue
): Type {
    const type = evaluator.getBuiltInType(node, builtInName);
    if (isInstantiableClass(type)) {
        const literalType = ClassType.cloneWithLiteral(type, value);
        TypeBase.setSpecialForm(literalType, literalClassType);
        return literalType;
    }
    return UnknownType.create();
}

export function createLiteralType(
    evaluator: TypeEvaluator,
    classType: ClassType,
    node: IndexNode,
    flags: EvalFlags,
    registry: TypeRegistry
): Type {
    if (node.d.items.length === 0) {
        evaluator.addDiagnostic(
            DiagnosticRule.reportInvalidTypeForm,
            LocMessage.literalEmptyArgs(),
            node.d.leftExpr
        );
        return UnknownType.create();
    }

    const literalTypes: Type[] = [];
    let isValidTypeForm = true;

    for (const item of node.d.items) {
        let type: Type | undefined;
        const itemExpr = item.d.valueExpr;

        if (item.d.argCategory !== ArgCategory.Simple) {
            if ((flags & EvalFlags.TypeExpression) !== 0) {
                evaluator.addDiagnostic(
                    DiagnosticRule.reportInvalidTypeForm,
                    LocMessage.unpackedArgInTypeArgument(),
                    itemExpr
                );
                type = UnknownType.create();
                isValidTypeForm = false;
            }
        } else if (item.d.name) {
            if ((flags & EvalFlags.TypeExpression) !== 0) {
                evaluator.addDiagnostic(
                    DiagnosticRule.reportInvalidTypeForm,
                    LocMessage.keywordArgInTypeArgument(),
                    itemExpr
                );
                type = UnknownType.create();
                isValidTypeForm = false;
            }
        } else if (itemExpr.nodeType === ParseNodeType.StringList) {
            const isBytes = (itemExpr.d.strings[0].d.token.flags & StringTokenFlags.Bytes) !== 0;
            const value = itemExpr.d.strings.map((s) => s.d.value).join('');
            if (isBytes) {
                type = cloneBuiltinClassWithLiteral(evaluator, node, classType, 'bytes', value);
            } else {
                type = cloneBuiltinClassWithLiteral(evaluator, node, classType, 'str', value);
            }

            if ((flags & EvalFlags.TypeExpression) !== 0) {
                itemExpr.d.strings.forEach((stringNode) => {
                    if ((stringNode.d.token.flags & StringTokenFlags.NamedUnicodeEscape) !== 0) {
                        evaluator.addDiagnostic(
                            DiagnosticRule.reportInvalidTypeForm,
                            LocMessage.literalNamedUnicodeEscape(),
                            stringNode
                        );
                        isValidTypeForm = false;
                    }
                });
            }
        } else if (itemExpr.nodeType === ParseNodeType.Number) {
            if (!itemExpr.d.isImaginary && itemExpr.d.isInteger) {
                type = cloneBuiltinClassWithLiteral(evaluator, node, classType, 'int', itemExpr.d.value);
            }
        } else if (itemExpr.nodeType === ParseNodeType.Constant) {
            if (itemExpr.d.constType === KeywordType.True) {
                type = cloneBuiltinClassWithLiteral(evaluator, node, classType, 'bool', true);
            } else if (itemExpr.d.constType === KeywordType.False) {
                type = cloneBuiltinClassWithLiteral(evaluator, node, classType, 'bool', false);
            } else if (itemExpr.d.constType === KeywordType.None) {
                type = registry.noneTypeClass ?? UnknownType.create();
            }
        } else if (itemExpr.nodeType === ParseNodeType.UnaryOperation) {
            if (itemExpr.d.operator === OperatorType.Subtract || itemExpr.d.operator === OperatorType.Add) {
                if (itemExpr.d.expr.nodeType === ParseNodeType.Number) {
                    if (!itemExpr.d.expr.d.isImaginary && itemExpr.d.expr.d.isInteger) {
                        type = cloneBuiltinClassWithLiteral(
                            evaluator,
                            node,
                            classType,
                            'int',
                            itemExpr.d.operator === OperatorType.Subtract
                                ? -itemExpr.d.expr.d.value
                                : itemExpr.d.expr.d.value
                        );
                    }
                }
            }
        }

        if (!type) {
            const exprType = evaluator.getTypeOfExpression(
                itemExpr,
                (flags & (EvalFlags.ForwardRefs | EvalFlags.TypeExpression)) | EvalFlags.NoConvertSpecialForm
            );

            if (
                isClassInstance(exprType.type) &&
                ClassType.isEnumClass(exprType.type) &&
                exprType.type.priv.literalValue !== undefined
            ) {
                type = ClassType.cloneAsInstantiable(exprType.type);
            } else {
                let isLiteralType = true;

                doForEachSubtype(exprType.type, (subtype) => {
                    if (!isInstantiableClass(subtype) || subtype.priv.literalValue === undefined) {
                        if (!isNoneTypeClass(subtype)) {
                            isLiteralType = false;
                        }
                    }
                });

                if (isLiteralType) {
                    type = exprType.type;
                }
            }
        }

        if (!type) {
            if ((flags & EvalFlags.TypeExpression) !== 0) {
                evaluator.addDiagnostic(
                    DiagnosticRule.reportInvalidTypeForm,
                    LocMessage.literalUnsupportedType(),
                    item
                );
                type = UnknownType.create();
                isValidTypeForm = false;
            } else {
                return ClassType.cloneAsInstance(classType);
            }
        }

        literalTypes.push(type);
    }

    let result = combineTypes(literalTypes, { skipElideRedundantLiterals: true });

    if (isUnion(result) && registry.unionTypeClass && isInstantiableClass(registry.unionTypeClass)) {
        result = TypeBase.cloneAsSpecialForm(result, ClassType.cloneAsInstance(registry.unionTypeClass));
    }

    if (isTypeFormSupported(node) && isValidTypeForm) {
        result = TypeBase.cloneWithTypeForm(result, convertToInstance(result));
    }

    return result;
}

export function createTypeVarType(
    evaluator: TypeEvaluator,
    errorNode: ExpressionNode,
    classType: ClassType,
    argList: Arg[]
): Type | undefined {
    let typeVarName = '';
    let firstConstraintArg: Arg | undefined;
    let defaultValueNode: ExpressionNode | undefined;

    if (argList.length === 0) {
        evaluator.addDiagnostic(DiagnosticRule.reportGeneralTypeIssues, LocMessage.typeVarFirstArg(), errorNode);
        return undefined;
    }

    const firstArg = argList[0];
    if (firstArg.valueExpression && firstArg.valueExpression.nodeType === ParseNodeType.StringList) {
        typeVarName = firstArg.valueExpression.d.strings.map((s) => s.d.value).join('');
    } else {
        evaluator.addDiagnostic(
            DiagnosticRule.reportGeneralTypeIssues,
            LocMessage.typeVarFirstArg(),
            firstArg.valueExpression || errorNode
        );
    }

    const typeVar = TypeBase.cloneAsSpecialForm(
        TypeVarType.createInstantiable(typeVarName),
        ClassType.cloneAsInstance(classType)
    );

    // Parse the remaining parameters.
    const paramNameMap = new Map<string, string>();
    for (let i = 1; i < argList.length; i++) {
        const paramNameNode = argList[i].name;
        const paramName = paramNameNode ? paramNameNode.d.value : undefined;

        if (paramName) {
            if (paramNameMap.get(paramName)) {
                evaluator.addDiagnostic(
                    DiagnosticRule.reportCallIssue,
                    LocMessage.duplicateParam().format({ name: paramName }),
                    argList[i].valueExpression || errorNode
                );
            }

            if (paramName === 'bound') {
                if (TypeVarType.hasConstraints(typeVar)) {
                    evaluator.addDiagnostic(
                        DiagnosticRule.reportGeneralTypeIssues,
                        LocMessage.typeVarBoundAndConstrained(),
                        argList[i].valueExpression || errorNode
                    );
                } else {
                    const argType =
                        argList[i].typeResult?.type ??
                        evaluator.getTypeOfExpressionExpectingType(argList[i].valueExpression!, {
                            noNonTypeSpecialForms: true,
                            typeExpression: true,
                            parsesStringLiteral: true,
                        }).type;
                    if (
                        requiresSpecialization(argType, { ignorePseudoGeneric: true, ignoreImplicitTypeArgs: true })
                    ) {
                        evaluator.addDiagnostic(
                            DiagnosticRule.reportGeneralTypeIssues,
                            LocMessage.typeVarBoundGeneric(),
                            argList[i].valueExpression || errorNode
                        );
                    }
                    typeVar.shared.boundType = convertToInstance(argType);
                }
            } else if (paramName === 'covariant') {
                if (argList[i].valueExpression && getBooleanValue(evaluator, argList[i].valueExpression!)) {
                    if (
                        typeVar.shared.declaredVariance === Variance.Contravariant ||
                        typeVar.shared.declaredVariance === Variance.Auto
                    ) {
                        evaluator.addDiagnostic(
                            DiagnosticRule.reportGeneralTypeIssues,
                            LocMessage.typeVarVariance(),
                            argList[i].valueExpression!
                        );
                    } else {
                        typeVar.shared.declaredVariance = Variance.Covariant;
                    }
                }
            } else if (paramName === 'contravariant') {
                if (argList[i].valueExpression && getBooleanValue(evaluator, argList[i].valueExpression!)) {
                    if (
                        typeVar.shared.declaredVariance === Variance.Covariant ||
                        typeVar.shared.declaredVariance === Variance.Auto
                    ) {
                        evaluator.addDiagnostic(
                            DiagnosticRule.reportGeneralTypeIssues,
                            LocMessage.typeVarVariance(),
                            argList[i].valueExpression!
                        );
                    } else {
                        typeVar.shared.declaredVariance = Variance.Contravariant;
                    }
                }
            } else if (paramName === 'infer_variance') {
                if (argList[i].valueExpression && getBooleanValue(evaluator, argList[i].valueExpression!)) {
                    if (
                        typeVar.shared.declaredVariance === Variance.Covariant ||
                        typeVar.shared.declaredVariance === Variance.Contravariant
                    ) {
                        evaluator.addDiagnostic(
                            DiagnosticRule.reportGeneralTypeIssues,
                            LocMessage.typeVarVariance(),
                            argList[i].valueExpression!
                        );
                    } else {
                        typeVar.shared.declaredVariance = Variance.Auto;
                    }
                }
            } else if (paramName === 'default') {
                defaultValueNode = argList[i].valueExpression;
                const argType =
                    argList[i].typeResult?.type ??
                    evaluator.getTypeOfExpressionExpectingType(defaultValueNode!, {
                        allowTypeVarsWithoutScopeId: true,
                        typeExpression: true,
                    }).type;
                typeVar.shared.defaultType = convertToInstance(argType);
                typeVar.shared.isDefaultExplicit = true;

                const fileInfo = AnalyzerNodeInfo.getFileInfo(errorNode);
                if (
                    !fileInfo.isStubFile &&
                    PythonVersion.isLessThan(fileInfo.executionEnvironment.pythonVersion, pythonVersion3_13) &&
                    classType.shared.moduleName !== 'typing_extensions'
                ) {
                    evaluator.addDiagnostic(
                        DiagnosticRule.reportGeneralTypeIssues,
                        LocMessage.typeVarDefaultIllegal(),
                        defaultValueNode!
                    );
                }
            } else {
                evaluator.addDiagnostic(
                    DiagnosticRule.reportCallIssue,
                    LocMessage.typeVarUnknownParam().format({ name: paramName }),
                    argList[i].node?.d.name || argList[i].valueExpression || errorNode
                );
            }

            paramNameMap.set(paramName, paramName);
        } else {
            if (TypeVarType.hasBound(typeVar)) {
                evaluator.addDiagnostic(
                    DiagnosticRule.reportGeneralTypeIssues,
                    LocMessage.typeVarBoundAndConstrained(),
                    argList[i].valueExpression || errorNode
                );
            } else {
                const argType =
                    argList[i].typeResult?.type ??
                    evaluator.getTypeOfExpressionExpectingType(argList[i].valueExpression!, {
                        typeExpression: true,
                    }).type;

                if (requiresSpecialization(argType, { ignorePseudoGeneric: true })) {
                    evaluator.addDiagnostic(
                        DiagnosticRule.reportGeneralTypeIssues,
                        LocMessage.typeVarConstraintGeneric(),
                        argList[i].valueExpression || errorNode
                    );
                }
                TypeVarType.addConstraint(typeVar, convertToInstance(argType));
                if (firstConstraintArg === undefined) {
                    firstConstraintArg = argList[i];
                }
            }
        }
    }

    if (typeVar.shared.constraints.length === 1 && firstConstraintArg) {
        evaluator.addDiagnostic(
            DiagnosticRule.reportGeneralTypeIssues,
            LocMessage.typeVarSingleConstraint(),
            firstConstraintArg.valueExpression || errorNode
        );
    }

    // If a default is provided, make sure it is compatible with the bound
    // or constraint.
    if (typeVar.shared.isDefaultExplicit && defaultValueNode) {
        verifyTypeVarDefaultIsCompatible(evaluator, typeVar, defaultValueNode);
    }

    return typeVar;
}

export function verifyTypeVarDefaultIsCompatible(
    evaluator: TypeEvaluator,
    typeVar: TypeVarType,
    defaultValueNode: ExpressionNode
) {
    assert(typeVar.shared.isDefaultExplicit);

    const constraints = new ConstraintTracker();
    const concreteDefaultType = evaluator.makeTopLevelTypeVarsConcrete(
        evaluator.solveAndApplyConstraints(typeVar.shared.defaultType, constraints, {
            replaceUnsolved: {
                scopeIds: getTypeVarScopeIds(typeVar),
                tupleClassType: evaluator.getTupleClassType(),
            },
        })
    );

    if (typeVar.shared.boundType) {
        if (!evaluator.assignType(typeVar.shared.boundType, concreteDefaultType)) {
            evaluator.addDiagnostic(
                DiagnosticRule.reportGeneralTypeIssues,
                LocMessage.typeVarDefaultBoundMismatch(),
                defaultValueNode
            );
        }
    } else if (TypeVarType.hasConstraints(typeVar)) {
        let isConstraintCompatible = true;

        // If the default type is a constrained TypeVar, make sure all of its constraints
        // are also constraints in typeVar. If the default type is not a constrained TypeVar,
        // use its concrete type to compare against the constraints.
        if (isTypeVar(typeVar.shared.defaultType) && TypeVarType.hasConstraints(typeVar.shared.defaultType)) {
            for (const constraint of typeVar.shared.defaultType.shared.constraints) {
                if (!typeVar.shared.constraints.some((c) => isTypeSame(c, constraint))) {
                    isConstraintCompatible = false;
                }
            }
        } else if (
            !typeVar.shared.constraints.some((constraint) =>
                isTypeSame(constraint, concreteDefaultType, { ignoreConditions: true })
            )
        ) {
            isConstraintCompatible = false;
        }

        if (!isConstraintCompatible) {
            evaluator.addDiagnostic(
                DiagnosticRule.reportGeneralTypeIssues,
                LocMessage.typeVarDefaultConstraintMismatch(),
                defaultValueNode
            );
        }
    }
}

export function createTypeVarTupleType(
    evaluator: TypeEvaluator,
    errorNode: ExpressionNode,
    classType: ClassType,
    argList: Arg[]
): Type | undefined {
    let typeVarName = '';

    if (argList.length === 0) {
        evaluator.addDiagnostic(DiagnosticRule.reportCallIssue, LocMessage.typeVarFirstArg(), errorNode);
        return undefined;
    }

    const firstArg = argList[0];
    if (firstArg.valueExpression && firstArg.valueExpression.nodeType === ParseNodeType.StringList) {
        typeVarName = firstArg.valueExpression.d.strings.map((s) => s.d.value).join('');
    } else {
        evaluator.addDiagnostic(
            DiagnosticRule.reportGeneralTypeIssues,
            LocMessage.typeVarFirstArg(),
            firstArg.valueExpression || errorNode
        );
    }

    const typeVar = TypeBase.cloneAsSpecialForm(
        TypeVarType.createInstantiable(typeVarName, TypeVarKind.TypeVarTuple),
        ClassType.cloneAsInstance(classType)
    );
    typeVar.shared.defaultType = makeTupleObject(evaluator, [
        { type: UnknownType.create(), isUnbounded: true },
    ]);

    // Parse the remaining parameters.
    for (let i = 1; i < argList.length; i++) {
        const paramNameNode = argList[i].name;
        const paramName = paramNameNode ? paramNameNode.d.value : undefined;

        if (paramName) {
            if (paramName === 'default') {
                const expr = argList[i].valueExpression;
                if (expr) {
                    const defaultType = getTypeVarTupleDefaultType(evaluator, expr, /* isPep695Syntax */ false);
                    if (defaultType) {
                        typeVar.shared.defaultType = defaultType;
                        typeVar.shared.isDefaultExplicit = true;
                    }
                }

                const fileInfo = AnalyzerNodeInfo.getFileInfo(errorNode);
                if (
                    !fileInfo.isStubFile &&
                    PythonVersion.isLessThan(fileInfo.executionEnvironment.pythonVersion, pythonVersion3_13) &&
                    classType.shared.moduleName !== 'typing_extensions'
                ) {
                    evaluator.addDiagnostic(
                        DiagnosticRule.reportGeneralTypeIssues,
                        LocMessage.typeVarDefaultIllegal(),
                        expr!
                    );
                }
            } else {
                evaluator.addDiagnostic(
                    DiagnosticRule.reportGeneralTypeIssues,
                    LocMessage.typeVarTupleUnknownParam().format({ name: argList[i].name?.d.value || '?' }),
                    argList[i].node?.d.name || argList[i].valueExpression || errorNode
                );
            }
        } else {
            evaluator.addDiagnostic(
                DiagnosticRule.reportGeneralTypeIssues,
                LocMessage.typeVarTupleConstraints(),
                argList[i].valueExpression || errorNode
            );
        }
    }

    return typeVar;
}

export function getTypeVarTupleDefaultType(
    evaluator: TypeEvaluator,
    node: ExpressionNode,
    isPep695Syntax: boolean
): Type | undefined {
    const argType = evaluator.getTypeOfExpressionExpectingType(node, {
        allowUnpackedTuple: true,
        allowTypeVarsWithoutScopeId: true,
        forwardRefs: isPep695Syntax,
        typeExpression: true,
    }).type;
    const isUnpackedTuple = isClass(argType) && isTupleClass(argType) && argType.priv.isUnpacked;
    const isUnpackedTypeVarResult = isUnpackedTypeVarTuple(argType);

    if (!isUnpackedTuple && !isUnpackedTypeVarResult) {
        evaluator.addDiagnostic(DiagnosticRule.reportGeneralTypeIssues, LocMessage.typeVarTupleDefaultNotUnpacked(), node);
        return undefined;
    }

    return convertToInstance(argType);
}

export function createParamSpecType(
    evaluator: TypeEvaluator,
    errorNode: ExpressionNode,
    classType: ClassType,
    argList: Arg[]
): Type | undefined {
    if (argList.length === 0) {
        evaluator.addDiagnostic(DiagnosticRule.reportCallIssue, LocMessage.paramSpecFirstArg(), errorNode);
        return undefined;
    }

    const firstArg = argList[0];
    let paramSpecName = '';
    if (firstArg.valueExpression && firstArg.valueExpression.nodeType === ParseNodeType.StringList) {
        paramSpecName = firstArg.valueExpression.d.strings.map((s) => s.d.value).join('');
    } else {
        evaluator.addDiagnostic(
            DiagnosticRule.reportGeneralTypeIssues,
            LocMessage.paramSpecFirstArg(),
            firstArg.valueExpression || errorNode
        );
    }

    const paramSpec = TypeBase.cloneAsSpecialForm(
        TypeVarType.createInstantiable(paramSpecName, TypeVarKind.ParamSpec),
        ClassType.cloneAsInstance(classType)
    );

    paramSpec.shared.defaultType = ParamSpecType.getUnknown();

    // Parse the remaining parameters.
    for (let i = 1; i < argList.length; i++) {
        const paramNameNode = argList[i].name;
        const paramName = paramNameNode ? paramNameNode.d.value : undefined;

        if (paramName) {
            if (paramName === 'default') {
                const expr = argList[i].valueExpression;
                if (expr) {
                    const defaultType = getParamSpecDefaultType(evaluator, expr, /* isPep695Syntax */ false);
                    if (defaultType) {
                        paramSpec.shared.defaultType = defaultType;
                        paramSpec.shared.isDefaultExplicit = true;
                    }
                }

                const fileInfo = AnalyzerNodeInfo.getFileInfo(errorNode);
                if (
                    !fileInfo.isStubFile &&
                    PythonVersion.isLessThan(fileInfo.executionEnvironment.pythonVersion, pythonVersion3_13) &&
                    classType.shared.moduleName !== 'typing_extensions'
                ) {
                    evaluator.addDiagnostic(
                        DiagnosticRule.reportGeneralTypeIssues,
                        LocMessage.typeVarDefaultIllegal(),
                        expr!
                    );
                }
            } else {
                evaluator.addDiagnostic(
                    DiagnosticRule.reportGeneralTypeIssues,
                    LocMessage.paramSpecUnknownParam().format({ name: paramName }),
                    paramNameNode || argList[i].valueExpression || errorNode
                );
            }
        } else {
            evaluator.addDiagnostic(
                DiagnosticRule.reportCallIssue,
                LocMessage.paramSpecUnknownArg(),
                argList[i].valueExpression || errorNode
            );
            break;
        }
    }

    return paramSpec;
}

export function getParamSpecDefaultType(
    evaluator: TypeEvaluator,
    node: ExpressionNode,
    isPep695Syntax: boolean
): Type | undefined {
    const functionType = FunctionType.createSynthesizedInstance('', FunctionTypeFlags.ParamSpecValue);

    if (node.nodeType === ParseNodeType.Ellipsis) {
        FunctionType.addDefaultParams(functionType);
        functionType.shared.flags |= FunctionTypeFlags.GradualCallableForm;
        return functionType;
    }

    if (node.nodeType === ParseNodeType.List) {
        node.d.items.forEach((paramExpr, index) => {
            const typeResult = evaluator.getTypeOfExpressionExpectingType(paramExpr, {
                allowTypeVarsWithoutScopeId: true,
                forwardRefs: isPep695Syntax,
                typeExpression: true,
            });

            FunctionType.addParam(
                functionType,
                FunctionParam.create(
                    ParamCategory.Simple,
                    convertToInstance(typeResult.type),
                    FunctionParamFlags.NameSynthesized | FunctionParamFlags.TypeDeclared,
                    `__p${index}`
                )
            );
        });

        if (node.d.items.length > 0) {
            FunctionType.addPositionOnlyParamSeparator(functionType);
        }

        // Update the type cache so we don't attempt to re-evaluate this node.
        // The type doesn't matter, so use Any.
        evaluator.setTypeResultForNode(node, { type: AnyType.create() });
        return functionType;
    } else {
        const typeResult = evaluator.getTypeOfExpressionExpectingType(node, {
            allowParamSpec: true,
            allowTypeVarsWithoutScopeId: true,
            allowEllipsis: true,
            typeExpression: true,
        });

        if (typeResult.typeErrors) {
            return undefined;
        }

        if (isParamSpec(typeResult.type)) {
            FunctionType.addParamSpecVariadics(functionType, typeResult.type);
            return functionType;
        }

        if (
            isClassInstance(typeResult.type) &&
            ClassType.isBuiltIn(typeResult.type, ['EllipsisType', 'ellipsis'])
        ) {
            FunctionType.addDefaultParams(functionType);
            return functionType;
        }
    }

    evaluator.addDiagnostic(DiagnosticRule.reportGeneralTypeIssues, LocMessage.paramSpecDefaultNotTuple(), node);

    return undefined;
}

export function createTypeAliasType(
    evaluator: TypeEvaluator,
    errorNode: ExpressionNode,
    argList: Arg[],
    flags: EvalFlags
): Type {
    throw new Error('Not yet extracted');
}

export function createNewType(
    evaluator: TypeEvaluator,
    errorNode: ExpressionNode,
    argList: Arg[],
    registry: TypeRegistry
): ClassType | undefined {
    const fileInfo = AnalyzerNodeInfo.getFileInfo(errorNode);
    let className = '';

    if (argList.length !== 2) {
        evaluator.addDiagnostic(DiagnosticRule.reportCallIssue, LocMessage.newTypeParamCount(), errorNode);
        return undefined;
    }

    const nameArg = argList[0];
    if (
        nameArg.argCategory === ArgCategory.Simple &&
        nameArg.valueExpression &&
        nameArg.valueExpression.nodeType === ParseNodeType.StringList
    ) {
        className = nameArg.valueExpression.d.strings.map((s) => s.d.value).join('');
    }

    if (!className) {
        evaluator.addDiagnostic(
            DiagnosticRule.reportArgumentType,
            LocMessage.newTypeBadName(),
            argList[0].node ?? errorNode
        );
        return undefined;
    }

    if (
        errorNode.parent?.nodeType === ParseNodeType.Assignment &&
        errorNode.parent.d.leftExpr.nodeType === ParseNodeType.Name &&
        errorNode.parent.d.leftExpr.d.value !== className
    ) {
        evaluator.addDiagnostic(
            DiagnosticRule.reportGeneralTypeIssues,
            LocMessage.newTypeNameMismatch(),
            errorNode.parent.d.leftExpr
        );
        return undefined;
    }

    let baseClass = (
        argList[1].typeResult ?? evaluator.getTypeOfExpressionExpectingType(argList[1].valueExpression!)
    ).type;
    let isBaseClassAny = false;

    if (isAnyOrUnknown(baseClass)) {
        baseClass = registry.objectClass ?? UnknownType.create();

        evaluator.addDiagnostic(
            DiagnosticRule.reportGeneralTypeIssues,
            LocMessage.newTypeAnyOrUnknown(),
            argList[1].node ?? errorNode
        );

        isBaseClassAny = true;
    }

    // Specifically disallow Annotated.
    if (
        baseClass.props?.specialForm &&
        isClassInstance(baseClass.props.specialForm) &&
        ClassType.isBuiltIn(baseClass.props.specialForm, 'Annotated')
    ) {
        evaluator.addDiagnostic(
            DiagnosticRule.reportGeneralTypeIssues,
            LocMessage.newTypeNotAClass(),
            argList[1].node || errorNode
        );
        return undefined;
    }

    if (!isInstantiableClass(baseClass)) {
        evaluator.addDiagnostic(
            DiagnosticRule.reportGeneralTypeIssues,
            LocMessage.newTypeNotAClass(),
            argList[1].node || errorNode
        );
        return undefined;
    }

    if (ClassType.isProtocolClass(baseClass) || ClassType.isTypedDictClass(baseClass)) {
        evaluator.addDiagnostic(
            DiagnosticRule.reportGeneralTypeIssues,
            LocMessage.newTypeProtocolClass(),
            argList[1].node || errorNode
        );
    } else if (baseClass.priv.literalValue !== undefined) {
        evaluator.addDiagnostic(
            DiagnosticRule.reportGeneralTypeIssues,
            LocMessage.newTypeLiteral(),
            argList[1].node || errorNode
        );
    }

    const classType = ClassType.createInstantiable(
        className,
        ParseTreeUtils.getClassFullName(errorNode, fileInfo.moduleName, className),
        fileInfo.moduleName,
        fileInfo.fileUri,
        ClassTypeFlags.Final | ClassTypeFlags.NewTypeClass | ClassTypeFlags.ValidTypeAliasClass,
        ParseTreeUtils.getTypeSourceId(errorNode),
        /* declaredMetaclass */ undefined,
        baseClass.shared.effectiveMetaclass
    );
    classType.shared.baseClasses.push(isBaseClassAny ? AnyType.create() : baseClass);
    computeMroLinearization(classType);

    if (!isBaseClassAny) {
        // Synthesize an __init__ method that accepts only the specified type.
        const initType = FunctionType.createSynthesizedInstance('__init__');
        FunctionType.addParam(
            initType,
            FunctionParam.create(ParamCategory.Simple, AnyType.create(), FunctionParamFlags.TypeDeclared, 'self')
        );
        FunctionType.addParam(
            initType,
            FunctionParam.create(
                ParamCategory.Simple,
                ClassType.cloneAsInstance(baseClass),
                FunctionParamFlags.TypeDeclared,
                '_x'
            )
        );
        initType.shared.declaredReturnType = evaluator.getNoneType();
        ClassType.getSymbolTable(classType).set(
            '__init__',
            Symbol.createWithType(SymbolFlags.ClassMember, initType)
        );

        // Synthesize a trivial __new__ method.
        const newType = FunctionType.createSynthesizedInstance('__new__', FunctionTypeFlags.ConstructorMethod);
        FunctionType.addParam(
            newType,
            FunctionParam.create(ParamCategory.Simple, AnyType.create(), FunctionParamFlags.TypeDeclared, 'cls')
        );
        FunctionType.addDefaultParams(newType);
        newType.shared.declaredReturnType = ClassType.cloneAsInstance(classType);
        newType.priv.constructorTypeVarScopeId = getTypeVarScopeId(classType);
        ClassType.getSymbolTable(classType).set('__new__', Symbol.createWithType(SymbolFlags.ClassMember, newType));
    }

    return classType;
}

export function createClassFromMetaclass(
    evaluator: TypeEvaluator,
    errorNode: ExpressionNode,
    argList: Arg[],
    metaclassType: ClassType
): Type {
    throw new Error('Not yet extracted');
}

export function createSpecialBuiltInClass(
    evaluator: TypeEvaluator,
    node: ParseNode,
    assignedName: string,
    aliasMapEntry: AliasMapEntry,
    registry: TypeRegistry
): ClassType {
    throw new Error('Not yet extracted');
}

export function createSubclass(
    evaluator: TypeEvaluator,
    errorNode: ExpressionNode,
    typeArgs: TypeResultWithNode[] | undefined,
    registry: TypeRegistry
): Type {
    throw new Error('Not yet extracted');
}

export function createSpecializedClassType(
    evaluator: TypeEvaluator,
    classType: ClassType,
    typeArgs: TypeResultWithNode[] | undefined,
    flags: EvalFlags,
    errorNode: ParseNode,
    registry: TypeRegistry
): Type {
    throw new Error('Not yet extracted');
}

export function createSpecializedTypeAlias(
    evaluator: TypeEvaluator,
    indexNode: IndexNode,
    typeResult: TypeResult,
    flags: EvalFlags,
    registry: TypeRegistry
): Type {
    throw new Error('Not yet extracted');
}

export function createAsyncFunction(
    evaluator: TypeEvaluator,
    node: FunctionNode,
    functionType: FunctionType
): FunctionType {
    assert(FunctionType.isAsync(functionType));

    // Clone the original function and replace its return type with an
    // Awaitable[<returnType>]. Mark the new function as no longer async.
    const awaitableFunctionType = FunctionType.cloneWithNewFlags(
        functionType,
        functionType.shared.flags & ~(FunctionTypeFlags.Async | FunctionTypeFlags.PartiallyEvaluated)
    );

    if (functionType.shared.declaredReturnType) {
        awaitableFunctionType.shared.declaredReturnType = createAwaitableReturnType(
            evaluator,
            node,
            functionType.shared.declaredReturnType,
            FunctionType.isGenerator(functionType)
        );
    } else {
        awaitableFunctionType.shared.inferredReturnType = {
            type: createAwaitableReturnType(
                evaluator,
                node,
                evaluator.getInferredReturnType(functionType),
                FunctionType.isGenerator(functionType)
            ),
        };
    }

    return awaitableFunctionType;
}

export function createAwaitableReturnType(
    evaluator: TypeEvaluator,
    node: ParseNode,
    returnType: Type,
    isGenerator: boolean,
    useCoroutine = true
): Type {
    let awaitableReturnType: Type | undefined;

    if (isClassInstance(returnType)) {
        if (ClassType.isBuiltIn(returnType)) {
            if (returnType.shared.name === 'Generator') {
                // If the return type is a Generator, change it to an AsyncGenerator.
                const asyncGeneratorType = evaluator.getTypingType(node, 'AsyncGenerator');
                if (asyncGeneratorType && isInstantiableClass(asyncGeneratorType)) {
                    const typeArgs: Type[] = [];
                    const generatorTypeArgs = returnType.priv.typeArgs;
                    if (generatorTypeArgs && generatorTypeArgs.length > 0) {
                        typeArgs.push(generatorTypeArgs[0]);
                    }
                    if (generatorTypeArgs && generatorTypeArgs.length > 1) {
                        typeArgs.push(generatorTypeArgs[1]);
                    }
                    awaitableReturnType = ClassType.cloneAsInstance(
                        ClassType.specialize(asyncGeneratorType, typeArgs)
                    );
                }
            } else if (['AsyncIterator', 'AsyncIterable'].some((name) => name === returnType.shared.name)) {
                // If it's already an AsyncIterator or AsyncIterable, leave it as is.
                awaitableReturnType = returnType;
            } else if (returnType.shared.name === 'AsyncGenerator') {
                // If it's already an AsyncGenerator and the function is a generator,
                // leave it as is.
                if (isGenerator) {
                    awaitableReturnType = returnType;
                }
            }
        }
    }

    if (!awaitableReturnType || !isGenerator) {
        // Wrap in either an Awaitable or a CoroutineType, which is a subclass of Awaitable.
        const awaitableType = useCoroutine ? evaluator.getTypesType(node, 'CoroutineType') : evaluator.getTypingType(node, 'Awaitable');
        if (awaitableType && isInstantiableClass(awaitableType)) {
            awaitableReturnType = ClassType.cloneAsInstance(
                ClassType.specialize(
                    awaitableType,
                    useCoroutine ? [AnyType.create(), AnyType.create(), returnType] : [returnType]
                )
            );
        } else {
            awaitableReturnType = UnknownType.create();
        }
    }

    return awaitableReturnType;
}
