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
import { DiagnosticAddendum } from '../common/diagnostic';
import { DiagnosticRule } from '../common/diagnosticRules';
import { LocAddendum, LocMessage } from '../localization/localize';
import {
    ArgCategory,
    ExpressionNode,
    FunctionNode,
    IndexNode,
    ParamCategory,
    ParseNode,
    ParseNodeType,
} from '../parser/parseNodes';
import { PythonVersion, pythonVersion3_9, pythonVersion3_13 } from '../common/pythonVersion';
import { KeywordType, OperatorType, StringTokenFlags } from '../parser/tokenizerTypes';
import { isAnnotationEvaluationPostponed } from './analyzerFileInfo';
import * as AnalyzerNodeInfo from './analyzerNodeInfo';
import { SpecialBuiltInClassDeclaration } from './declaration';
import { getFunctionInfoFromDecorators } from './decorators';
import * as ParseTreeUtils from './parseTreeUtils';
import { assignTypeVar, solveConstraints } from './constraintSolver';
import { ConstraintTracker } from './constraintTracker';
import { Arg, AssignTypeFlags, EvalFlags, TypeEvaluator, TypeResult, TypeResultWithNode } from './typeEvaluatorTypes';
import { ScopeType } from './scope';
import * as ScopeUtils from './scopeUtils';
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
    ParamSpecType,
    TupleTypeArg,
    Type,
    TypeBase,
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
    isFunction,
    isFunctionOrOverloaded,
    isNever,
    isUnpacked,
    isUnpackedTypeVarTuple,
    TypeVarKind,
} from './types';
import {
    addConditionToType,
    computeMroLinearization,
    convertToInstance,
    convertToInstantiable,
    doForEachSubtype,
    getTypeVarScopeId,
    isEffectivelyInstantiable,
    isEllipsisType,
    isInstantiableMetaclass,
    isNoneInstance,
    isNoneTypeClass,
    isTupleClass,
    isUnboundedTupleClass,
    explodeGenericClass,
    getTypeVarScopeIds,
    getUnknownForTypeVar,
    isTypeAliasPlaceholder,
    isVarianceOfTypeArgCompatible,
    requiresSpecialization,
    transformPossibleRecursiveTypeAlias,
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
        optionalType = TypeBase.cloneAsSpecialForm(optionalType, ClassType.cloneAsInstance(registry.unionTypeClass));
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
        const functionInfo = getFunctionInfoFromDecorators(evaluator, enclosingFunction, /* isInClass */ true);

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
function validateAnnotatedMetadata(errorNode: ExpressionNode, baseType: Type, metaArgs: TypeResultWithNode[]): Type {
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
            evaluator.addDiagnostic(
                DiagnosticRule.reportInvalidTypeForm,
                LocMessage.genericTypeArgMissing(),
                errorNode
            );
        }
        return classType;
    }

    const uniqueTypeVars: TypeVarType[] = [];
    if (typeArgs) {
        if (typeArgs.length === 0) {
            evaluator.addDiagnostic(
                DiagnosticRule.reportInvalidTypeForm,
                LocMessage.genericTypeArgMissing(),
                errorNode
            );
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
        evaluator.addDiagnostic(DiagnosticRule.reportInvalidTypeForm, LocMessage.literalEmptyArgs(), node.d.leftExpr);
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
                    if (requiresSpecialization(argType, { ignorePseudoGeneric: true, ignoreImplicitTypeArgs: true })) {
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
    typeVar.shared.defaultType = makeTupleObject(evaluator, [{ type: UnknownType.create(), isUnbounded: true }]);

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
        evaluator.addDiagnostic(
            DiagnosticRule.reportGeneralTypeIssues,
            LocMessage.typeVarTupleDefaultNotUnpacked(),
            node
        );
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

        if (isClassInstance(typeResult.type) && ClassType.isBuiltIn(typeResult.type, ['EllipsisType', 'ellipsis'])) {
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
    argList: Arg[]
): Type | undefined {
    if (errorNode.nodeType !== ParseNodeType.Call || !errorNode.parent || argList.length < 2) {
        return undefined;
    }

    if (
        errorNode.parent.nodeType !== ParseNodeType.Assignment ||
        errorNode.parent.d.rightExpr !== errorNode ||
        errorNode.parent.d.leftExpr.nodeType !== ParseNodeType.Name
    ) {
        evaluator.addDiagnostic(
            DiagnosticRule.reportGeneralTypeIssues,
            LocMessage.typeAliasTypeMustBeAssigned(),
            errorNode
        );
        return undefined;
    }

    const scope = ScopeUtils.getScopeForNode(errorNode);
    if (scope) {
        if (scope.type !== ScopeType.Class && scope.type !== ScopeType.Module && scope.type !== ScopeType.Builtin) {
            evaluator.addDiagnostic(
                DiagnosticRule.reportGeneralTypeIssues,
                LocMessage.typeAliasTypeBadScope(),
                errorNode.parent.d.leftExpr
            );
        }
    }

    const nameNode = errorNode.parent.d.leftExpr;

    const firstArg = argList[0];
    if (firstArg.valueExpression && firstArg.valueExpression.nodeType === ParseNodeType.StringList) {
        const typeAliasName = firstArg.valueExpression.d.strings.map((s) => s.d.value).join('');
        if (typeAliasName !== nameNode.d.value) {
            evaluator.addDiagnostic(
                DiagnosticRule.reportGeneralTypeIssues,
                LocMessage.typeAliasTypeNameMismatch(),
                firstArg.valueExpression
            );
        }
    } else {
        evaluator.addDiagnostic(
            DiagnosticRule.reportGeneralTypeIssues,
            LocMessage.typeAliasTypeNameArg(),
            firstArg.valueExpression || errorNode
        );
        return undefined;
    }

    let valueExpr: ExpressionNode | undefined;
    let typeParamsExpr: ExpressionNode | undefined;

    // Parse the remaining parameters.
    for (let i = 1; i < argList.length; i++) {
        const paramNameNode = argList[i].name;
        const paramName = paramNameNode ? paramNameNode.d.value : undefined;

        if (paramName) {
            if (paramName === 'type_params' && !typeParamsExpr) {
                typeParamsExpr = argList[i].valueExpression;
            } else if (paramName === 'value' && !valueExpr) {
                valueExpr = argList[i].valueExpression;
            } else {
                return undefined;
            }
        } else if (i === 1) {
            valueExpr = argList[i].valueExpression;
        } else {
            return undefined;
        }
    }

    // The value expression is not optional, so bail if it's not present.
    if (!valueExpr) {
        return undefined;
    }

    let typeParams: TypeVarType[] | undefined;
    if (typeParamsExpr) {
        if (typeParamsExpr.nodeType !== ParseNodeType.Tuple) {
            evaluator.addDiagnostic(
                DiagnosticRule.reportGeneralTypeIssues,
                LocMessage.typeAliasTypeParamInvalid(),
                typeParamsExpr
            );
            return undefined;
        }

        typeParams = [];
        let isTypeParamListValid = true;
        typeParamsExpr.d.items.map((expr) => {
            let entryType = evaluator.getTypeOfExpression(
                expr,
                EvalFlags.InstantiableType | EvalFlags.AllowTypeVarWithoutScopeId
            ).type;

            if (isTypeVar(entryType)) {
                if (entryType.priv.scopeId || (isTypeVarTuple(entryType) && entryType.priv.isUnpacked)) {
                    isTypeParamListValid = false;
                } else {
                    entryType = TypeVarType.cloneForScopeId(
                        entryType,
                        ParseTreeUtils.getScopeIdForNode(nameNode),
                        nameNode.d.value,
                        TypeVarScopeType.TypeAlias
                    );
                }

                typeParams!.push(entryType);
            } else {
                isTypeParamListValid = false;
            }
        });

        if (!isTypeParamListValid) {
            evaluator.addDiagnostic(
                DiagnosticRule.reportGeneralTypeIssues,
                LocMessage.typeAliasTypeParamInvalid(),
                typeParamsExpr
            );
            return undefined;
        }
    }

    return evaluator.getTypeOfTypeAliasCommon(
        nameNode,
        nameNode,
        valueExpr,
        /* isPep695Syntax */ false,
        /* typeParamNodes */ undefined,
        () => typeParams
    );
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

    let baseClass = (argList[1].typeResult ?? evaluator.getTypeOfExpressionExpectingType(argList[1].valueExpression!))
        .type;
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
        ClassType.getSymbolTable(classType).set('__init__', Symbol.createWithType(SymbolFlags.ClassMember, initType));

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
    metaclass: ClassType
): ClassType | undefined {
    const fileInfo = AnalyzerNodeInfo.getFileInfo(errorNode);
    const arg0Type = evaluator.getTypeOfArg(argList[0], /* inferenceContext */ undefined).type;
    if (!isClassInstance(arg0Type) || !ClassType.isBuiltIn(arg0Type, 'str')) {
        return undefined;
    }
    const className = (arg0Type.priv.literalValue as string) || '_';

    const arg1Type = evaluator.getTypeOfArg(argList[1], /* inferenceContext */ undefined).type;

    // TODO - properly handle case where tuple of base classes is provided.
    if (!isClassInstance(arg1Type) || !isTupleClass(arg1Type) || arg1Type.priv.tupleTypeArgs === undefined) {
        return undefined;
    }

    const classType = ClassType.createInstantiable(
        className,
        ParseTreeUtils.getClassFullName(errorNode, fileInfo.moduleName, className),
        fileInfo.moduleName,
        fileInfo.fileUri,
        ClassTypeFlags.ValidTypeAliasClass,
        ParseTreeUtils.getTypeSourceId(errorNode),
        metaclass,
        arg1Type.shared.effectiveMetaclass
    );
    arg1Type.priv.tupleTypeArgs.forEach((typeArg) => {
        const specializedType = evaluator.makeTopLevelTypeVarsConcrete(typeArg.type);

        if (isEffectivelyInstantiable(specializedType)) {
            classType.shared.baseClasses.push(specializedType);
        } else {
            classType.shared.baseClasses.push(UnknownType.create());
        }
    });

    if (!computeMroLinearization(classType)) {
        evaluator.addDiagnostic(DiagnosticRule.reportGeneralTypeIssues, LocMessage.methodOrdering(), errorNode);
    }

    return classType;
}

export function createSpecialBuiltInClass(
    evaluator: TypeEvaluator,
    node: ParseNode,
    assignedName: string,
    aliasMapEntry: AliasMapEntry,
    registry: TypeRegistry
): ClassType {
    const fileInfo = AnalyzerNodeInfo.getFileInfo(node);
    let specialClassType = ClassType.createInstantiable(
        assignedName,
        ParseTreeUtils.getClassFullName(node, fileInfo.moduleName, assignedName),
        fileInfo.moduleName,
        fileInfo.fileUri,
        ClassTypeFlags.BuiltIn | ClassTypeFlags.SpecialBuiltIn,
        /* typeSourceId */ 0,
        /* declaredMetaclass */ undefined,
        /* effectiveMetaclass */ undefined
    );

    if (aliasMapEntry.isSpecialForm) {
        specialClassType.shared.flags |= ClassTypeFlags.SpecialFormClass;
    }

    if (aliasMapEntry.isIllegalInIsinstance) {
        specialClassType.shared.flags |= ClassTypeFlags.IllegalIsinstanceClass;
    }

    // Synthesize a single type parameter with the specified variance if
    // specified in the alias map entry.
    if (aliasMapEntry.typeParamVariance !== undefined) {
        let typeParam = TypeVarType.createInstance('T');
        typeParam = TypeVarType.cloneForScopeId(
            typeParam,
            ParseTreeUtils.getScopeIdForNode(node),
            assignedName,
            TypeVarScopeType.Class
        );
        typeParam.shared.declaredVariance = aliasMapEntry.typeParamVariance;
        specialClassType.shared.typeParams.push(typeParam);
    }

    const specialBuiltInClassDeclaration = (AnalyzerNodeInfo.getDeclaration(node) ??
        (node.parent ? AnalyzerNodeInfo.getDeclaration(node.parent) : undefined)) as
        | SpecialBuiltInClassDeclaration
        | undefined;

    specialClassType.shared.declaration = specialBuiltInClassDeclaration;

    if (fileInfo.isTypingExtensionsStubFile) {
        specialClassType.shared.flags |= ClassTypeFlags.TypingExtensionClass;
    }

    const baseClassName = aliasMapEntry.implicitBaseClass || aliasMapEntry.alias || 'object';

    let baseClass: Type | undefined;
    if (aliasMapEntry.module === 'builtins') {
        baseClass = evaluator.getBuiltInType(node, baseClassName);
    } else if (aliasMapEntry.module === 'collections') {
        // The typing.pyi file imports collections.
        baseClass = evaluator.getTypeOfModule(node, baseClassName, ['collections']);
    } else if (aliasMapEntry.module === 'internals') {
        // Handle TypedDict specially.
        assert(baseClassName === 'TypedDictFallback');
        baseClass = registry.typedDictPrivateClass;
        if (baseClass) {
            // The TypedDictFallback class is marked as abstract, but the
            // methods that are abstract are overridden and shouldn't
            // cause the TypedDict to be marked as abstract.
            if (isInstantiableClass(baseClass) && ClassType.isBuiltIn(baseClass, ['_TypedDict', 'TypedDictFallback'])) {
                baseClass = ClassType.cloneWithNewFlags(
                    baseClass,
                    baseClass.shared.flags & ~(ClassTypeFlags.SupportsAbstractMethods | ClassTypeFlags.TypeCheckOnly)
                );
            }
        }
    }

    if (baseClass && isInstantiableClass(baseClass)) {
        if (aliasMapEntry.alias) {
            specialClassType = ClassType.cloneForTypingAlias(baseClass, assignedName);
        } else {
            specialClassType.shared.baseClasses.push(baseClass);
            specialClassType.shared.effectiveMetaclass = baseClass.shared.effectiveMetaclass;
            computeMroLinearization(specialClassType);
        }
    } else {
        specialClassType.shared.baseClasses.push(UnknownType.create());
        specialClassType.shared.effectiveMetaclass = UnknownType.create();
        computeMroLinearization(specialClassType);
    }

    return specialClassType;
}

export function createSubclass(
    evaluator: TypeEvaluator,
    errorNode: ExpressionNode,
    type1: ClassType,
    type2: ClassType
): ClassType {
    assert(isInstantiableClass(type1) && isInstantiableClass(type2));

    // If both classes are class objects (type[A] and type[B]), create a new
    // class object (type[A & B]) rather than "type[A] & type[B]".
    let createClassObject = false;
    if (TypeBase.getInstantiableDepth(type1) > 0 && TypeBase.getInstantiableDepth(type2) > 0) {
        type1 = ClassType.cloneAsInstance(type1);
        type2 = ClassType.cloneAsInstance(type2);
        createClassObject = true;
    }

    const className = `<subclass of ${evaluator.printType(convertToInstance(type1), {
        omitTypeArgsIfUnknown: true,
    })} and ${evaluator.printType(convertToInstance(type2), { omitTypeArgsIfUnknown: true })}>`;
    const fileInfo = AnalyzerNodeInfo.getFileInfo(errorNode);

    // The effective metaclass of the intersection is the narrower of the two metaclasses.
    let effectiveMetaclass = type1.shared.effectiveMetaclass;
    if (type2.shared.effectiveMetaclass) {
        if (!effectiveMetaclass || evaluator.assignType(effectiveMetaclass, type2.shared.effectiveMetaclass)) {
            effectiveMetaclass = type2.shared.effectiveMetaclass;
        }
    }

    let newClassType = ClassType.createInstantiable(
        className,
        ParseTreeUtils.getClassFullName(errorNode, fileInfo.moduleName, className),
        fileInfo.moduleName,
        fileInfo.fileUri,
        ClassTypeFlags.None,
        ParseTreeUtils.getTypeSourceId(errorNode),
        /* declaredMetaclass */ undefined,
        effectiveMetaclass,
        type1.shared.docString
    );

    newClassType.shared.baseClasses = [type1, type2];
    computeMroLinearization(newClassType);

    newClassType = addConditionToType(newClassType, type1.props?.condition);
    newClassType = addConditionToType(newClassType, type2.props?.condition);

    if (createClassObject) {
        newClassType = ClassType.cloneAsInstantiable(newClassType);
    }

    return newClassType;
}

function applyTypeArgToTypeVar(
    evaluator: TypeEvaluator,
    destType: TypeVarType,
    srcType: Type,
    diag: DiagnosticAddendum
): Type | undefined {
    if (isAnyOrUnknown(srcType)) {
        return srcType;
    }

    let effectiveSrcType: Type = transformPossibleRecursiveTypeAlias(srcType);

    if (isTypeVar(srcType)) {
        if (isTypeSame(srcType, destType)) {
            return srcType;
        }

        effectiveSrcType = evaluator.makeTopLevelTypeVarsConcrete(srcType);
    }

    // If this is a partially-evaluated class, don't perform any further
    // checks. Assume in this case that the type is compatible with the
    // bound or constraint.
    if (isClass(effectiveSrcType) && ClassType.isPartiallyEvaluated(effectiveSrcType)) {
        return srcType;
    }

    // If there's a bound type, make sure the source is derived from it.
    if (destType.shared.boundType && !isTypeAliasPlaceholder(effectiveSrcType)) {
        if (
            !evaluator.assignType(
                destType.shared.boundType,
                effectiveSrcType,
                diag.createAddendum(),
                /* constraints */ undefined
            )
        ) {
            // Avoid adding a message that will confuse users if the TypeVar was
            // synthesized for internal purposes.
            if (!destType.shared.isSynthesized) {
                diag.addMessage(
                    LocAddendum.typeBound().format({
                        sourceType: evaluator.printType(effectiveSrcType),
                        destType: evaluator.printType(destType.shared.boundType),
                        name: TypeVarType.getReadableName(destType),
                    })
                );
            }
            return undefined;
        }
    }

    if (isParamSpec(destType)) {
        if (isParamSpec(srcType)) {
            return srcType;
        }

        if (isFunction(srcType) && FunctionType.isParamSpecValue(srcType)) {
            return srcType;
        }

        if (isClassInstance(srcType) && ClassType.isBuiltIn(srcType, 'Concatenate')) {
            return srcType;
        }

        diag.addMessage(
            LocAddendum.typeParamSpec().format({
                type: evaluator.printType(srcType),
                name: TypeVarType.getReadableName(destType),
            })
        );

        return undefined;
    }

    if (isParamSpec(srcType)) {
        diag.addMessage(LocMessage.paramSpecContext());
        return undefined;
    }

    // If there are no constraints, we're done.
    const constraints = destType.shared.constraints;
    if (constraints.length === 0) {
        return srcType;
    }

    if (isTypeAliasPlaceholder(srcType)) {
        return srcType;
    }

    if (isTypeVar(srcType) && TypeVarType.hasConstraints(srcType)) {
        // Make sure all the source constraint types map to constraint types in the dest.
        if (
            srcType.shared.constraints.every((sourceConstraint) => {
                return constraints.some((destConstraint) => evaluator.assignType(destConstraint, sourceConstraint));
            })
        ) {
            return srcType;
        }
    } else {
        let bestConstraintSoFar: Type | undefined;

        // Try to find the best (narrowest) match among the constraints.
        for (const constraint of constraints) {
            if (evaluator.assignType(constraint, effectiveSrcType)) {
                // Don't allow Never to match unless the constraint is also explicitly Never.
                if (!isNever(effectiveSrcType) || isNever(constraint)) {
                    if (!bestConstraintSoFar || evaluator.assignType(bestConstraintSoFar, constraint)) {
                        bestConstraintSoFar = constraint;
                    }
                }
            }
        }

        if (bestConstraintSoFar) {
            return bestConstraintSoFar;
        }
    }

    diag.addMessage(
        LocAddendum.typeConstrainedTypeVar().format({
            type: evaluator.printType(srcType),
            name: TypeVarType.getReadableName(destType),
        })
    );

    return undefined;
}

export function createSpecializedClassType(
    evaluator: TypeEvaluator,
    classType: ClassType,
    typeArgs: TypeResultWithNode[] | undefined,
    flags: EvalFlags,
    errorNode: ExpressionNode,
    registry: TypeRegistry
): TypeResult {
    let isValidTypeForm = true;

    // Handle the special-case classes that are not defined
    // in the type stubs.
    if (ClassType.isSpecialBuiltIn(classType)) {
        const aliasedName = classType.priv.aliasName || classType.shared.name;
        switch (aliasedName) {
            case 'Callable': {
                return {
                    type: createCallableType(evaluator, classType, typeArgs, errorNode),
                };
            }

            case 'Never':
            case 'NoReturn': {
                if (typeArgs && typeArgs.length > 0) {
                    evaluator.addDiagnostic(
                        DiagnosticRule.reportInvalidTypeForm,
                        LocMessage.typeArgsExpectingNone().format({ name: aliasedName }),
                        typeArgs[0].node
                    );
                }

                let resultType = aliasedName === 'Never' ? NeverType.createNever() : NeverType.createNoReturn();
                resultType = TypeBase.cloneAsSpecialForm(resultType, classType);
                if (isTypeFormSupported(errorNode)) {
                    resultType = TypeBase.cloneWithTypeForm(resultType, convertToInstance(resultType));
                }

                return { type: resultType };
            }

            case 'Optional': {
                return {
                    type: createOptionalType(evaluator, classType, errorNode, typeArgs, flags, registry),
                };
            }

            case 'Type': {
                let typeType = createSpecialType(
                    evaluator,
                    classType,
                    typeArgs,
                    1,
                    /* allowParamSpec */ undefined,
                    /* isSpecialForm */ false
                );

                if (isInstantiableClass(typeType)) {
                    typeType = explodeGenericClass(typeType);
                }

                if (isTypeFormSupported(errorNode)) {
                    typeType = TypeBase.cloneWithTypeForm(typeType, convertToInstance(typeType));
                }

                return { type: typeType };
            }

            case 'ClassVar': {
                return {
                    type: createClassVarType(evaluator, classType, errorNode, typeArgs, flags),
                };
            }

            case 'Protocol': {
                if ((flags & (EvalFlags.NoNonTypeSpecialForms | EvalFlags.TypeExpression)) !== 0) {
                    evaluator.addDiagnostic(
                        DiagnosticRule.reportInvalidTypeForm,
                        LocMessage.protocolNotAllowed(),
                        errorNode
                    );
                }

                typeArgs?.forEach((typeArg) => {
                    if (typeArg.typeList || !isTypeVar(typeArg.type)) {
                        evaluator.addDiagnostic(
                            DiagnosticRule.reportInvalidTypeForm,
                            LocMessage.protocolTypeArgMustBeTypeParam(),
                            typeArg.node
                        );
                    }
                });

                return {
                    type: createSpecialType(
                        evaluator,
                        classType,
                        typeArgs,
                        /* paramLimit */ undefined,
                        /* allowParamSpec */ true
                    ),
                };
            }

            case 'TypedDict': {
                if ((flags & (EvalFlags.NoNonTypeSpecialForms | EvalFlags.TypeExpression)) !== 0) {
                    const isInlinedTypedDict =
                        AnalyzerNodeInfo.getFileInfo(errorNode).diagnosticRuleSet.enableExperimentalFeatures &&
                        !!typeArgs;

                    if (!isInlinedTypedDict) {
                        evaluator.addDiagnostic(
                            DiagnosticRule.reportInvalidTypeForm,
                            LocMessage.typedDictNotAllowed(),
                            errorNode
                        );
                    }
                }
                isValidTypeForm = false;
                break;
            }

            case 'Literal': {
                if ((flags & (EvalFlags.NoNonTypeSpecialForms | EvalFlags.TypeExpression)) !== 0) {
                    evaluator.addDiagnostic(
                        DiagnosticRule.reportInvalidTypeForm,
                        LocMessage.literalNotAllowed(),
                        errorNode
                    );
                }
                isValidTypeForm = false;
                break;
            }

            case 'Tuple': {
                return {
                    type: createSpecialType(
                        evaluator,
                        classType,
                        typeArgs,
                        /* paramLimit */ undefined,
                        /* allowParamSpec */ false,
                        /* isSpecialForm */ false
                    ),
                };
            }

            case 'Union': {
                return {
                    type: createUnionType(evaluator, classType, errorNode, typeArgs, flags, registry),
                };
            }

            case 'Generic': {
                return {
                    type: createGenericType(evaluator, classType, errorNode, typeArgs, flags),
                };
            }

            case 'Final': {
                return {
                    type: createFinalType(evaluator, classType, errorNode, typeArgs, flags),
                };
            }

            case 'Annotated': {
                return createAnnotatedType(evaluator, classType, errorNode, typeArgs, flags);
            }

            case 'Concatenate': {
                return {
                    type: createConcatenateType(evaluator, classType, errorNode, typeArgs, flags),
                };
            }

            case 'TypeGuard':
            case 'TypeIs': {
                return {
                    type: createTypeGuardType(evaluator, classType, errorNode, typeArgs, flags),
                };
            }

            case 'Unpack': {
                return {
                    type: createUnpackType(evaluator, classType, errorNode, typeArgs, flags),
                };
            }

            case 'Required':
            case 'NotRequired': {
                return createRequiredOrReadOnlyType(evaluator, classType, errorNode, typeArgs, flags);
            }

            case 'ReadOnly': {
                return createRequiredOrReadOnlyType(evaluator, classType, errorNode, typeArgs, flags);
            }

            case 'Self': {
                return {
                    type: createSelfType(evaluator, classType, errorNode, typeArgs, flags),
                };
            }

            case 'LiteralString': {
                return {
                    type: createSpecialType(evaluator, classType, typeArgs, 0),
                };
            }

            case 'TypeForm': {
                return {
                    type: createTypeFormType(evaluator, classType, errorNode, typeArgs),
                };
            }
        }
    }

    const fileInfo = AnalyzerNodeInfo.getFileInfo(errorNode);
    if (
        fileInfo.isStubFile ||
        PythonVersion.isGreaterOrEqualTo(fileInfo.executionEnvironment.pythonVersion, pythonVersion3_9) ||
        isAnnotationEvaluationPostponed(AnalyzerNodeInfo.getFileInfo(errorNode)) ||
        (flags & EvalFlags.ForwardRefs) !== 0
    ) {
        // Handle "type" specially, since it needs to act like "Type"
        // in Python 3.9 and newer.
        if (ClassType.isBuiltIn(classType, 'type') && typeArgs) {
            if (typeArgs.length >= 1) {
                // Treat type[function] as illegal.
                if (isFunctionOrOverloaded(typeArgs[0].type)) {
                    evaluator.addDiagnostic(
                        DiagnosticRule.reportInvalidTypeForm,
                        LocMessage.typeAnnotationWithCallable(),
                        typeArgs[0].node
                    );

                    return { type: UnknownType.create() };
                }
            }

            if (registry.typeClass && isInstantiableClass(registry.typeClass)) {
                let typeType = createSpecialType(
                    evaluator,
                    registry.typeClass,
                    typeArgs,
                    1,
                    /* allowParamSpec */ undefined,
                    /* isSpecialForm */ false
                );

                if (isInstantiableClass(typeType)) {
                    typeType = explodeGenericClass(typeType);
                }

                if (isTypeFormSupported(errorNode)) {
                    typeType = TypeBase.cloneWithTypeForm(typeType, convertToInstance(typeType));
                }

                return { type: typeType };
            }
        }

        // Handle "tuple" specially, since it needs to act like "Tuple"
        // in Python 3.9 and newer.
        if (isTupleClass(classType)) {
            let specializedClass = createSpecialType(
                evaluator,
                classType,
                typeArgs,
                /* paramLimit */ undefined,
                /* allowParamSpec */ undefined,
                /* isSpecialForm */ false
            );

            if (isTypeFormSupported(errorNode)) {
                specializedClass = TypeBase.cloneWithTypeForm(specializedClass, convertToInstance(specializedClass));
            }

            return { type: specializedClass };
        }
    }

    let typeArgCount = typeArgs ? typeArgs.length : 0;

    // Make sure the argument list count is correct.
    const typeParams = ClassType.isPseudoGenericClass(classType) ? [] : ClassType.getTypeParams(classType);

    // If there are no type parameters or args, the class is already specialized.
    // No need to do any more work.
    if (typeParams.length === 0 && typeArgCount === 0) {
        return { type: classType };
    }

    const variadicTypeParamIndex = typeParams.findIndex((param) => isTypeVarTuple(param));

    if (typeArgs) {
        let minTypeArgCount = typeParams.length;
        const firstDefaultParamIndex = typeParams.findIndex((param) => !!param.shared.isDefaultExplicit);

        if (firstDefaultParamIndex >= 0) {
            minTypeArgCount = firstDefaultParamIndex;
        }

        // Classes that accept inlined type dict type args allow only one.
        if (typeArgs.length > 0 && typeArgs[0].inlinedTypeDict) {
            if (typeArgs.length > 1) {
                evaluator.addDiagnostic(
                    DiagnosticRule.reportInvalidTypeArguments,
                    LocMessage.typeArgsTooMany().format({
                        name: classType.priv.aliasName || classType.shared.name,
                        expected: 1,
                        received: typeArgCount,
                    }),
                    typeArgs[1].node
                );
            }

            return { type: typeArgs[0].inlinedTypeDict };
        } else if (typeArgCount > typeParams.length) {
            if (!ClassType.isPartiallyEvaluated(classType) && !ClassType.isTupleClass(classType)) {
                if (typeParams.length === 0) {
                    isValidTypeForm = false;
                    evaluator.addDiagnostic(
                        DiagnosticRule.reportInvalidTypeArguments,
                        LocMessage.typeArgsExpectingNone().format({
                            name: classType.priv.aliasName || classType.shared.name,
                        }),
                        typeArgs[typeParams.length].node
                    );
                } else if (typeParams.length !== 1 || !isParamSpec(typeParams[0])) {
                    isValidTypeForm = false;
                    evaluator.addDiagnostic(
                        DiagnosticRule.reportInvalidTypeArguments,
                        LocMessage.typeArgsTooMany().format({
                            name: classType.priv.aliasName || classType.shared.name,
                            expected: typeParams.length,
                            received: typeArgCount,
                        }),
                        typeArgs[typeParams.length].node
                    );
                }

                typeArgCount = typeParams.length;
            }
        } else if (typeArgCount < minTypeArgCount) {
            isValidTypeForm = false;
            evaluator.addDiagnostic(
                DiagnosticRule.reportInvalidTypeArguments,
                LocMessage.typeArgsTooFew().format({
                    name: classType.priv.aliasName || classType.shared.name,
                    expected: minTypeArgCount,
                    received: typeArgCount,
                }),
                typeArgs.length > 0 ? typeArgs[0].node.parent! : errorNode
            );
        }

        typeArgs.forEach((typeArg, index) => {
            if (!typeArg.type.props?.typeForm) {
                isValidTypeForm = false;
            }

            if (index === variadicTypeParamIndex) {
                // The types that make up the tuple that maps to the
                // TypeVarTuple have already been validated when the tuple
                // object was created in adjustTypeArgsForTypeVarTuple.
                if (isClassInstance(typeArg.type) && isTupleClass(typeArg.type)) {
                    return;
                }

                if (isTypeVarTuple(typeArg.type)) {
                    if (!validateTypeVarTupleIsUnpacked(evaluator, typeArg.type, typeArg.node)) {
                        isValidTypeForm = false;
                    }
                    return;
                }
            }

            const typeParam = index < typeParams.length ? typeParams[index] : undefined;
            const isParamSpecTarget = typeParam && isParamSpec(typeParam);

            if (
                !evaluator.validateTypeArg(typeArg, {
                    allowParamSpec: true,
                    allowTypeArgList: isParamSpecTarget,
                })
            ) {
                isValidTypeForm = false;
            }
        });
    }

    // Handle ParamSpec arguments and fill in any missing type arguments with Unknown.
    let typeArgTypes: Type[] = [];
    const fullTypeParams = ClassType.getTypeParams(classType);

    typeArgs = transformTypeArgsForParamSpec(evaluator, fullTypeParams, typeArgs, errorNode);
    if (!typeArgs) {
        isValidTypeForm = false;
    }

    const constraints = new ConstraintTracker();

    fullTypeParams.forEach((typeParam, index) => {
        if (typeArgs && index < typeArgs.length) {
            if (isParamSpec(typeParam)) {
                const typeArg = typeArgs[index];
                const functionType = FunctionType.createSynthesizedInstance('', FunctionTypeFlags.ParamSpecValue);

                if (isEllipsisType(typeArg.type)) {
                    FunctionType.addDefaultParams(functionType);
                    functionType.shared.flags |= FunctionTypeFlags.GradualCallableForm;
                    typeArgTypes.push(functionType);
                    constraints.setBounds(typeParam, functionType);
                    return;
                }

                if (typeArg.typeList) {
                    typeArg.typeList!.forEach((paramType, paramIndex) => {
                        FunctionType.addParam(
                            functionType,
                            FunctionParam.create(
                                ParamCategory.Simple,
                                convertToInstance(paramType.type),
                                FunctionParamFlags.NameSynthesized | FunctionParamFlags.TypeDeclared,
                                `__p${paramIndex}`
                            )
                        );
                    });

                    if (typeArg.typeList.length > 0) {
                        FunctionType.addPositionOnlyParamSeparator(functionType);
                    }

                    typeArgTypes.push(functionType);
                    constraints.setBounds(typeParam, functionType);
                    return;
                }

                if (isInstantiableClass(typeArg.type) && ClassType.isBuiltIn(typeArg.type, 'Concatenate')) {
                    const concatTypeArgs = typeArg.type.priv.typeArgs;
                    if (concatTypeArgs && concatTypeArgs.length > 0) {
                        concatTypeArgs.forEach((typeArg, index) => {
                            if (index === concatTypeArgs.length - 1) {
                                if (isParamSpec(typeArg)) {
                                    FunctionType.addParamSpecVariadics(functionType, typeArg);
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

                    typeArgTypes.push(functionType);
                    return;
                }
            }

            const typeArgType = convertToInstance(typeArgs[index].type);
            typeArgTypes.push(typeArgType);
            constraints.setBounds(typeParam, typeArgType);
            return;
        }

        const solvedDefaultType = evaluator.solveAndApplyConstraints(typeParam, constraints, {
            replaceUnsolved: {
                scopeIds: getTypeVarScopeIds(classType),
                tupleClassType: evaluator.getTupleClassType(),
            },
        });
        typeArgTypes.push(solvedDefaultType);
        constraints.setBounds(typeParam, solvedDefaultType);
    });

    typeArgTypes = typeArgTypes.map((typeArgType, index) => {
        if (index < typeArgCount) {
            const diag = new DiagnosticAddendum();
            let adjustedTypeArgType = applyTypeArgToTypeVar(evaluator, typeParams[index], typeArgType, diag);

            // Determine if the variance must match.
            if (adjustedTypeArgType && (flags & EvalFlags.EnforceVarianceConsistency) !== 0) {
                const destType = typeParams[index];
                const declaredVariance = destType.shared.declaredVariance;

                if (!isVarianceOfTypeArgCompatible(adjustedTypeArgType, declaredVariance)) {
                    diag.addMessage(
                        LocAddendum.varianceMismatchForClass().format({
                            typeVarName: evaluator.printType(adjustedTypeArgType),
                            className: classType.shared.name,
                        })
                    );
                    adjustedTypeArgType = undefined;
                }
            }

            if (adjustedTypeArgType) {
                typeArgType = adjustedTypeArgType;
            } else {
                // Avoid emitting this error for a partially-constructed class.
                if (!isClassInstance(typeArgType) || !ClassType.isPartiallyEvaluated(typeArgType)) {
                    assert(typeArgs !== undefined);
                    isValidTypeForm = false;
                    evaluator.addDiagnostic(
                        DiagnosticRule.reportInvalidTypeArguments,
                        LocMessage.typeVarAssignmentMismatch().format({
                            type: evaluator.printType(typeArgType),
                            name: TypeVarType.getReadableName(typeParams[index]),
                        }) + diag.getString(),
                        typeArgs[index].node
                    );
                }
            }
        }

        return typeArgType;
    });

    // If the class is partially constructed and doesn't yet have
    // type parameters, assume that the number and types of supplied type
    // arguments are correct.
    if (typeArgs && classType.shared.typeParams.length === 0 && ClassType.isPartiallyEvaluated(classType)) {
        typeArgTypes = typeArgs.map((t) => convertToInstance(t.type));
    }

    let specializedClass = ClassType.specialize(classType, typeArgTypes, typeArgs !== undefined);

    if (isTypeFormSupported(errorNode)) {
        specializedClass = TypeBase.cloneWithTypeForm(
            specializedClass,
            isValidTypeForm ? convertToInstance(specializedClass) : undefined
        );
    }

    return { type: specializedClass };
}

// PEP 612 says that if the class has only one type parameter consisting
// of a ParamSpec, the list of arguments does not need to be enclosed in
// a list. We'll handle that case specially here.
export function transformTypeArgsForParamSpec(
    evaluator: TypeEvaluator,
    typeParams: TypeVarType[],
    typeArgs: TypeResultWithNode[] | undefined,
    errorNode: ExpressionNode
): TypeResultWithNode[] | undefined {
    if (typeParams.length !== 1 || !isParamSpec(typeParams[0]) || !typeArgs) {
        return typeArgs;
    }

    if (typeArgs.length > 1) {
        for (const typeArg of typeArgs) {
            if (isParamSpec(typeArg.type)) {
                evaluator.addDiagnostic(
                    DiagnosticRule.reportInvalidTypeForm,
                    LocMessage.paramSpecContext(),
                    typeArg.node
                );
                return undefined;
            }

            if (isEllipsisType(typeArg.type)) {
                evaluator.addDiagnostic(
                    DiagnosticRule.reportInvalidTypeForm,
                    LocMessage.ellipsisContext(),
                    typeArg.node
                );
                return undefined;
            }

            if (isInstantiableClass(typeArg.type) && ClassType.isBuiltIn(typeArg.type, 'Concatenate')) {
                evaluator.addDiagnostic(
                    DiagnosticRule.reportInvalidTypeForm,
                    LocMessage.concatenateContext(),
                    typeArg.node
                );
                return undefined;
            }

            if (typeArg.typeList) {
                evaluator.addDiagnostic(
                    DiagnosticRule.reportInvalidTypeForm,
                    LocMessage.typeArgListNotAllowed(),
                    typeArg.node
                );
                return undefined;
            }
        }
    }

    if (typeArgs.length === 1) {
        // Don't transform a type list.
        if (typeArgs[0].typeList) {
            return typeArgs;
        }

        const typeArgType = typeArgs[0].type;

        // Don't transform a single ParamSpec or ellipsis.
        if (isParamSpec(typeArgType) || isEllipsisType(typeArgType)) {
            return typeArgs;
        }

        // Don't transform a Concatenate.
        if (isInstantiableClass(typeArgType) && ClassType.isBuiltIn(typeArgType, 'Concatenate')) {
            return typeArgs;
        }
    }

    // Package up the type arguments into a type list.
    return [
        {
            type: UnknownType.create(),
            node: typeArgs.length > 0 ? typeArgs[0].node : errorNode,
            typeList: typeArgs,
        },
    ];
}

export function createSpecializedTypeAlias(
    evaluator: TypeEvaluator,
    node: IndexNode,
    baseType: Type,
    flags: EvalFlags
): TypeResultWithNode | undefined {
    let aliasInfo = baseType.props?.typeAliasInfo;
    let aliasBaseType = baseType;

    if (!aliasInfo && baseType.props?.typeForm) {
        aliasInfo = baseType.props.typeForm?.props?.typeAliasInfo;
        aliasBaseType = convertToInstantiable(baseType.props.typeForm);
    }

    if (!aliasInfo?.shared.typeParams || (aliasInfo.shared.typeParams.length === 0 && aliasInfo.typeArgs)) {
        return undefined;
    }

    // If this is not instantiable, then the index expression isn't a specialization.
    if (!TypeBase.isInstantiable(aliasBaseType)) {
        return undefined;
    }

    // If this is already specialized, the index expression isn't a specialization.
    if (aliasInfo.typeArgs) {
        return undefined;
    }

    evaluator.inferVarianceForTypeAlias(baseType);

    const typeParams = aliasInfo.shared.typeParams;
    let typeArgs: TypeResultWithNode[] | undefined;
    typeArgs = evaluator.adjustTypeArgsForTypeVarTuple(evaluator.getTypeArgs(node, flags), typeParams, node);
    let reportedError = false;

    typeArgs = transformTypeArgsForParamSpec(evaluator, typeParams, typeArgs, node);
    if (!typeArgs) {
        typeArgs = [];
        reportedError = true;
    }

    let minTypeArgCount = typeParams.length;
    const firstDefaultParamIndex = typeParams.findIndex((param) => !!param.shared.isDefaultExplicit);
    if (firstDefaultParamIndex >= 0) {
        minTypeArgCount = firstDefaultParamIndex;
    }

    if (typeArgs.length > typeParams.length) {
        evaluator.addDiagnostic(
            DiagnosticRule.reportInvalidTypeForm,
            LocMessage.typeArgsTooMany().format({
                name: evaluator.printType(aliasBaseType),
                expected: typeParams.length,
                received: typeArgs.length,
            }),
            typeArgs[typeParams.length].node
        );
        reportedError = true;
    } else if (typeArgs.length < minTypeArgCount) {
        evaluator.addDiagnostic(
            DiagnosticRule.reportInvalidTypeForm,
            LocMessage.typeArgsTooFew().format({
                name: evaluator.printType(aliasBaseType),
                expected: typeParams.length,
                received: typeArgs.length,
            }),
            node.d.items[node.d.items.length - 1]
        );
        reportedError = true;
    }

    // Handle the mypy_extensions.FlexibleAlias type specially.
    if (
        isInstantiableClass(aliasBaseType) &&
        aliasBaseType.shared.fullName === 'mypy_extensions.FlexibleAlias' &&
        typeArgs.length >= 1
    ) {
        return { node, type: typeArgs[0].type };
    }

    const constraints = new ConstraintTracker();
    const diag = new DiagnosticAddendum();

    typeParams.forEach((param, index) => {
        if (isParamSpec(param) && index < typeArgs.length) {
            const typeArgType = typeArgs[index].type;
            const typeList = typeArgs[index].typeList;

            if (typeList) {
                const functionType = FunctionType.createSynthesizedInstance('', FunctionTypeFlags.ParamSpecValue);
                typeList.forEach((paramTypeResult, paramIndex) => {
                    let paramType = paramTypeResult.type;

                    if (!evaluator.validateTypeArg(paramTypeResult)) {
                        paramType = UnknownType.create();
                    }

                    FunctionType.addParam(
                        functionType,
                        FunctionParam.create(
                            ParamCategory.Simple,
                            convertToInstance(paramType),
                            FunctionParamFlags.NameSynthesized | FunctionParamFlags.TypeDeclared,
                            `__p${paramIndex}`
                        )
                    );
                });

                if (typeList.length > 0) {
                    FunctionType.addPositionOnlyParamSeparator(functionType);
                }

                assignTypeVar(
                    evaluator,
                    param,
                    functionType,
                    diag,
                    constraints,
                    AssignTypeFlags.RetainLiteralsForTypeVar
                );
            } else if (isParamSpec(typeArgType)) {
                assignTypeVar(
                    evaluator,
                    param,
                    convertToInstance(typeArgType),
                    diag,
                    constraints,
                    AssignTypeFlags.RetainLiteralsForTypeVar
                );
            } else if (isInstantiableClass(typeArgType) && ClassType.isBuiltIn(typeArgType, 'Concatenate')) {
                const concatTypeArgs = typeArgType.priv.typeArgs;
                const functionType = FunctionType.createInstance('', '', '', FunctionTypeFlags.None);

                if (concatTypeArgs && concatTypeArgs.length > 0) {
                    concatTypeArgs.forEach((typeArg, index) => {
                        if (index === concatTypeArgs.length - 1) {
                            FunctionType.addPositionOnlyParamSeparator(functionType);

                            if (isParamSpec(typeArg)) {
                                FunctionType.addParamSpecVariadics(functionType, typeArg);
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

                assignTypeVar(
                    evaluator,
                    param,
                    functionType,
                    diag,
                    constraints,
                    AssignTypeFlags.RetainLiteralsForTypeVar
                );
            } else if (isEllipsisType(typeArgType)) {
                const functionType = FunctionType.createSynthesizedInstance(
                    '',
                    FunctionTypeFlags.ParamSpecValue | FunctionTypeFlags.GradualCallableForm
                );
                FunctionType.addDefaultParams(functionType);
                assignTypeVar(evaluator, param, functionType, diag, constraints);
            } else {
                evaluator.addDiagnostic(
                    DiagnosticRule.reportInvalidTypeForm,
                    LocMessage.typeArgListExpected(),
                    typeArgs[index].node
                );
                reportedError = true;
            }
        } else {
            if (index < typeArgs.length && typeArgs[index].typeList) {
                evaluator.addDiagnostic(
                    DiagnosticRule.reportInvalidTypeForm,
                    LocMessage.typeArgListNotAllowed(),
                    typeArgs[index].node
                );
                reportedError = true;
            }

            let typeArgType: Type;
            if (index < typeArgs.length) {
                typeArgType = convertToInstance(typeArgs[index].type);
            } else if (param.shared.isDefaultExplicit) {
                typeArgType = evaluator.solveAndApplyConstraints(param, constraints, {
                    replaceUnsolved: {
                        scopeIds: [aliasInfo.shared.typeVarScopeId],
                        tupleClassType: evaluator.getTupleClassType(),
                    },
                });
            } else {
                typeArgType = UnknownType.create();
            }

            if ((flags & EvalFlags.EnforceVarianceConsistency) !== 0) {
                const usageVariances = evaluator.inferVarianceForTypeAlias(aliasBaseType);
                if (usageVariances && index < usageVariances.length) {
                    const usageVariance = usageVariances[index];

                    if (!isVarianceOfTypeArgCompatible(typeArgType, usageVariance)) {
                        const messageDiag = diag.createAddendum();
                        messageDiag.addMessage(
                            LocAddendum.varianceMismatchForTypeAlias().format({
                                typeVarName: evaluator.printType(typeArgType),
                                typeAliasParam: evaluator.printType(typeParams[index]),
                            })
                        );
                        messageDiag.addTextRange(typeArgs[index].node);
                    }
                }
            }

            if (isUnpacked(typeArgType) && !isTypeVarTuple(param)) {
                const messageDiag = diag.createAddendum();
                messageDiag.addMessage(LocMessage.unpackedArgInTypeArgument());
                messageDiag.addTextRange(typeArgs[index].node);
                typeArgType = UnknownType.create();
            }

            assignTypeVar(evaluator, param, typeArgType, diag, constraints, AssignTypeFlags.RetainLiteralsForTypeVar);
        }
    });

    if (!diag.isEmpty()) {
        evaluator.addDiagnostic(
            DiagnosticRule.reportInvalidTypeForm,
            LocMessage.typeNotSpecializable().format({ type: evaluator.printType(aliasBaseType) }) + diag.getString(),
            node,
            diag.getEffectiveTextRange() ?? node
        );
        reportedError = true;
    }

    const solutionSet = solveConstraints(evaluator, constraints).getMainSolutionSet();
    const aliasTypeArgs: Type[] = [];

    aliasInfo.shared.typeParams?.forEach((typeParam) => {
        let typeVarType = solutionSet.getType(typeParam);

        // Fill in any unsolved type arguments with unknown.
        if (!typeVarType) {
            typeVarType = getUnknownForTypeVar(typeParam, evaluator.getTupleClassType());
            constraints.setBounds(typeParam, typeVarType);
        }

        aliasTypeArgs.push(typeVarType);
    });

    let type = TypeBase.cloneForTypeAlias(evaluator.solveAndApplyConstraints(aliasBaseType, constraints), {
        ...aliasInfo,
        typeArgs: aliasTypeArgs,
    });

    if (isTypeFormSupported(node)) {
        type = TypeBase.cloneWithTypeForm(type, reportedError ? undefined : convertToInstance(type));
    }

    if (baseType.props?.typeAliasInfo) {
        return { type, node };
    }

    return { type: TypeBase.cloneWithTypeForm(baseType, convertToInstance(type)), node };
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
                    awaitableReturnType = ClassType.cloneAsInstance(ClassType.specialize(asyncGeneratorType, typeArgs));
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
        const awaitableType = useCoroutine
            ? evaluator.getTypesType(node, 'CoroutineType')
            : evaluator.getTypingType(node, 'Awaitable');
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
