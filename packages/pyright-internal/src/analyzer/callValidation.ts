/*
 * callValidation.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 *
 * Functions for call validation, overload resolution, and argument processing,
 * extracted from typeEvaluator.ts.
 */

import { ArgCategory, ArgumentNode, CallNode, ClassNode, ExpressionNode, ParamCategory, ParameterNode, ParseNode, ParseNodeType } from '../parser/parseNodes';
import {
    getParamListDetails,
    isParamSpecArgs,
    isParamSpecKwargs,
    ParamAssignmentTracker,
    ParamKind,
} from './parameterUtils';
import { applyFunctionTransform } from './functionTransform';
import { createNamedTupleType } from './namedTuples';
import { createTypedDictType, createTypedDictTypeInlined, getTypedDictMembersForClass } from './typedDicts';
import { createFunctionFromConstructor, getBoundInitMethod, validateConstructorArgs } from './constructors';
import { createEnumType, getEnumAutoValueType, isEnumClassWithMembers, isEnumMetaclass } from './enums';
import { getDeprecatedMessageFromCall } from './decorators';
import { createSentinelType } from './sentinel';
import { computeMroLinearization } from './typeUtils';
import { isAnnotationEvaluationPostponed } from './analyzerFileInfo';
import { ErrorExpressionCategory, IndexNode, ListNode } from '../parser/parseNodes';
import { KeywordType } from '../parser/tokenizerTypes';
import * as ParseTreeUtils from './parseTreeUtils';
import { assert } from '../common/debug';
import { DiagnosticRule } from '../common/diagnosticRules';
import { DiagnosticAddendum } from '../common/diagnostic';
import { LocAddendum, LocMessage } from '../localization/localize';
import * as AnalyzerNodeInfo from './analyzerNodeInfo';
import { ConstraintTracker } from './constraintTracker';
import * as specialForms from './specialForms';
import { TypeEvaluatorState } from './typeEvaluatorState';
import {
    Arg,
    ArgResult,
    ArgWithExpression,
    AssignTypeFlags,
    EvalFlags,
    CallResult,
    EffectiveReturnTypeOptions,
    EvaluatorUsage,
    PrintTypeOptions,
    GetTypeArgsOptions,
    ExpectedTypeOptions,
    TypeEvaluator,
    TypeResult,
    TypeResultWithNode,
    ValidateArgTypeParams,
    ValidateTypeArgsOptions,
} from './typeEvaluatorTypes';
import {
    FunctionParam,
    FunctionType,
    FunctionTypeFlags,
    isAny,
    isAnyOrUnknown,
    isClassInstance,
    isFunction,
    isModule,
    isParamSpec,
    isTypeVar,
    isTypeVarTuple,
    isUnknown,
    combineTypes,
    ClassType,
    isClass,
    isInstantiableClass,
    ClassTypeFlags,
    isNever,
    isOverloaded,
    isUnpacked,
    isUnpackedClass,
    isUnion,
    isUnpackedTypeVarTuple,
    isTypeSame,
    isFunctionOrOverloaded,
    OverloadedType,
    maxTypeRecursionCount,
    NeverType,
    TypeBase,
    TypeCategory,
    AnyType,
    ParamSpecType,
    removeUnbound,
    TupleTypeArg,
    Type,
    TypeCondition,
    TypeVarScopeId,
    TypeVarScopeType,
    TypeVarType,
    UnknownType,
    Variance,
} from './types';
import { ConstraintSolution } from './constraintSolution';
import { addConstraintsForExpectedType, applySourceSolutionToConstraints, solveConstraints, solveConstraintSet } from './constraintSolver';
import { ConstraintSet } from './constraintTracker';
import * as symbolResolution from './symbolResolution';
import { enumerateLiteralsForType } from './typeGuards';
import { expandTuple, makeTupleObject } from './tuples';
import { TypeRegistry } from './typeRegistry';
import {
    applySolvedTypeVars,
    areTypesSame,
    combineSameSizedTuples,
    convertToInstance,
    doForEachSubtype,
    getTypeVarArgsRecursive,
    InferenceContext,
    isEllipsisType,
    isOptionalType,
    isPartlyUnknown,
    getTypeCondition,
    getTypeVarScopeIds,
    isUnboundedTupleClass,
    isTupleClass,
    makePacked,
    makeTypeVarsBound,
    convertToInstantiable,
    isInstantiableMetaclass,
    ClassMember,
    isNoneInstance,
    lookUpClassMember,
    mapSubtypes,
    MemberAccessFlags,
    transformPossibleRecursiveTypeAlias,
    convertTypeToParamSpecValue,
    preserveUnknown,
    addConditionToType,
    containsAnyOrUnknown,
    containsLiteralType,
    isIncompleteUnknown,
    selfSpecializeClass,
    transformExpectedType,
    makeInferenceContext,
    requiresSpecialization,
} from './typeUtils';
import { appendArray } from '../common/collectionUtils';

// Redefined locally to avoid circular import from typeEvaluator.ts
export interface MatchArgsToParamsResult {
    overload: FunctionType;
    overloadIndex: number;

    argumentErrors: boolean;
    isTypeIncomplete: boolean;
    argParams: ValidateArgTypeParams[];
    activeParam?: FunctionParam | undefined;
    paramSpecTarget?: ParamSpecType | undefined;
    paramSpecArgList?: Arg[] | undefined;

    // Was there an unpacked argument of unknown length?
    unpackedArgOfUnknownLength?: boolean;

    // Did that unpacked argument map to a variadic parameter?
    unpackedArgMapsToVariadic?: boolean;

    // A score that indicates how well the overload matches with
    // supplied arguments. Used to pick the "best" for purposes
    // of error reporting when no matches are found. The higher
    // the score, the worse the match.
    argumentMatchScore: number;
}

export interface MatchedOverloadInfo {
    overload: FunctionType;
    matchResults: MatchArgsToParamsResult;
    constraints: ConstraintTracker;
    argResults: ArgResult[];
    returnType: Type;
}

export function convertNodeToArg(node: ArgumentNode): ArgWithExpression {
    return {
        argCategory: node.d.argCategory,
        name: node.d.name,
        valueExpression: node.d.valueExpr,
    };
}

// Given an error node, determines the appropriate speculative
// node of the error node that encompasses all of the arguments.
export function getSpeculativeNodeForCall(errorNode: ExpressionNode): ParseNode {
    // If the error node is within an arg, expand to include the parent of the arg list.
    const argParent = ParseTreeUtils.getParentNodeOfType(errorNode, ParseNodeType.Argument);
    if (argParent?.parent) {
        return argParent.parent;
    }

    // If the error node is the name in a class declaration, expand to include the class node.
    if (
        errorNode.nodeType === ParseNodeType.Name &&
        errorNode.parent?.nodeType === ParseNodeType.Class &&
        errorNode.parent.d.name === errorNode
    ) {
        return errorNode.parent;
    }

    return errorNode;
}

export function getIndexAccessMagicMethodName(usage: EvaluatorUsage): string {
    if (usage.method === 'get') {
        return '__getitem__';
    } else if (usage.method === 'set') {
        return '__setitem__';
    } else {
        assert(usage.method === 'del');
        return '__delitem__';
    }
}

export function filterOverloadMatchesForUnpackedArgs(matches: MatchedOverloadInfo[]): MatchedOverloadInfo[] {
    if (matches.length < 2) {
        return matches;
    }

    // Is there at least one overload that relies on unpacked args for a match?
    const unpackedArgsOverloads = matches.filter((match) => match.matchResults.unpackedArgMapsToVariadic);
    if (unpackedArgsOverloads.length === matches.length || unpackedArgsOverloads.length === 0) {
        return matches;
    }

    return unpackedArgsOverloads;
}

// Determines whether multiple incompatible overloads match
// due to an Any or Unknown argument type.
export function filterOverloadMatchesForAnyArgs(matches: MatchedOverloadInfo[]): MatchedOverloadInfo[] {
    if (matches.length < 2) {
        return matches;
    }

    // If all of the return types match, select the first one.
    if (
        areTypesSame(
            matches.map((match) => match.returnType),
            { treatAnySameAsUnknown: true }
        )
    ) {
        return [matches[0]];
    }

    const firstArgResults = matches[0].argResults;
    if (!firstArgResults) {
        return matches;
    }

    let foundAmbiguousAnyArg = false;
    for (let i = 0; i < firstArgResults.length; i++) {
        // If the arg is Any or Unknown, see if the corresponding
        // parameter types differ in any way.
        if (isAnyOrUnknown(firstArgResults[i].argType)) {
            const paramTypes = matches.map((match) =>
                i < match.matchResults.argParams.length
                    ? match.matchResults.argParams[i].paramType
                    : UnknownType.create()
            );
            if (!areTypesSame(paramTypes, { treatAnySameAsUnknown: true })) {
                foundAmbiguousAnyArg = true;
            }
        }
    }

    // If the first overload has a different number of effective arguments
    // than latter overloads, don't filter any of them. This typically means
    // that one of the arguments is an unpacked iterator, and it maps to
    // an indeterminate number of parameters, which means that the overload
    // selection is ambiguous.
    if (foundAmbiguousAnyArg || matches.some((match) => match.argResults.length !== firstArgResults.length)) {
        return matches;
    }

    return [matches[0]];
}

const maxSingleOverloadArgTypeExpansionCount = 64;

export function expandArgType(evaluator: TypeEvaluator, type: Type): Type[] | undefined {
    const expandedTypes: Type[] = [];

    // Expand any top-level type variables with constraints.
    type = evaluator.makeTopLevelTypeVarsConcrete(type);

    doForEachSubtype(type, (subtype) => {
        if (isClassInstance(subtype)) {
            // Expand any bool or Enum literals.
            const expandedLiteralTypes = enumerateLiteralsForType(evaluator, subtype);
            if (expandedLiteralTypes && expandedLiteralTypes.length <= maxSingleOverloadArgTypeExpansionCount) {
                appendArray(expandedTypes, expandedLiteralTypes);
                return;
            }

            // Expand any fixed-size tuples.
            const expandedTuples = expandTuple(subtype, maxSingleOverloadArgTypeExpansionCount);
            if (expandedTuples) {
                appendArray(expandedTypes, expandedTuples);
                return;
            }
        }

        expandedTypes.push(subtype);
    });

    return expandedTypes.length > 1 ? expandedTypes : undefined;
}

// Expands the specified argument type list to include expanded
// union types. Returns undefined when the expansion is complete and no
// more expansion is possible.
export function expandArgTypes(
    evaluator: TypeEvaluator,
    contextFreeArgTypes: Type[],
    expandedArgTypes: (Type | undefined)[][]
): (Type | undefined)[][] | undefined {
    // Find the rightmost already-expanded argument.
    let indexToExpand = contextFreeArgTypes.length - 1;
    while (indexToExpand >= 0 && !expandedArgTypes[0][indexToExpand]) {
        indexToExpand--;
    }

    // Move to the next candidate for expansion.
    indexToExpand++;

    if (indexToExpand >= contextFreeArgTypes.length) {
        return undefined;
    }

    let expandedTypes: Type[] | undefined;
    while (indexToExpand < contextFreeArgTypes.length) {
        // Is this a union type? If so, we can expand it.
        const argType = contextFreeArgTypes[indexToExpand];

        expandedTypes = expandArgType(evaluator, argType);
        if (expandedTypes) {
            break;
        }
        indexToExpand++;
    }

    // We have nothing left to expand.
    if (!expandedTypes) {
        return undefined;
    }

    // Expand entry indexToExpand.
    const newExpandedArgTypes: (Type | undefined)[][] = [];

    expandedArgTypes.forEach((preExpandedTypes) => {
        expandedTypes.forEach((subtype) => {
            const expandedTypes = [...preExpandedTypes];
            expandedTypes[indexToExpand] = subtype;
            newExpandedArgTypes.push(expandedTypes);
        });
    });

    return newExpandedArgTypes;
}

export function getTypeOfArg(
    evaluator: TypeEvaluator,
    arg: Arg,
    inferenceContext: InferenceContext | undefined
): TypeResult {
    if (arg.typeResult) {
        const type = arg.typeResult.type;
        return { type: type?.props?.specialForm ?? type, isIncomplete: arg.typeResult.isIncomplete };
    }

    if (!arg.valueExpression) {
        // We shouldn't ever get here, but just in case.
        return { type: UnknownType.create() };
    }

    // If there was no defined type provided, there should always
    // be a value expression from which we can retrieve the type.
    return evaluator.getTypeOfExpression(arg.valueExpression, /* flags */ undefined, inferenceContext);
}

// This function is like getTypeOfArg except that it is
// used in cases where the argument is expected to be a type
// and therefore follows the normal rules of types (e.g. they
// can be forward-declared in stubs, etc.).
export function getTypeOfArgExpectingType(
    evaluator: TypeEvaluator,
    arg: Arg,
    options?: ExpectedTypeOptions
): TypeResult {
    if (arg.typeResult) {
        return { type: arg.typeResult.type, isIncomplete: arg.typeResult.isIncomplete };
    }

    // If there was no defined type provided, there should always
    // be a value expression from which we can retrieve the type.
    assert(arg.valueExpression !== undefined);
    return evaluator.getTypeOfExpressionExpectingType(arg.valueExpression, options);
}

// If the return type from a function is a callable with type variables
// that are not scoped, rescope them to the caller.
export function adjustCallableReturnType(
    evaluator: TypeEvaluator,
    callNode: ExpressionNode,
    returnType: Type,
    liveTypeVarScopes: TypeVarScopeId[]
): Type {
    if (!isFunction(returnType)) {
        return returnType;
    }

    // What type variables are referenced in the callable return type? Do not include any live type variables.
    const typeParams = getTypeVarArgsRecursive(returnType).filter(
        (t) => !liveTypeVarScopes.some((scopeId) => t.priv.scopeId === scopeId)
    );

    // If there are no unsolved type variables, we're done. If there are
    // unsolved type variables, rescope them to the callable.
    if (typeParams.length === 0) {
        return returnType;
    }

    evaluator.inferReturnTypeIfNecessary(returnType);

    // Create a new scope ID based on the caller's position. This
    // will guarantee uniqueness. If another caller uses the same
    // call and arguments, the type vars will not conflict.
    const newScopeId = ParseTreeUtils.getScopeIdForNode(callNode);
    const solution = new ConstraintSolution();

    const newTypeParams = typeParams.map((typeVar) => {
        const newTypeParam = TypeVarType.cloneForScopeId(
            typeVar,
            newScopeId,
            typeVar.priv.scopeName,
            TypeVarScopeType.Function
        );
        solution.setType(typeVar, newTypeParam);
        return newTypeParam;
    });

    return applySolvedTypeVars(
        FunctionType.cloneWithNewTypeVarScopeId(
            returnType,
            newScopeId,
            /* constructorTypeVarScopeId */ undefined,
            newTypeParams
        ),
        solution
    );
}

// Adjusts the type arguments of a generic type alias to account for a
// TypeVarTuple in the type parameter list.
export function adjustTypeArgsForTypeVarTuple(
    evaluator: TypeEvaluator,
    typeArgs: TypeResultWithNode[],
    typeParams: TypeVarType[],
    errorNode: ExpressionNode
): TypeResultWithNode[] {
    const variadicIndex = typeParams.findIndex((param) => isTypeVarTuple(param));

    // Is there a *tuple[T, ...] somewhere in the type arguments that we can expand if needed?
    let srcUnboundedTupleType: Type | undefined;
    const findUnboundedTupleIndex = (startArgIndex: number) => {
        return typeArgs.findIndex((arg, index) => {
            if (index < startArgIndex) {
                return false;
            }
            if (
                isUnpackedClass(arg.type) &&
                arg.type.priv.tupleTypeArgs &&
                arg.type.priv.tupleTypeArgs.length === 1 &&
                arg.type.priv.tupleTypeArgs[0].isUnbounded
            ) {
                srcUnboundedTupleType = arg.type.priv.tupleTypeArgs[0].type;
                return true;
            }

            return false;
        });
    };
    let srcUnboundedTupleIndex = findUnboundedTupleIndex(0);

    // Allow only one unpacked tuple that maps to a TypeVarTuple.
    if (srcUnboundedTupleIndex >= 0) {
        const secondUnboundedTupleIndex = findUnboundedTupleIndex(srcUnboundedTupleIndex + 1);
        if (secondUnboundedTupleIndex >= 0) {
            evaluator.addDiagnostic(
                DiagnosticRule.reportInvalidTypeForm,
                LocMessage.variadicTypeArgsTooMany(),
                typeArgs[secondUnboundedTupleIndex].node
            );
        }
    }

    if (
        srcUnboundedTupleType &&
        srcUnboundedTupleIndex >= 0 &&
        variadicIndex >= 0 &&
        typeArgs.length < typeParams.length
    ) {
        // "Smear" the tuple type across type argument slots prior to the TypeVarTuple.
        while (variadicIndex > srcUnboundedTupleIndex) {
            typeArgs = [
                ...typeArgs.slice(0, srcUnboundedTupleIndex),
                { node: typeArgs[srcUnboundedTupleIndex].node, type: srcUnboundedTupleType },
                ...typeArgs.slice(srcUnboundedTupleIndex),
            ];
            srcUnboundedTupleIndex++;
        }

        // "Smear" the tuple type across type argument slots following the TypeVarTuple.
        while (typeArgs.length < typeParams.length) {
            typeArgs = [
                ...typeArgs.slice(0, srcUnboundedTupleIndex + 1),
                { node: typeArgs[srcUnboundedTupleIndex].node, type: srcUnboundedTupleType },
                ...typeArgs.slice(srcUnboundedTupleIndex + 1),
            ];
        }
    }

    // Do we need to adjust the type arguments to map to a variadic type
    // param somewhere in the list?
    if (variadicIndex >= 0) {
        const variadicTypeVar = typeParams[variadicIndex];

        // If the type param list ends with a ParamSpec with a default value,
        // we can ignore it for purposes of finding type args that map to the
        // TypeVarTuple.
        let typeParamCount = typeParams.length;
        while (typeParamCount > 0) {
            const lastTypeParam = typeParams[typeParamCount - 1];
            if (!isParamSpec(lastTypeParam) || !lastTypeParam.shared.isDefaultExplicit) {
                break;
            }

            typeParamCount--;
        }

        if (variadicIndex < typeArgs.length) {
            // If there are typeArg lists at the end, these should map to ParamSpecs rather
            // than the TypeVarTuple, so exclude them.
            let variadicEndIndex = variadicIndex + 1 + typeArgs.length - typeParamCount;
            while (variadicEndIndex > variadicIndex) {
                if (!typeArgs[variadicEndIndex - 1].typeList) {
                    break;
                }
                variadicEndIndex--;
            }
            const variadicTypeResults = typeArgs.slice(variadicIndex, variadicEndIndex);

            // If the type args consist of a lone TypeVarTuple, don't wrap it in a tuple.
            if (variadicTypeResults.length === 1 && isTypeVarTuple(variadicTypeResults[0].type)) {
                specialForms.validateTypeVarTupleIsUnpacked(
                    evaluator,
                    variadicTypeResults[0].type,
                    variadicTypeResults[0].node
                );
            } else {
                variadicTypeResults.forEach((arg, index) => {
                    evaluator.validateTypeArg(arg, {
                        allowEmptyTuple: index === 0,
                        allowTypeVarTuple: true,
                        allowUnpackedTuples: true,
                    });
                });

                const variadicTypes: TupleTypeArg[] = [];
                if (variadicTypeResults.length !== 1 || !variadicTypeResults[0].isEmptyTupleShorthand) {
                    variadicTypeResults.forEach((typeResult) => {
                        if (isUnpackedClass(typeResult.type) && typeResult.type.priv.tupleTypeArgs) {
                            appendArray(variadicTypes, typeResult.type.priv.tupleTypeArgs);
                        } else {
                            variadicTypes.push({
                                type: convertToInstance(typeResult.type),
                                isUnbounded: false,
                            });
                        }
                    });
                }

                const tupleObject = makeTupleObject(evaluator, variadicTypes, /* isUnpacked */ true);

                typeArgs = [
                    ...typeArgs.slice(0, variadicIndex),
                    { node: typeArgs[variadicIndex].node, type: tupleObject },
                    ...typeArgs.slice(variadicEndIndex, typeArgs.length),
                ];
            }
        } else if (!variadicTypeVar.shared.isDefaultExplicit) {
            // Add an empty tuple that maps to the TypeVarTuple type parameter.
            typeArgs.push({
                node: errorNode,
                type: makeTupleObject(evaluator, [], /* isUnpacked */ true),
            });
        }
    }

    return typeArgs;
}

// Verifies that a type argument's type is not disallowed.
export function validateTypeArg(
    evaluator: TypeEvaluator,
    argResult: TypeResultWithNode,
    options?: ValidateTypeArgsOptions
): boolean {
    if (argResult.typeList) {
        if (!options?.allowTypeArgList) {
            evaluator.addDiagnostic(
                DiagnosticRule.reportInvalidTypeForm,
                LocMessage.typeArgListNotAllowed(),
                argResult.node
            );
            return false;
        } else {
            argResult.typeList.forEach((typeArg) => {
                validateTypeArg(evaluator, typeArg);
            });
        }
    }

    if (isEllipsisType(argResult.type)) {
        if (!options?.allowTypeArgList) {
            evaluator.addDiagnostic(
                DiagnosticRule.reportInvalidTypeForm,
                LocMessage.ellipsisContext(),
                argResult.node
            );
            return false;
        }
    }

    if (isModule(argResult.type)) {
        evaluator.addDiagnostic(DiagnosticRule.reportInvalidTypeForm, LocMessage.moduleAsType(), argResult.node);
        return false;
    }

    if (isParamSpec(argResult.type)) {
        if (!options?.allowParamSpec) {
            evaluator.addDiagnostic(
                DiagnosticRule.reportInvalidTypeForm,
                LocMessage.paramSpecContext(),
                argResult.node
            );
            return false;
        }
    }

    if (isTypeVarTuple(argResult.type) && !argResult.type.priv.isInUnion) {
        if (!options?.allowTypeVarTuple) {
            evaluator.addDiagnostic(
                DiagnosticRule.reportInvalidTypeForm,
                LocMessage.typeVarTupleContext(),
                argResult.node
            );
            return false;
        } else {
            specialForms.validateTypeVarTupleIsUnpacked(evaluator, argResult.type, argResult.node);
        }
    }

    if (!options?.allowEmptyTuple && argResult.isEmptyTupleShorthand) {
        evaluator.addDiagnostic(
            DiagnosticRule.reportInvalidTypeForm,
            LocMessage.zeroLengthTupleNotAllowed(),
            argResult.node
        );
        return false;
    }

    if (isUnpackedClass(argResult.type)) {
        if (!options?.allowUnpackedTuples) {
            evaluator.addDiagnostic(
                DiagnosticRule.reportInvalidTypeForm,
                LocMessage.unpackedArgInTypeArgument(),
                argResult.node
            );
            return false;
        }
    }

    return true;
}

// Expands any unpacked tuples within an argument list.
export function expandArgList(evaluator: TypeEvaluator, registry: TypeRegistry, argList: Arg[]): Arg[] {
    const expandedArgList: Arg[] = [];

    for (const arg of argList) {
        if (arg.argCategory === ArgCategory.UnpackedList) {
            const argType = getTypeOfArg(evaluator, arg, /* inferenceContext */ undefined).type;

            // If this is a tuple with specified element types, use those
            // specified types rather than using the more generic iterator
            // type which will be a union of all element types.
            const combinedArgType = combineSameSizedTuples(
                evaluator.makeTopLevelTypeVarsConcrete(argType),
                registry.tupleClass
            );

            if (isClassInstance(combinedArgType) && isTupleClass(combinedArgType)) {
                const tupleTypeArgs = combinedArgType.priv.tupleTypeArgs ?? [];

                if (tupleTypeArgs.length !== 1 || !tupleTypeArgs[0].isUnbounded) {
                    for (const tupleTypeArg of tupleTypeArgs) {
                        if (tupleTypeArg.isUnbounded) {
                            expandedArgList.push({
                                ...arg,
                                argCategory: ArgCategory.UnpackedList,
                                valueExpression: undefined,
                                typeResult: {
                                    type: makeTupleObject(evaluator, [tupleTypeArg]),
                                },
                            });
                        } else {
                            expandedArgList.push({
                                ...arg,
                                argCategory: ArgCategory.Simple,
                                valueExpression: undefined,
                                typeResult: {
                                    type: tupleTypeArg.type,
                                },
                            });
                        }
                    }
                    continue;
                }
            }
        }

        expandedArgList.push(arg);
    }

    return expandedArgList;
}

// Redefined locally to avoid circular import from typeEvaluator.ts
export interface ValidateArgTypeOptions {
    skipUnknownArgCheck?: boolean;
    isArgFirstPass?: boolean;
    conditionFilter?: TypeCondition[];
    skipReportError?: boolean;
}

export function validateArgType(
    evaluator: TypeEvaluator,
    state: TypeEvaluatorState,
    argParam: ValidateArgTypeParams,
    constraints: ConstraintTracker,
    typeResult: TypeResult<FunctionType> | undefined,
    options: ValidateArgTypeOptions
): ArgResult {
    let argType: Type | undefined;
    let expectedTypeDiag: DiagnosticAddendum | undefined;
    let isTypeIncomplete = !!typeResult?.isIncomplete;
    let isCompatible = true;
    const functionName = typeResult?.type.shared.name;
    let skippedBareTypeVarExpectedType = false;

    if (argParam.argument.valueExpression) {
        let expectedType: Type | undefined;

        let isExpectedTypeBareTypeVar = true;
        doForEachSubtype(argParam.paramType, (subtype) => {
            if (!isTypeVar(subtype) || subtype.priv.scopeId !== typeResult?.type.shared.typeVarScopeId) {
                isExpectedTypeBareTypeVar = false;
            }
        });

        if (!options.isArgFirstPass || !isExpectedTypeBareTypeVar) {
            expectedType = argParam.paramType;

            const skipApplySolvedTypeVars =
                isFunction(argParam.paramType) &&
                FunctionType.getParamSpecFromArgsKwargs(argParam.paramType) &&
                constraints.getConstraintSets().length > 1;

            if (!skipApplySolvedTypeVars) {
                expectedType = evaluator.solveAndApplyConstraints(expectedType, constraints, /* applyOptions */ undefined, {
                    useLowerBoundOnly: !!options.isArgFirstPass,
                });
            }
        } else {
            skippedBareTypeVarExpectedType = true;
        }

        if (expectedType && isUnknown(expectedType)) {
            expectedType = undefined;
        }

        if (argParam.argType) {
            argType = argParam.argType;
        } else {
            const flags = argParam.isinstanceParam
                ? EvalFlags.IsInstanceArgDefaults
                : EvalFlags.NoFinal | EvalFlags.NoSpecialize;
            const exprTypeResult = evaluator.getTypeOfExpression(
                argParam.argument.valueExpression,
                flags,
                makeInferenceContext(expectedType, !!typeResult?.isIncomplete)
            );

            argType = exprTypeResult.type;

            if (argParam.argument.argCategory === ArgCategory.UnpackedList && argParam.argument.enforceIterable) {
                const iteratorType = evaluator.getTypeOfIterator(
                    exprTypeResult,
                    /* isAsync */ false,
                    argParam.argument.valueExpression
                );
                argType = iteratorType?.type ?? UnknownType.create();
            }

            if (exprTypeResult.isIncomplete) {
                isTypeIncomplete = true;
            }

            if (expectedType && requiresSpecialization(expectedType)) {
                const clonedConstraints = constraints.clone();
                if (
                    evaluator.assignType(
                        expectedType,
                        argType,
                        /* diag */ undefined,
                        clonedConstraints,
                        options?.isArgFirstPass ? AssignTypeFlags.ArgAssignmentFirstPass : AssignTypeFlags.Default
                    )
                ) {
                    constraints.copyFromClone(clonedConstraints);
                } else {
                    isCompatible = false;
                }
            }

            expectedTypeDiag = exprTypeResult.expectedTypeDiagAddendum;
        }

        if (argParam.argument && argParam.argument.name && !state.isSpeculativeModeInUse(argParam.errorNode)) {
            state.writeTypeCache(
                argParam.argument.name,
                { type: expectedType ?? argType, isIncomplete: isTypeIncomplete },
                EvalFlags.None
            );
        }
    } else {
        if (argParam.argType) {
            argType = argParam.argType;
        } else {
            const argTypeResult = getTypeOfArg(
                evaluator,
                argParam.argument,
                makeInferenceContext(argParam.paramType, isTypeIncomplete)
            );
            argType = argTypeResult.type;
            if (argTypeResult.isIncomplete) {
                isTypeIncomplete = true;
            }
        }

        if (argParam.isDefaultArg) {
            argType = evaluator.solveAndApplyConstraints(argType, constraints);
        }
    }

    if (argParam.paramCategory === ParamCategory.KwargsDict && isTypeVar(argParam.paramType)) {
        argType = evaluator.stripLiteralValue(argType);
    }

    if (options.conditionFilter) {
        argType = evaluator.mapSubtypesExpandTypeVars(
            argType,
            { conditionFilter: options.conditionFilter },
            (expandedSubtype) => {
                return expandedSubtype;
            }
        );
    }

    const condition = argType.props?.condition;

    let diag = options?.skipReportError ? undefined : new DiagnosticAddendum();

    if (isParamSpec(argParam.paramType)) {
        if (argParam.paramType.priv.paramSpecAccess !== undefined) {
            return { isCompatible, argType, isTypeIncomplete, condition };
        }

        if (isParamSpec(argType) && argType.priv.paramSpecAccess !== undefined) {
            return { isCompatible, argType, isTypeIncomplete, condition };
        }
    }

    let assignTypeFlags = AssignTypeFlags.Default;

    if (argParam.isinstanceParam) {
        assignTypeFlags |= AssignTypeFlags.AllowIsinstanceSpecialForms;
    }

    if (options?.isArgFirstPass) {
        assignTypeFlags |= AssignTypeFlags.ArgAssignmentFirstPass;
    }

    if (!evaluator.assignType(argParam.paramType, argType, diag?.createAddendum(), constraints, assignTypeFlags)) {
        if (!options?.skipReportError) {
            const fileInfo = AnalyzerNodeInfo.getFileInfo(argParam.errorNode);
            if (
                fileInfo.diagnosticRuleSet.reportArgumentType !== 'none' &&
                !state.canSkipDiagnosticForNode(argParam.errorNode) &&
                !isTypeIncomplete
            ) {
                const argTypeText = evaluator.printType(argType);
                const paramTypeText = evaluator.printType(argParam.paramType);

                let message: string;
                if (argParam.paramName && !argParam.isParamNameSynthesized) {
                    if (functionName) {
                        message = LocMessage.argAssignmentParamFunction().format({
                            argType: argTypeText,
                            paramType: paramTypeText,
                            functionName,
                            paramName: argParam.paramName,
                        });
                    } else {
                        message = LocMessage.argAssignmentParam().format({
                            argType: argTypeText,
                            paramType: paramTypeText,
                            paramName: argParam.paramName,
                        });
                    }
                } else {
                    if (functionName) {
                        message = LocMessage.argAssignmentFunction().format({
                            argType: argTypeText,
                            paramType: paramTypeText,
                            functionName,
                        });
                    } else {
                        message = LocMessage.argAssignment().format({
                            argType: argTypeText,
                            paramType: paramTypeText,
                        });
                    }
                }

                if (expectedTypeDiag) {
                    diag = expectedTypeDiag;
                }

                evaluator.addDiagnostic(
                    DiagnosticRule.reportArgumentType,
                    message + diag?.getString(),
                    argParam.errorNode,
                    diag?.getEffectiveTextRange() ?? argParam.errorNode
                );
            }
        }

        return { isCompatible: false, argType, isTypeIncomplete, skippedBareTypeVarExpectedType, condition };
    }

    if (!options.skipUnknownArgCheck) {
        const simplifiedType = evaluator.makeTopLevelTypeVarsConcrete(removeUnbound(argType));
        const fileInfo = AnalyzerNodeInfo.getFileInfo(argParam.errorNode);

        function getDiagAddendum() {
            const diagAddendum = new DiagnosticAddendum();
            if (argParam.paramName) {
                diagAddendum.addMessage(
                    (functionName
                        ? LocAddendum.argParamFunction().format({
                              paramName: argParam.paramName,
                              functionName,
                          })
                        : LocAddendum.argParam().format({ paramName: argParam.paramName })) +
                        diagAddendum.getString()
                );
            }
            return diagAddendum;
        }

        if (
            fileInfo.diagnosticRuleSet.reportUnknownArgumentType !== 'none' &&
            !isAny(argParam.paramType) &&
            !isTypeIncomplete
        ) {
            if (isUnknown(simplifiedType)) {
                const diagAddendum = getDiagAddendum();
                evaluator.addDiagnostic(
                    DiagnosticRule.reportUnknownArgumentType,
                    LocMessage.argTypeUnknown() + diagAddendum.getString(),
                    argParam.errorNode
                );
            } else if (isPartlyUnknown(simplifiedType)) {
                if (!isPartlyUnknown(argParam.paramType)) {
                    const diagAddendum = getDiagAddendum();
                    diagAddendum.addMessage(
                        LocAddendum.argumentType().format({
                            type: evaluator.printType(simplifiedType, { expandTypeAlias: true }),
                        })
                    );
                    evaluator.addDiagnostic(
                        DiagnosticRule.reportUnknownArgumentType,
                        LocMessage.argTypePartiallyUnknown() + diagAddendum.getString(),
                        argParam.errorNode
                    );
                }
            }
        }
    }

    return { isCompatible, argType, isTypeIncomplete, skippedBareTypeVarExpectedType, condition };
}

export function adjustParamAnnotatedType(evaluator: TypeEvaluator, param: ParameterNode, type: Type): Type {
    if (
        param.d.defaultValue?.nodeType === ParseNodeType.Constant &&
        param.d.defaultValue.d.constType === KeywordType.None &&
        !isOptionalType(type) &&
        !AnalyzerNodeInfo.getFileInfo(param).diagnosticRuleSet.strictParameterNoneValue
    ) {
        return combineTypes([type, evaluator.getNoneType()]);
    }

    return type;
}

export function applyConditionFilterToType(
    evaluator: TypeEvaluator,
    type: Type,
    conditionFilter: TypeCondition[],
    recursionCount: number
): Type | undefined {
    if (recursionCount > maxTypeRecursionCount) {
        return type;
    }
    recursionCount++;

    if (!TypeCondition.isCompatible(getTypeCondition(type), conditionFilter)) {
        return undefined;
    }

    if (isClass(type) && type.priv.typeArgs && !type.priv.tupleTypeArgs) {
        evaluator.inferVarianceForClass(type);

        let typeWasTransformed = false;

        const filteredTypeArgs = type.priv.typeArgs.map((typeArg, index) => {
            if (index >= type.shared.typeParams.length) {
                return typeArg;
            }

            const variance = TypeVarType.getVariance(type.shared.typeParams[index]);
            if (variance !== Variance.Covariant) {
                return typeArg;
            }

            if (isTypeVar(typeArg) && typeArg.shared.recursiveAlias) {
                return typeArg;
            }

            const filteredTypeArg = evaluator.mapSubtypesExpandTypeVars(
                typeArg,
                { conditionFilter },
                (expandedSubtype) => {
                    return expandedSubtype;
                }
            );

            if (filteredTypeArg !== typeArg) {
                typeWasTransformed = true;
            }

            return filteredTypeArg;
        });

        if (typeWasTransformed) {
            return ClassType.specialize(type, filteredTypeArgs);
        }
    }

    return type;
}

// Matches the arguments passed to a function to the corresponding parameters in that
// function. This matching is done based on positions and keywords.
// This logic is based on PEP 3102: https://www.python.org/dev/peps/pep-3102/
export function matchArgsToParams(
    evaluator: TypeEvaluator,
    state: TypeEvaluatorState,
    registry: TypeRegistry,
    errorNode: ExpressionNode,
    argList: Arg[],
    typeResult: TypeResult<FunctionType>,
    overloadIndex: number
): MatchArgsToParamsResult {
    const overload = typeResult.type;
    const paramDetails = getParamListDetails(overload, { disallowExtraKwargsForTd: true });
    const paramSpec = FunctionType.getParamSpecFromArgsKwargs(overload);

    let argIndex = 0;
    let unpackedArgOfUnknownLength = false;
    let unpackedArgMapsToVariadic = false;
    let reportedArgError = false;
    let isTypeIncomplete = !!typeResult.isIncomplete;
    let isTypeVarTupleFullyMatched = false;

    // Expand any unpacked tuples in the arg list.
    argList = expandArgList(evaluator, registry, argList);

    const paramTracker = new ParamAssignmentTracker(paramDetails.params);

    let positionalOnlyLimitIndex = paramDetails.positionOnlyParamCount;
    let positionParamLimitIndex = paramDetails.firstKeywordOnlyIndex ?? paramDetails.params.length;

    const varArgListParamIndex = paramDetails.argsIndex;
    const varArgDictParamIndex = paramDetails.kwargsIndex;

    let paramSpecArgList: Arg[] | undefined;
    let paramSpecTarget: ParamSpecType | undefined;
    let hasParamSpecArgsKwargs = false;

    let positionalArgCount = argList.findIndex(
        (arg) => arg.argCategory === ArgCategory.UnpackedDictionary || arg.name !== undefined
    );
    if (positionalArgCount < 0) {
        positionalArgCount = argList.length;
    }

    if (varArgListParamIndex !== undefined && varArgDictParamIndex !== undefined) {
        assert(paramDetails.params[varArgListParamIndex], 'varArgListParamIndex params entry is undefined');
        const varArgListParamType = paramDetails.params[varArgListParamIndex].type;
        assert(paramDetails.params[varArgDictParamIndex], 'varArgDictParamIndex params entry is undefined');
        const varArgDictParamType = paramDetails.params[varArgDictParamIndex].type;

        if (
            isParamSpec(varArgListParamType) &&
            varArgListParamType.priv.paramSpecAccess === 'args' &&
            isParamSpec(varArgDictParamType) &&
            varArgDictParamType.priv.paramSpecAccess === 'kwargs' &&
            varArgListParamType.shared.name === varArgDictParamType.shared.name
        ) {
            hasParamSpecArgsKwargs = true;

            const paramSpecScopeId = varArgListParamType.priv.scopeId;

            if (getTypeVarScopeIds(overload).some((id) => id === paramSpecScopeId)) {
                paramSpecArgList = [];
                paramSpecTarget = TypeVarType.cloneForParamSpecAccess(varArgListParamType, /* access */ undefined);
            } else {
                positionalOnlyLimitIndex = varArgListParamIndex;
                positionalArgCount = Math.min(varArgListParamIndex, positionalArgCount);
                positionParamLimitIndex = varArgListParamIndex;
            }
        }
    } else if (paramSpec) {
        if (getTypeVarScopeIds(overload).some((id) => id === paramSpec.priv.scopeId)) {
            hasParamSpecArgsKwargs = true;
            paramSpecArgList = [];
            paramSpecTarget = paramSpec;
        }
    }

    if (argList.some((arg) => arg.argCategory === ArgCategory.UnpackedList)) {
        argList.forEach((arg) => {
            if (arg.name) {
                const keywordParamIndex = paramDetails.params.findIndex((paramInfo) => {
                    assert(paramInfo, 'paramInfo entry is undefined for kwargs check');
                    return (
                        paramInfo.param.name === arg.name!.d.value &&
                        paramInfo.param.category === ParamCategory.Simple
                    );
                });

                if (keywordParamIndex >= 0 && keywordParamIndex >= positionalOnlyLimitIndex) {
                    if (positionParamLimitIndex < 0 || keywordParamIndex < positionParamLimitIndex) {
                        positionParamLimitIndex = keywordParamIndex;
                    }
                }
            }
        });
    }

    if (positionParamLimitIndex < 0) {
        positionParamLimitIndex = paramDetails.params.length;
    }

    let validateArgTypeParams: ValidateArgTypeParams[] = [];

    let activeParam: FunctionParam | undefined;
    function trySetActive(arg: Arg, param: FunctionParam) {
        if (arg.active) {
            activeParam = param;
        }
    }

    const foundUnpackedListArg = argList.find((arg) => arg.argCategory === ArgCategory.UnpackedList) !== undefined;

    let paramIndex = 0;

    while (argIndex < positionalArgCount) {
        if (argIndex < positionalOnlyLimitIndex && argList[argIndex].name) {
            const nameNode = argList[argIndex].name;
            if (nameNode) {
                evaluator.addDiagnostic(DiagnosticRule.reportCallIssue, LocMessage.argPositional(), nameNode);
                reportedArgError = true;
            }
        }

        const remainingArgCount = positionalArgCount - argIndex;
        const remainingParamCount = positionParamLimitIndex - paramIndex - 1;

        if (paramIndex >= positionParamLimitIndex) {
            if (paramSpecArgList) {
                while (argIndex < positionalArgCount) {
                    paramSpecArgList.push(argList[argIndex]);
                    argIndex++;
                }
            } else {
                let tooManyPositionals = false;

                if (argList[argIndex].argCategory === ArgCategory.UnpackedList) {
                    const argType = getTypeOfArg(evaluator, argList[argIndex], /* inferenceContext */ undefined).type;

                    if (
                        isClassInstance(argType) &&
                        isTupleClass(argType) &&
                        !isUnboundedTupleClass(argType) &&
                        argType.priv.tupleTypeArgs !== undefined &&
                        argType.priv.tupleTypeArgs.length > 0
                    ) {
                        tooManyPositionals = true;
                    } else {
                        unpackedArgOfUnknownLength = true;
                    }
                } else {
                    tooManyPositionals = true;
                }

                if (tooManyPositionals) {
                    if (!state.canSkipDiagnosticForNode(errorNode) && !isTypeIncomplete) {
                        evaluator.addDiagnostic(
                            DiagnosticRule.reportCallIssue,
                            positionParamLimitIndex === 1
                                ? LocMessage.argPositionalExpectedOne()
                                : LocMessage.argPositionalExpectedCount().format({
                                      expected: positionParamLimitIndex,
                                  }),
                            argList[argIndex].valueExpression ?? errorNode
                        );
                    }
                    reportedArgError = true;
                }
            }
            break;
        }

        if (paramIndex >= paramDetails.params.length) {
            break;
        }

        assert(paramDetails.params[paramIndex], 'paramIndex params entry is undefined');
        const paramInfo = paramDetails.params[paramIndex];
        const paramType = paramInfo.type;
        const paramName = paramInfo.param.name;

        const isParamVariadic = paramInfo.param.category === ParamCategory.ArgsList && isUnpacked(paramType);

        if (argList[argIndex].argCategory === ArgCategory.UnpackedList) {
            let isArgCompatibleWithVariadic = false;

            const argTypeResult = getTypeOfArg(evaluator, argList[argIndex], /* inferenceContext */ undefined);

            let listElementType: Type | undefined;
            let enforceIterable = false;
            let advanceToNextArg = false;

            if (paramIndex < positionParamLimitIndex) {
                if (
                    isParamSpec(argTypeResult.type) &&
                    argTypeResult.type.priv.paramSpecAccess === 'args' &&
                    paramInfo.param.category !== ParamCategory.ArgsList
                ) {
                    if (!state.canSkipDiagnosticForNode(errorNode) && !isTypeIncomplete) {
                        evaluator.addDiagnostic(
                            DiagnosticRule.reportCallIssue,
                            positionParamLimitIndex === 1
                                ? LocMessage.argPositionalExpectedOne()
                                : LocMessage.argPositionalExpectedCount().format({
                                      expected: positionParamLimitIndex,
                                  }),
                            argList[argIndex].valueExpression ?? errorNode
                        );
                    }
                    reportedArgError = true;
                }
            }

            const argType = argTypeResult.type;

            if (isParamVariadic && isUnpackedTypeVarTuple(argType)) {
                listElementType = argType;
                isArgCompatibleWithVariadic = true;
                advanceToNextArg = true;
                isTypeVarTupleFullyMatched = true;
            } else if (
                isClassInstance(argType) &&
                isTupleClass(argType) &&
                argType.priv.tupleTypeArgs &&
                argType.priv.tupleTypeArgs.length === 1 &&
                isUnpackedTypeVarTuple(argType.priv.tupleTypeArgs[0].type)
            ) {
                listElementType = argType.priv.tupleTypeArgs[0].type;
                isArgCompatibleWithVariadic = true;
                advanceToNextArg = true;
                isTypeVarTupleFullyMatched = true;
            } else if (isParamVariadic && isClassInstance(argType) && isTupleClass(argType)) {
                isArgCompatibleWithVariadic = true;
                advanceToNextArg = true;

                if (remainingArgCount < remainingParamCount) {
                    isTypeVarTupleFullyMatched = true;
                }

                listElementType = ClassType.cloneForUnpacked(argType);
            } else if (isParamSpec(argType) && argType.priv.paramSpecAccess === 'args') {
                listElementType = undefined;
            } else {
                listElementType = evaluator.getTypeOfIterator(
                    { type: argType, isIncomplete: argTypeResult.isIncomplete },
                    /* isAsync */ false,
                    errorNode,
                    /* emitNotIterableError */ false
                )?.type;

                if (!listElementType) {
                    enforceIterable = true;
                }

                unpackedArgOfUnknownLength = true;

                if (paramInfo.param.category === ParamCategory.ArgsList) {
                    unpackedArgMapsToVariadic = true;
                }

                if (isParamVariadic && listElementType) {
                    isArgCompatibleWithVariadic = true;
                    listElementType = makeTupleObject(
                        evaluator,
                        [{ type: listElementType, isUnbounded: true }],
                        /* isUnpacked */ true
                    );
                }
            }

            const funcArg: Arg | undefined = listElementType
                ? {
                      argCategory: ArgCategory.Simple,
                      typeResult: { type: listElementType, isIncomplete: argTypeResult.isIncomplete },
                  }
                : { ...argList[argIndex], enforceIterable };

            if (argTypeResult.isIncomplete) {
                isTypeIncomplete = true;
            }

            if (isParamVariadic && !isArgCompatibleWithVariadic) {
                if (!state.canSkipDiagnosticForNode(errorNode) && !isTypeIncomplete) {
                    evaluator.addDiagnostic(
                        DiagnosticRule.reportCallIssue,
                        LocMessage.unpackedArgWithVariadicParam(),
                        argList[argIndex].valueExpression || errorNode
                    );
                }
                reportedArgError = true;
            } else {
                if (paramSpecArgList && paramInfo.param.category !== ParamCategory.Simple) {
                    paramSpecArgList.push(argList[argIndex]);
                }

                if (funcArg) {
                    validateArgTypeParams.push({
                        paramCategory: paramInfo.param.category,
                        paramType,
                        requiresTypeVarMatching: requiresSpecialization(paramType),
                        argument: funcArg,
                        errorNode: argList[argIndex].valueExpression ?? errorNode,
                        paramName,
                        isParamNameSynthesized: FunctionParam.isNameSynthesized(paramInfo.param),
                        mapsToVarArgList: isParamVariadic && remainingArgCount > remainingParamCount,
                    });
                }
            }

            trySetActive(argList[argIndex], paramDetails.params[paramIndex].param);

            if (paramName && paramDetails.params[paramIndex].param.category === ParamCategory.Simple) {
                paramTracker.markArgReceived(paramInfo);
            }

            if (advanceToNextArg || paramDetails.params[paramIndex].param.category === ParamCategory.ArgsList) {
                argIndex++;
            }

            if (
                isTypeVarTupleFullyMatched ||
                paramDetails.params[paramIndex].param.category !== ParamCategory.ArgsList
            ) {
                paramIndex++;
            }
        } else if (paramDetails.params[paramIndex].param.category === ParamCategory.ArgsList) {
            trySetActive(argList[argIndex], paramDetails.params[paramIndex].param);

            if (paramSpecArgList) {
                paramSpecArgList.push(argList[argIndex]);
                argIndex++;
            } else {
                let paramCategory = paramDetails.params[paramIndex].param.category;
                let effectiveParamType = paramType;
                const paramName = paramDetails.params[paramIndex].param.name;

                if (
                    isUnpackedClass(paramType) &&
                    paramType.priv.tupleTypeArgs &&
                    paramType.priv.tupleTypeArgs.length > 0
                ) {
                    effectiveParamType = paramType.priv.tupleTypeArgs[0].type;
                }

                paramCategory = isUnpacked(effectiveParamType) ? ParamCategory.ArgsList : ParamCategory.Simple;

                if (remainingArgCount <= remainingParamCount) {
                    if (remainingArgCount < remainingParamCount) {
                        if (!state.canSkipDiagnosticForNode(errorNode) && !isTypeIncomplete) {
                            evaluator.addDiagnostic(
                                DiagnosticRule.reportCallIssue,
                                remainingArgCount === 1
                                    ? LocMessage.argMorePositionalExpectedOne()
                                    : LocMessage.argMorePositionalExpectedCount().format({
                                          expected: remainingArgCount,
                                      }),
                                argList[argIndex].valueExpression || errorNode
                            );
                        }
                        reportedArgError = true;
                    }

                    paramIndex++;
                } else {
                    validateArgTypeParams.push({
                        paramCategory,
                        paramType: effectiveParamType,
                        requiresTypeVarMatching: requiresSpecialization(paramType),
                        argument: argList[argIndex],
                        errorNode: argList[argIndex].valueExpression || errorNode,
                        paramName,
                        isParamNameSynthesized: FunctionParam.isNameSynthesized(
                            paramDetails.params[paramIndex].param
                        ),
                        mapsToVarArgList: true,
                    });

                    argIndex++;
                }
            }
        } else {
            const paramInfo = paramDetails.params[paramIndex];
            const paramName = paramInfo.param.name;

            validateArgTypeParams.push({
                paramCategory: paramInfo.param.category,
                paramType,
                requiresTypeVarMatching: requiresSpecialization(paramType),
                argument: argList[argIndex],
                errorNode: argList[argIndex].valueExpression || errorNode,
                paramName,
                isParamNameSynthesized: FunctionParam.isNameSynthesized(paramInfo.param),
            });
            trySetActive(argList[argIndex], paramInfo.param);

            paramTracker.markArgReceived(paramInfo);

            argIndex++;
            paramIndex++;
        }
    }

    // If there weren't enough positional arguments to populate all of the
    // positional-only parameters and the next positional-only parameter is
    // an unbounded tuple, skip past it.
    let skippedArgsParam = false;
    if (
        positionalOnlyLimitIndex >= 0 &&
        paramIndex < positionalOnlyLimitIndex &&
        paramIndex < paramDetails.params.length &&
        paramDetails.params[paramIndex].param.category === ParamCategory.ArgsList &&
        !isParamSpec(paramDetails.params[paramIndex].type)
    ) {
        paramIndex++;
        skippedArgsParam = true;
    }

    // Check if there weren't enough positional arguments to populate all of
    // the positional-only parameters.
    if (
        positionalOnlyLimitIndex >= 0 &&
        paramIndex < positionalOnlyLimitIndex &&
        (!foundUnpackedListArg || hasParamSpecArgsKwargs)
    ) {
        const firstParamWithDefault = paramDetails.params.findIndex((paramInfo) => !!paramInfo.defaultType);
        const positionOnlyWithoutDefaultsCount =
            firstParamWithDefault >= 0 && firstParamWithDefault < positionalOnlyLimitIndex
                ? firstParamWithDefault
                : positionalOnlyLimitIndex;

        let argsRemainingCount = positionOnlyWithoutDefaultsCount - positionalArgCount;
        if (skippedArgsParam) {
            argsRemainingCount--;
        }

        const firstArgsParam = paramDetails.params.findIndex(
            (paramInfo) => paramInfo.param.category === ParamCategory.ArgsList && !isParamSpec(paramInfo.type)
        );
        if (firstArgsParam >= paramIndex && firstArgsParam < positionalOnlyLimitIndex) {
            argsRemainingCount--;
        }

        if (argsRemainingCount > 0) {
            if (!state.canSkipDiagnosticForNode(errorNode) && !isTypeIncomplete) {
                evaluator.addDiagnostic(
                    DiagnosticRule.reportCallIssue,
                    argsRemainingCount === 1
                        ? LocMessage.argMorePositionalExpectedOne()
                        : LocMessage.argMorePositionalExpectedCount().format({
                              expected: argsRemainingCount,
                          }),
                    argList.length > positionalArgCount
                        ? argList[positionalArgCount].valueExpression || errorNode
                        : errorNode
                );
            }
            reportedArgError = true;
        }
    }

    if (!reportedArgError) {
        let unpackedDictKeyNames: string[] | undefined;
        let unpackedDictArgType: Type | undefined;

        // Now consume any keyword arguments.
        while (argIndex < argList.length) {
            if (argList[argIndex].argCategory === ArgCategory.UnpackedDictionary) {
                const argTypeResult = getTypeOfArg(
                    evaluator,
                    argList[argIndex],
                    makeInferenceContext(paramDetails.unpackedKwargsTypedDictType)
                );
                const argType = argTypeResult.type;

                if (argTypeResult.isIncomplete) {
                    isTypeIncomplete = true;
                }

                if (isAnyOrUnknown(argType)) {
                    unpackedDictArgType = argType;
                } else if (isClassInstance(argType) && ClassType.isTypedDictClass(argType)) {
                    const tdEntries = getTypedDictMembersForClass(evaluator, argType);
                    const diag = new DiagnosticAddendum();

                    tdEntries.knownItems.forEach((entry, name) => {
                        const paramEntry = paramTracker.lookupName(name);
                        if (paramEntry) {
                            if (paramEntry.argsReceived > 0) {
                                diag.addMessage(LocMessage.paramAlreadyAssigned().format({ name }));
                            } else {
                                paramEntry.argsReceived++;

                                const paramInfoIndex = paramDetails.params.findIndex(
                                    (paramInfo) => paramInfo.param.name === name
                                );
                                assert(paramInfoIndex >= 0);
                                const paramType = paramDetails.params[paramInfoIndex].type;

                                validateArgTypeParams.push({
                                    paramCategory: ParamCategory.Simple,
                                    paramType,
                                    requiresTypeVarMatching: requiresSpecialization(paramType),
                                    argument: {
                                        argCategory: ArgCategory.Simple,
                                        typeResult: { type: entry.valueType },
                                    },
                                    errorNode: argList[argIndex].valueExpression ?? errorNode,
                                    paramName: name,
                                });
                            }
                        } else if (paramDetails.kwargsIndex !== undefined) {
                            const paramType = paramDetails.params[paramDetails.kwargsIndex].type;
                            validateArgTypeParams.push({
                                paramCategory: ParamCategory.KwargsDict,
                                paramType,
                                requiresTypeVarMatching: requiresSpecialization(paramType),
                                argument: {
                                    argCategory: ArgCategory.Simple,
                                    typeResult: { type: entry.valueType },
                                },
                                errorNode: argList[argIndex].valueExpression ?? errorNode,
                                paramName: name,
                            });

                            paramTracker.addKeywordParam(name, paramDetails.params[paramDetails.kwargsIndex]);
                        } else {
                            if (!paramDetails.hasUnpackedTypedDict) {
                                diag.addMessage(LocMessage.paramNameMissing().format({ name }));
                            }
                        }
                    });

                    const extraItemsType =
                        tdEntries.extraItems?.valueType ??
                        (registry.objectClass ? convertToInstance(registry.objectClass) : UnknownType.create());
                    if (!isNever(extraItemsType)) {
                        if (paramDetails.kwargsIndex !== undefined) {
                            const kwargsParam = paramDetails.params[paramDetails.kwargsIndex];

                            validateArgTypeParams.push({
                                paramCategory: ParamCategory.KwargsDict,
                                paramType: kwargsParam.type,
                                requiresTypeVarMatching: requiresSpecialization(kwargsParam.type),
                                argument: {
                                    argCategory: ArgCategory.UnpackedDictionary,
                                    typeResult: { type: extraItemsType },
                                },
                                errorNode: argList[argIndex].valueExpression ?? errorNode,
                                paramName: kwargsParam.param.name,
                            });
                        }
                    }

                    if (!diag.isEmpty()) {
                        if (!state.canSkipDiagnosticForNode(errorNode) && !isTypeIncomplete) {
                            evaluator.addDiagnostic(
                                DiagnosticRule.reportCallIssue,
                                LocMessage.unpackedTypedDictArgument() + diag.getString(),
                                argList[argIndex].valueExpression || errorNode
                            );
                        }
                        reportedArgError = true;
                    }
                } else if (paramSpec && isParamSpecKwargs(paramSpec, argType)) {
                    unpackedDictArgType = AnyType.create();

                    if (!paramSpecArgList) {
                        validateArgTypeParams.push({
                            paramCategory: ParamCategory.KwargsDict,
                            paramType: paramSpec,
                            requiresTypeVarMatching: false,
                            argument: argList[argIndex],
                            argType: isParamSpec(argType) ? undefined : AnyType.create(),
                            errorNode: argList[argIndex].valueExpression || errorNode,
                        });
                    }
                } else {
                    const strObjType = evaluator.getBuiltInObject(errorNode, 'str');

                    if (
                        registry.supportsKeysAndGetItemClass &&
                        isInstantiableClass(registry.supportsKeysAndGetItemClass) &&
                        strObjType &&
                        isClassInstance(strObjType)
                    ) {
                        const mappingConstraints = new ConstraintTracker();
                        let isValidMappingType = false;

                        if (isTypeVar(argType)) {
                            isValidMappingType = true;
                        } else if (
                            evaluator.assignType(
                                ClassType.cloneAsInstance(registry.supportsKeysAndGetItemClass),
                                argType,
                                /* diag */ undefined,
                                mappingConstraints
                            )
                        ) {
                            const specializedMapping = evaluator.solveAndApplyConstraints(
                                registry.supportsKeysAndGetItemClass,
                                mappingConstraints
                            ) as ClassType;
                            const typeArgs = specializedMapping.priv.typeArgs;
                            if (typeArgs && typeArgs.length >= 2) {
                                if (evaluator.assignType(strObjType, typeArgs[0])) {
                                    isValidMappingType = true;
                                }

                                unpackedDictKeyNames = [];
                                doForEachSubtype(typeArgs[0], (keyType) => {
                                    if (isClassInstance(keyType) && typeof keyType.priv.literalValue === 'string') {
                                        unpackedDictKeyNames?.push(keyType.priv.literalValue);
                                    } else {
                                        unpackedDictKeyNames = undefined;
                                    }
                                });

                                unpackedDictArgType = typeArgs[1];
                            } else {
                                isValidMappingType = true;
                                unpackedDictArgType = UnknownType.create();
                            }
                        }

                        unpackedArgOfUnknownLength = true;

                        if (paramDetails.kwargsIndex !== undefined && unpackedDictArgType) {
                            const paramType = paramDetails.params[paramDetails.kwargsIndex].type;
                            validateArgTypeParams.push({
                                paramCategory: ParamCategory.Simple,
                                paramType,
                                requiresTypeVarMatching: requiresSpecialization(paramType),
                                argType: unpackedDictArgType,
                                argument: argList[argIndex],
                                errorNode: argList[argIndex].valueExpression || errorNode,
                                paramName: paramDetails.params[paramDetails.kwargsIndex].param.name,
                            });

                            unpackedArgMapsToVariadic = true;
                        }

                        if (!isValidMappingType) {
                            if (!state.canSkipDiagnosticForNode(errorNode) && !isTypeIncomplete) {
                                evaluator.addDiagnostic(
                                    DiagnosticRule.reportCallIssue,
                                    LocMessage.unpackedDictArgumentNotMapping(),
                                    argList[argIndex].valueExpression || errorNode
                                );
                            }
                            reportedArgError = true;
                        }
                    }
                }

                if (paramSpecArgList) {
                    paramSpecArgList.push(argList[argIndex]);
                }
            } else {
                const paramName = argList[argIndex].name;
                if (paramName) {
                    const paramNameValue = paramName.d.value;
                    const paramEntry = paramTracker.lookupName(paramNameValue);

                    if (paramEntry) {
                        if (paramEntry.argsReceived > 0) {
                            if (!state.canSkipDiagnosticForNode(errorNode) && !isTypeIncomplete) {
                                evaluator.addDiagnostic(
                                    DiagnosticRule.reportCallIssue,
                                    LocMessage.paramAlreadyAssigned().format({ name: paramNameValue }),
                                    paramName
                                );
                            }
                            reportedArgError = true;
                        } else {
                            paramEntry.argsReceived++;

                            const paramInfoIndex = paramDetails.params.findIndex(
                                (paramInfo) =>
                                    paramInfo.param.name === paramNameValue &&
                                    paramInfo.kind !== ParamKind.Positional
                            );
                            assert(paramInfoIndex >= 0);
                            const paramType = paramDetails.params[paramInfoIndex].type;

                            validateArgTypeParams.push({
                                paramCategory: ParamCategory.Simple,
                                paramType,
                                requiresTypeVarMatching: requiresSpecialization(paramType),
                                argument: argList[argIndex],
                                errorNode: argList[argIndex].valueExpression ?? errorNode,
                                paramName: paramNameValue,
                            });
                            trySetActive(argList[argIndex], paramDetails.params[paramInfoIndex].param);
                        }
                    } else if (paramSpecArgList) {
                        paramSpecArgList.push(argList[argIndex]);
                    } else if (paramDetails.kwargsIndex !== undefined) {
                        const paramType = paramDetails.params[paramDetails.kwargsIndex].type;
                        if (isParamSpec(paramType)) {
                            if (!state.canSkipDiagnosticForNode(errorNode) && !isTypeIncomplete) {
                                evaluator.addDiagnostic(
                                    DiagnosticRule.reportCallIssue,
                                    LocMessage.paramNameMissing().format({ name: paramName.d.value }),
                                    paramName
                                );
                            }
                            reportedArgError = true;
                        } else {
                            validateArgTypeParams.push({
                                paramCategory: ParamCategory.KwargsDict,
                                paramType,
                                requiresTypeVarMatching: requiresSpecialization(paramType),
                                argument: argList[argIndex],
                                errorNode: argList[argIndex].valueExpression ?? errorNode,
                                paramName: paramNameValue,
                            });

                            assert(
                                paramDetails.params[paramDetails.kwargsIndex],
                                'paramDetails.kwargsIndex params entry is undefined'
                            );

                            paramTracker.addKeywordParam(
                                paramNameValue,
                                paramDetails.params[paramDetails.kwargsIndex]
                            );
                        }
                        trySetActive(argList[argIndex], paramDetails.params[paramDetails.kwargsIndex].param);
                    } else {
                        if (!state.canSkipDiagnosticForNode(errorNode) && !isTypeIncomplete) {
                            evaluator.addDiagnostic(
                                DiagnosticRule.reportCallIssue,
                                LocMessage.paramNameMissing().format({ name: paramName.d.value }),
                                paramName
                            );
                        }
                        reportedArgError = true;
                    }
                } else if (argList[argIndex].argCategory === ArgCategory.Simple) {
                    if (paramSpecArgList) {
                        paramSpecArgList.push(argList[argIndex]);
                    } else {
                        if (!state.canSkipDiagnosticForNode(errorNode) && !isTypeIncomplete) {
                            evaluator.addDiagnostic(
                                DiagnosticRule.reportCallIssue,
                                positionParamLimitIndex === 1
                                    ? LocMessage.argPositionalExpectedOne()
                                    : LocMessage.argPositionalExpectedCount().format({
                                          expected: positionParamLimitIndex,
                                      }),
                                argList[argIndex].valueExpression || errorNode
                            );
                        }
                        reportedArgError = true;
                    }
                } else if (argList[argIndex].argCategory === ArgCategory.UnpackedList) {
                    if (paramSpec) {
                        const argTypeResult = getTypeOfArg(evaluator, argList[argIndex], /* inferenceContext */ undefined);
                        const argType = argTypeResult.type;

                        if (argTypeResult.isIncomplete) {
                            isTypeIncomplete = true;
                        }

                        if (isParamSpecArgs(paramSpec, argType)) {
                            validateArgTypeParams.push({
                                paramCategory: ParamCategory.ArgsList,
                                paramType: paramSpec,
                                requiresTypeVarMatching: false,
                                argument: argList[argIndex],
                                argType: isParamSpec(argType) ? undefined : AnyType.create(),
                                errorNode: argList[argIndex].valueExpression ?? errorNode,
                            });
                        }
                    }
                }
            }

            argIndex++;
        }

        // If there are keyword-only parameters that haven't been matched but we
        // have an unpacked dictionary arg, assume that it applies to them.
        if (unpackedDictArgType && (!foundUnpackedListArg || paramDetails.argsIndex !== undefined)) {
            paramDetails.params.forEach((paramInfo, paramIndex) => {
                const param = paramInfo.param;
                if (
                    paramIndex >= paramDetails.firstPositionOrKeywordIndex &&
                    param.category === ParamCategory.Simple &&
                    param.name &&
                    paramTracker.lookupDetails(paramInfo).argsReceived === 0
                ) {
                    const paramType = paramDetails.params[paramIndex].type;

                    if (!unpackedDictKeyNames || unpackedDictKeyNames.includes(param.name)) {
                        validateArgTypeParams.push({
                            paramCategory: ParamCategory.Simple,
                            paramType,
                            requiresTypeVarMatching: requiresSpecialization(paramType),
                            argument: {
                                argCategory: ArgCategory.Simple,
                                typeResult: { type: unpackedDictArgType! },
                            },
                            errorNode:
                                argList.find((arg) => arg.argCategory === ArgCategory.UnpackedDictionary)
                                    ?.valueExpression ?? errorNode,
                            paramName: param.name,
                            isParamNameSynthesized: FunctionParam.isNameSynthesized(param),
                        });

                        paramTracker.markArgReceived(paramDetails.params[paramIndex]);
                    }
                }
            });
        }

        // Determine whether there are any parameters that require arguments
        // but have not yet received them.
        if (!unpackedDictArgType && !FunctionType.isDefaultParamCheckDisabled(overload)) {
            const unassignedParams = paramTracker.getUnassignedParams();

            if (unassignedParams.length > 0) {
                if (!state.canSkipDiagnosticForNode(errorNode)) {
                    const missingParamNames = unassignedParams.map((p: string) => `"${p}"`).join(', ');
                    if (!state.canSkipDiagnosticForNode(errorNode) && !isTypeIncomplete) {
                        evaluator.addDiagnostic(
                            DiagnosticRule.reportCallIssue,
                            unassignedParams.length === 1
                                ? LocMessage.argMissingForParam().format({ name: missingParamNames })
                                : LocMessage.argMissingForParams().format({ names: missingParamNames }),
                            errorNode
                        );
                    }
                }
                reportedArgError = true;
            }

            paramDetails.params.forEach((paramInfo) => {
                const param = paramInfo.param;
                if (param.category === ParamCategory.Simple && param.name) {
                    const entry = paramTracker.lookupDetails(paramInfo);

                    if (entry.argsNeeded === 0 && entry.argsReceived === 0) {
                        const defaultArgType = paramInfo.defaultType;

                        if (
                            defaultArgType &&
                            !isEllipsisType(defaultArgType) &&
                            requiresSpecialization(paramInfo.declaredType, { ignorePseudoGeneric: true })
                        ) {
                            validateArgTypeParams.push({
                                paramCategory: param.category,
                                paramType: paramInfo.type,
                                requiresTypeVarMatching: true,
                                argument: {
                                    argCategory: ArgCategory.Simple,
                                    typeResult: { type: defaultArgType },
                                },
                                isDefaultArg: true,
                                errorNode,
                                paramName: param.name,
                                isParamNameSynthesized: FunctionParam.isNameSynthesized(param),
                            });
                        }
                    }
                }
            });
        }
    }

    if (!reportedArgError || !state.isSpeculativeModeInUse(undefined)) {
        assert(
            paramDetails.argsIndex === undefined || paramDetails.argsIndex < paramDetails.params.length,
            'paramDetails.argsIndex params entry is invalid'
        );
        if (
            paramDetails.argsIndex !== undefined &&
            paramDetails.argsIndex >= 0 &&
            FunctionParam.isTypeDeclared(paramDetails.params[paramDetails.argsIndex].param) &&
            !isTypeVarTupleFullyMatched
        ) {
            const paramType = paramDetails.params[paramDetails.argsIndex].type;
            const variadicArgs = validateArgTypeParams.filter((argParam) => argParam.mapsToVarArgList);

            if (isUnpacked(paramType) && (!isTypeVarTuple(paramType) || !paramType.priv.isInUnion)) {
                const tupleTypeArgs: TupleTypeArg[] = variadicArgs.map((argParam) => {
                    const argType = getTypeOfArg(evaluator, argParam.argument, /* inferenceContext */ undefined).type;

                    const containsTypeVarTuple =
                        isUnpackedTypeVarTuple(argType) ||
                        (isClassInstance(argType) &&
                            isTupleClass(argType) &&
                            argType.priv.tupleTypeArgs &&
                            argType.priv.tupleTypeArgs.length === 1 &&
                            isUnpackedTypeVarTuple(argType.priv.tupleTypeArgs[0].type));

                    if (
                        containsTypeVarTuple &&
                        argParam.argument.argCategory !== ArgCategory.UnpackedList &&
                        !argParam.mapsToVarArgList
                    ) {
                        if (!state.canSkipDiagnosticForNode(errorNode) && !isTypeIncomplete) {
                            evaluator.addDiagnostic(
                                DiagnosticRule.reportCallIssue,
                                LocMessage.typeVarTupleMustBeUnpacked(),
                                argParam.argument.valueExpression ?? errorNode
                            );
                        }
                        reportedArgError = true;
                    }

                    return {
                        type: argType,
                        isUnbounded: argParam.argument.argCategory === ArgCategory.UnpackedList,
                    };
                });

                let specializedTuple: Type | undefined;
                if (tupleTypeArgs.length === 1 && !tupleTypeArgs[0].isUnbounded) {
                    const entryType = tupleTypeArgs[0].type;

                    if (isUnpacked(entryType)) {
                        specializedTuple = makePacked(entryType);
                    }
                }

                if (!specializedTuple) {
                    specializedTuple = makeTupleObject(evaluator, tupleTypeArgs, /* isUnpacked */ false);
                }

                const combinedArg: ValidateArgTypeParams = {
                    paramCategory: ParamCategory.Simple,
                    paramType: makePacked(paramType),
                    requiresTypeVarMatching: true,
                    argument: {
                        argCategory: ArgCategory.Simple,
                        typeResult: { type: specializedTuple },
                    },
                    errorNode,
                    paramName: paramDetails.params[paramDetails.argsIndex].param.name,
                    isParamNameSynthesized: FunctionParam.isNameSynthesized(
                        paramDetails.params[paramDetails.argsIndex].param
                    ),
                    mapsToVarArgList: true,
                };

                validateArgTypeParams = [
                    ...validateArgTypeParams.filter((argParam) => !argParam.mapsToVarArgList),
                    combinedArg,
                ];
            }
        }
    }

    // Special-case the builtin isinstance and issubclass functions.
    if (FunctionType.isBuiltIn(overload, ['isinstance', 'issubclass']) && validateArgTypeParams.length === 2) {
        validateArgTypeParams[1].isinstanceParam = true;
    }

    return {
        overload,
        overloadIndex,
        argumentErrors: reportedArgError,
        isTypeIncomplete,
        argParams: validateArgTypeParams,
        paramSpecTarget,
        paramSpecArgList,
        activeParam,
        unpackedArgOfUnknownLength,
        unpackedArgMapsToVariadic,
        argumentMatchScore: 0,
    };
}

export function getTypeArgs(
    evaluator: TypeEvaluator,
    state: TypeEvaluatorState,
    registry: TypeRegistry,
    node: IndexNode,
    flags: EvalFlags,
    options?: GetTypeArgsOptions
): TypeResultWithNode[] {
    const typeArgs: TypeResultWithNode[] = [];
    let adjFlags = flags | EvalFlags.NoConvertSpecialForm;
    adjFlags &= ~EvalFlags.TypeFormArg;

    const allowFinalClassVar = () => {
        const enclosingClassNode = ParseTreeUtils.getEnclosingClass(node, /* stopeAtFunction */ true);
        if (enclosingClassNode) {
            const classTypeInfo = evaluator.getTypeOfClass(enclosingClassNode);
            if (classTypeInfo && ClassType.isDataClass(classTypeInfo.classType)) {
                return true;
            }
        }
        return false;
    };

    if (options?.isFinalAnnotation) {
        adjFlags |= EvalFlags.NoFinal;

        if (!allowFinalClassVar()) {
            adjFlags |= EvalFlags.NoClassVar;
        }
    } else if (options?.isClassVarAnnotation) {
        adjFlags |= EvalFlags.NoClassVar;

        if (!allowFinalClassVar()) {
            adjFlags |= EvalFlags.NoFinal;
        }
    } else {
        adjFlags &= ~(
            EvalFlags.NoSpecialize |
            EvalFlags.NoParamSpec |
            EvalFlags.NoTypeVarTuple |
            EvalFlags.AllowRequired |
            EvalFlags.EnforceVarianceConsistency
        );

        if (!options?.isAnnotatedClass) {
            adjFlags |= EvalFlags.NoClassVar | EvalFlags.NoFinal;
        }

        adjFlags |= EvalFlags.AllowUnpackedTuple | EvalFlags.AllowConcatenate;
    }

    const getTypeArgTypeResult = (expr: ExpressionNode, argIndex: number) => {
        let typeResult: TypeResultWithNode;

        if (options?.hasCustomClassGetItem) {
            adjFlags =
                EvalFlags.NoParamSpec | EvalFlags.NoTypeVarTuple | EvalFlags.NoSpecialize | EvalFlags.NoClassVar;
            typeResult = {
                ...evaluator.getTypeOfExpression(expr, adjFlags),
                node: expr,
            };
        } else if (options?.isAnnotatedClass && argIndex > 0) {
            adjFlags =
                EvalFlags.NoParamSpec | EvalFlags.NoTypeVarTuple | EvalFlags.NoSpecialize | EvalFlags.NoClassVar;
            if (isAnnotationEvaluationPostponed(AnalyzerNodeInfo.getFileInfo(node))) {
                adjFlags |= EvalFlags.ForwardRefs;
            }

            typeResult = {
                ...evaluator.getTypeOfExpression(expr, adjFlags),
                node: expr,
            };
        } else {
            typeResult = getTypeArg(evaluator, state, registry, expr, adjFlags, !!options?.supportsTypedDictTypeArg && argIndex === 0);
        }

        return typeResult;
    };

    if (
        node.d.items.length === 1 &&
        !node.d.trailingComma &&
        !node.d.items[0].d.name &&
        node.d.items[0].d.valueExpr.nodeType === ParseNodeType.Tuple
    ) {
        node.d.items[0].d.valueExpr.d.items.forEach((item, index) => {
            typeArgs.push(getTypeArgTypeResult(item, index));
        });

        state.writeTypeCache(node.d.items[0].d.valueExpr, { type: UnknownType.create() }, EvalFlags.None);

        return typeArgs;
    }

    node.d.items.forEach((arg, index) => {
        const typeResult = getTypeArgTypeResult(arg.d.valueExpr, index);

        if (arg.d.argCategory !== ArgCategory.Simple) {
            if (arg.d.argCategory === ArgCategory.UnpackedList) {
                if (!options?.isAnnotatedClass || index === 0) {
                    const unpackedType = specialForms.applyUnpackToTupleLike(typeResult.type);

                    if (unpackedType) {
                        typeResult.type = unpackedType;
                    } else {
                        if ((flags & EvalFlags.TypeExpression) !== 0) {
                            evaluator.addDiagnostic(
                                DiagnosticRule.reportInvalidTypeForm,
                                LocMessage.unpackNotAllowed(),
                                arg.d.valueExpr
                            );
                            typeResult.typeErrors = true;
                        } else {
                            typeResult.type = UnknownType.create();
                        }
                    }
                }
            }
        }

        if (arg.d.name) {
            if ((flags & EvalFlags.TypeExpression) !== 0) {
                evaluator.addDiagnostic(
                    DiagnosticRule.reportInvalidTypeForm,
                    LocMessage.keywordArgInTypeArgument(),
                    arg.d.valueExpr
                );
                typeResult.typeErrors = true;
            } else {
                typeResult.type = UnknownType.create();
            }
        }

        if (
            arg.d.valueExpr.nodeType !== ParseNodeType.Error ||
            arg.d.valueExpr.d.category !== ErrorExpressionCategory.MissingIndexOrSlice
        ) {
            typeArgs.push(typeResult);
        }
    });

    return typeArgs;
}

export function getTypeArg(
    evaluator: TypeEvaluator,
    state: TypeEvaluatorState,
    registry: TypeRegistry,
    node: ExpressionNode,
    flags: EvalFlags,
    supportsDictExpression: boolean
): TypeResultWithNode {
    let typeResult: TypeResultWithNode;

    let adjustedFlags =
        flags | EvalFlags.InstantiableType | EvalFlags.ConvertEllipsisToAny | EvalFlags.StrLiteralAsType;

    const fileInfo = AnalyzerNodeInfo.getFileInfo(node);
    if (fileInfo.isStubFile) {
        adjustedFlags |= EvalFlags.ForwardRefs;
    }

    if (node.nodeType === ParseNodeType.List) {
        typeResult = {
            type: UnknownType.create(),
            typeList: (node as ListNode).d.items.map((entry) => {
                return { ...evaluator.getTypeOfExpression(entry, adjustedFlags), node: entry };
            }),
            node,
        };

        state.writeTypeCache(node, { type: UnknownType.create() }, EvalFlags.None);
    } else if (node.nodeType === ParseNodeType.Dictionary && supportsDictExpression) {
        const inlinedTypeDict =
            registry.typedDictClass && isInstantiableClass(registry.typedDictClass)
                ? createTypedDictTypeInlined(evaluator, node, registry.typedDictClass)
                : undefined;
        const keyTypeFallback =
            registry.strClass && isInstantiableClass(registry.strClass) ? registry.strClass : UnknownType.create();

        typeResult = {
            type: keyTypeFallback,
            inlinedTypeDict,
            node,
        };
    } else {
        typeResult = { ...evaluator.getTypeOfExpression(node, adjustedFlags), node };

        if (node.nodeType === ParseNodeType.Dictionary) {
            evaluator.addDiagnostic(DiagnosticRule.reportInvalidTypeForm, LocMessage.dictInAnnotation(), node);
        }

        if ((flags & EvalFlags.NoClassVar) !== 0) {
            if (isClass(typeResult.type) && ClassType.isBuiltIn(typeResult.type, 'ClassVar')) {
                evaluator.addDiagnostic(DiagnosticRule.reportInvalidTypeForm, LocMessage.classVarNotAllowed(), node);
            }
        }
    }

    return typeResult;
}

// Redefined locally to avoid circular import from typeEvaluator.ts
export interface ParamSpecArgResult {
    argumentErrors: boolean;
    constraintTrackers: (ConstraintTracker | undefined)[];
}

export function getUnknownExemptTypeVarsForReturnType(functionType: FunctionType, returnType: Type): TypeVarType[] {
    if (isFunction(returnType) && !returnType.shared.name) {
        const returnTypeScopeId = returnType.shared.typeVarScopeId;

        if (returnTypeScopeId && functionType.shared.typeVarScopeId) {
            let typeVarsInReturnType = getTypeVarArgsRecursive(returnType);

            functionType.shared.parameters.forEach((param, index) => {
                if (FunctionParam.isTypeDeclared(param)) {
                    const typeVarsInInputParam = getTypeVarArgsRecursive(
                        FunctionType.getParamType(functionType, index)
                    );
                    typeVarsInReturnType = typeVarsInReturnType.filter(
                        (returnTypeVar) =>
                            !typeVarsInInputParam.some((inputTypeVar) => isTypeSame(returnTypeVar, inputTypeVar))
                    );
                }
            });

            return typeVarsInReturnType;
        }
    }

    return [];
}

export function validateArgTypesForParamSpec(
    evaluator: TypeEvaluator,
    state: TypeEvaluatorState,
    registry: TypeRegistry,
    errorNode: ExpressionNode,
    argList: Arg[],
    paramSpec: ParamSpecType,
    destConstraints: ConstraintTracker
): ParamSpecArgResult {
    const sets = destConstraints.getConstraintSets();

    if (sets.length === 1) {
        return validateArgTypesForParamSpecSignature(evaluator, state, registry, errorNode, argList, paramSpec, sets[0]);
    }

    const filteredSets: ConstraintSet[] = [];
    const constraintTrackers: (ConstraintTracker | undefined)[] = [];
    const speculativeNode = getSpeculativeNodeForCall(errorNode);

    sets.forEach((context) => {
        state.useSpeculativeMode(speculativeNode, () => {
            const paramSpecArgResult = validateArgTypesForParamSpecSignature(
                evaluator,
                state,
                registry,
                errorNode,
                argList,
                paramSpec,
                context
            );

            if (!paramSpecArgResult.argumentErrors) {
                filteredSets.push(context);
            }

            appendArray(constraintTrackers, paramSpecArgResult.constraintTrackers);
        });
    });

    if (filteredSets.length > 0) {
        destConstraints.addConstraintSets(filteredSets);
    }

    const paramSpecArgResult = validateArgTypesForParamSpecSignature(
        evaluator,
        state,
        registry,
        errorNode,
        argList,
        paramSpec,
        filteredSets.length > 0 ? filteredSets[0] : sets[0]
    );

    return { argumentErrors: paramSpecArgResult.argumentErrors, constraintTrackers: constraintTrackers };
}

export function validateArgTypesForParamSpecSignature(
    evaluator: TypeEvaluator,
    state: TypeEvaluatorState,
    registry: TypeRegistry,
    errorNode: ExpressionNode,
    argList: Arg[],
    paramSpec: ParamSpecType,
    constraintSet: ConstraintSet
): ParamSpecArgResult {
    const solutionSet = solveConstraintSet(evaluator, constraintSet);
    let paramSpecType = solutionSet.getType(paramSpec);
    paramSpecType = convertTypeToParamSpecValue(paramSpecType ?? paramSpec);

    const matchResults = matchArgsToParams(evaluator, state, registry, errorNode, argList, { type: paramSpecType }, 0);
    const functionType = matchResults.overload;
    const constraints = new ConstraintTracker();

    if (matchResults.argumentErrors) {
        argList.forEach((arg) => {
            if (arg.valueExpression && !state.isSpeculativeModeInUse(arg.valueExpression)) {
                evaluator.getTypeOfExpression(arg.valueExpression);
            }
        });

        return { argumentErrors: true, constraintTrackers: [constraints] };
    }

    const functionParamSpec = FunctionType.getParamSpecFromArgsKwargs(functionType);
    const functionWithoutParamSpec = FunctionType.cloneRemoveParamSpecArgsKwargs(functionType);

    if (
        functionParamSpec &&
        functionWithoutParamSpec.shared.parameters.length === 0 &&
        isTypeSame(functionParamSpec, paramSpec)
    ) {
        let argsCount = 0;
        let kwargsCount = 0;
        let argumentErrors = false;
        let argErrorNode: ExpressionNode | undefined;

        for (const arg of argList) {
            const argType = getTypeOfArg(evaluator, arg, /* inferenceContext */ undefined)?.type;

            if (arg.argCategory === ArgCategory.UnpackedList) {
                if (isParamSpecArgs(paramSpec, argType)) {
                    argsCount++;
                }
            } else if (arg.argCategory === ArgCategory.UnpackedDictionary) {
                if (isParamSpecKwargs(paramSpec, argType)) {
                    kwargsCount++;
                }
            } else {
                argErrorNode = argErrorNode ?? arg.valueExpression;
                argumentErrors = true;
            }
        }

        if (argsCount !== 1 || kwargsCount !== 1) {
            argumentErrors = true;
        }

        if (argumentErrors) {
            evaluator.addDiagnostic(
                DiagnosticRule.reportCallIssue,
                LocMessage.paramSpecArgsMissing().format({
                    type: evaluator.printType(functionParamSpec),
                }),
                argErrorNode ?? errorNode
            );
        }

        return { argumentErrors, constraintTrackers: [constraints] };
    }

    const result = validateArgTypes(evaluator, state, registry, errorNode, matchResults, constraints, /* skipUnknownArgCheck */ undefined);
    return { argumentErrors: !!result.argumentErrors, constraintTrackers: [constraints] };
}

export function validateArgTypes(
    evaluator: TypeEvaluator,
    state: TypeEvaluatorState,
    registry: TypeRegistry,
    errorNode: ExpressionNode,
    matchResults: MatchArgsToParamsResult,
    constraints: ConstraintTracker,
    skipUnknownArgCheck: boolean | undefined
): CallResult {
    const type = matchResults.overload;
    let isTypeIncomplete = matchResults.isTypeIncomplete;
    let argumentErrors = false;
    let argumentMatchScore = 0;
    let specializedInitSelfType: Type | undefined;
    let anyOrUnknownArg: UnknownType | AnyType | undefined;
    const speculativeNode = getSpeculativeNodeForCall(errorNode);
    const typeCondition = getTypeCondition(type);
    const paramSpec = FunctionType.getParamSpecFromArgsKwargs(type);

    if (type.priv.boundToType && !type.priv.boundToType.priv.includeSubclasses && type.shared.methodClass) {
        const abstractSymbolInfo = symbolResolution.getAbstractSymbolInfo(evaluator, type.shared.methodClass, type.shared.name);

        if (abstractSymbolInfo && !abstractSymbolInfo.hasImplementation) {
            evaluator.addDiagnostic(
                DiagnosticRule.reportAbstractUsage,
                LocMessage.abstractMethodInvocation().format({
                    method: type.shared.name,
                }),
                errorNode.nodeType === ParseNodeType.Call ? errorNode.d.leftExpr : errorNode
            );
        }
    }

    if (
        type.shared.name === '__init__' &&
        type.priv.strippedFirstParamType &&
        type.priv.boundToType &&
        isClassInstance(type.priv.strippedFirstParamType) &&
        isClassInstance(type.priv.boundToType) &&
        ClassType.isSameGenericClass(type.priv.strippedFirstParamType, type.priv.boundToType) &&
        type.priv.strippedFirstParamType.priv.typeArgs
    ) {
        const typeParams = type.priv.strippedFirstParamType.shared.typeParams;
        specializedInitSelfType = type.priv.strippedFirstParamType;
        type.priv.strippedFirstParamType.priv.typeArgs.forEach((typeArg, index) => {
            if (index < typeParams.length) {
                const typeParam = typeParams[index];
                if (!isTypeSame(typeParam, typeArg, { ignorePseudoGeneric: true })) {
                    constraints.setBounds(typeParams[index], typeArg);
                }
            }
        });
    }

    if (
        FunctionType.isBuiltIn(type, [
            'typing.cast',
            'typing_extensions.cast',
            'builtins.isinstance',
            'builtins.issubclass',
        ])
    ) {
        skipUnknownArgCheck = true;
    }

    const typeVarCount = matchResults.argParams.filter((arg) => arg.requiresTypeVarMatching).length;
    if (typeVarCount > 0) {
        let passCount = Math.min(typeVarCount, 2);

        for (let i = 0; i < passCount; i++) {
            state.useSpeculativeMode(speculativeNode, () => {
                matchResults.argParams.forEach((argParam) => {
                    if (!argParam.requiresTypeVarMatching) {
                        return;
                    }

                    const argResult = validateArgType(
                        evaluator,
                        state,
                        argParam,
                        constraints,
                        { type, isIncomplete: matchResults.isTypeIncomplete },
                        {
                            skipUnknownArgCheck,
                            isArgFirstPass: passCount > 1 && i === 0,
                            conditionFilter: typeCondition,
                            skipReportError: true,
                        }
                    );

                    if (argResult.isTypeIncomplete) {
                        isTypeIncomplete = true;
                    }

                    if (i === 0 && passCount < 2 && argResult.skippedBareTypeVarExpectedType) {
                        passCount++;
                    }
                });
            });
        }
    }

    let sawParamSpecArgs = false;
    let sawParamSpecKwargs = false;

    let condition: TypeCondition[] = [];
    const argResults: ArgResult[] = [];

    matchResults.argParams.forEach((argParam, argParamIndex) => {
        const argResult = validateArgType(
            evaluator,
            state,
            argParam,
            constraints,
            { type, isIncomplete: matchResults.isTypeIncomplete },
            {
                skipUnknownArgCheck,
                conditionFilter: typeCondition,
            }
        );

        argResults.push(argResult);

        if (!argResult.isCompatible) {
            argumentErrors = true;
            argumentMatchScore += 1 + (matchResults.argParams.length - argParamIndex);
        }

        if (argResult.isTypeIncomplete) {
            isTypeIncomplete = true;
        }

        if (argResult.condition) {
            condition = TypeCondition.combine(condition, argResult.condition) ?? [];
        }

        if (isAnyOrUnknown(argResult.argType)) {
            anyOrUnknownArg = anyOrUnknownArg
                ? preserveUnknown(argResult.argType, anyOrUnknownArg)
                : argResult.argType;
        }

        if (paramSpec) {
            if (argParam.argument.argCategory === ArgCategory.UnpackedList) {
                if (isParamSpecArgs(paramSpec, argResult.argType)) {
                    if (sawParamSpecArgs) {
                        evaluator.addDiagnostic(
                            DiagnosticRule.reportCallIssue,
                            LocMessage.paramSpecArgsKwargsDuplicate().format({ type: evaluator.printType(paramSpec) }),
                            argParam.errorNode
                        );
                    }

                    sawParamSpecArgs = true;
                }
            }

            if (argParam.argument.argCategory === ArgCategory.UnpackedDictionary) {
                if (isParamSpecKwargs(paramSpec, argResult.argType)) {
                    if (sawParamSpecKwargs) {
                        evaluator.addDiagnostic(
                            DiagnosticRule.reportCallIssue,
                            LocMessage.paramSpecArgsKwargsDuplicate().format({ type: evaluator.printType(paramSpec) }),
                            argParam.errorNode
                        );
                    }

                    sawParamSpecKwargs = true;
                }
            }
        }
    });

    let paramSpecConstraints: (ConstraintTracker | undefined)[] = [];

    if (matchResults.paramSpecArgList && matchResults.paramSpecTarget) {
        const paramSpecArgResult = validateArgTypesForParamSpec(
            evaluator,
            state,
            registry,
            errorNode,
            matchResults.paramSpecArgList,
            matchResults.paramSpecTarget,
            constraints
        );

        if (paramSpecArgResult.argumentErrors) {
            argumentErrors = true;
            argumentMatchScore += 1;
        }

        paramSpecConstraints = paramSpecArgResult.constraintTrackers;
    } else if (paramSpec) {
        if (!sawParamSpecArgs || !sawParamSpecKwargs) {
            if (!isTypeIncomplete) {
                evaluator.addDiagnostic(
                    DiagnosticRule.reportCallIssue,
                    LocMessage.paramSpecArgsMissing().format({ type: evaluator.printType(paramSpec) }),
                    errorNode
                );
            }
            argumentErrors = true;
            argumentMatchScore += 1;
        }
    }

    const returnTypeResult = evaluator.getEffectiveReturnTypeResult(type, {
        callSiteInfo: { args: matchResults.argParams, errorNode },
    });
    let returnType = returnTypeResult.type;
    if (returnTypeResult.isIncomplete) {
        isTypeIncomplete = true;
    }

    if (condition.length > 0) {
        returnType = TypeBase.cloneForCondition(returnType, condition);
    }

    let eliminateUnsolvedInUnions = true;

    if (isFunctionOrOverloaded(returnType)) {
        eliminateUnsolvedInUnions = false;
    }

    let specializedReturnType = evaluator.solveAndApplyConstraints(returnType, constraints, {
        replaceUnsolved: {
            scopeIds: getTypeVarScopeIds(type),
            unsolvedExemptTypeVars: getUnknownExemptTypeVarsForReturnType(type, returnType),
            tupleClassType: evaluator.getTupleClassType(),
            eliminateUnsolvedInUnions,
        },
    });
    specializedReturnType = addConditionToType(specializedReturnType, typeCondition, { skipBoundTypeVars: true });

    if (paramSpecConstraints.length > 0) {
        paramSpecConstraints.forEach((psc) => {
            if (psc) {
                specializedReturnType = evaluator.solveAndApplyConstraints(specializedReturnType, psc);

                applySourceSolutionToConstraints(
                    constraints,
                    solveConstraints(evaluator, psc)
                );
            }
        });
    }

    if (isUnpackedClass(specializedReturnType)) {
        specializedReturnType = ClassType.cloneForPacked(specializedReturnType);
    }

    const liveTypeVarScopes = ParseTreeUtils.getTypeVarScopesForNode(errorNode);
    specializedReturnType = adjustCallableReturnType(evaluator, errorNode, specializedReturnType, liveTypeVarScopes);

    if (specializedInitSelfType) {
        specializedInitSelfType = evaluator.solveAndApplyConstraints(specializedInitSelfType, constraints);
    }

    matchResults.argumentMatchScore = argumentMatchScore;

    return {
        argumentErrors,
        argResults,
        anyOrUnknownArg,
        returnType: specializedReturnType,
        isTypeIncomplete,
        activeParam: matchResults.activeParam,
        specializedInitSelfType,
        overloadsUsedForCall: argumentErrors ? [] : [type],
    };
}

export function validateArgTypesWithExpectedType(
    evaluator: TypeEvaluator,
    state: TypeEvaluatorState,
    registry: TypeRegistry,
    errorNode: ExpressionNode,
    matchResults: MatchArgsToParamsResult,
    constraints: ConstraintTracker,
    skipUnknownArgCheck = false,
    expectedType: Type,
    returnType: Type
): CallResult {
    const liveTypeVarScopes = ParseTreeUtils.getTypeVarScopesForNode(errorNode);
    let assignFlags = AssignTypeFlags.PopulateExpectedType;
    if (containsLiteralType(expectedType, /* includeTypeArgs */ true)) {
        assignFlags |= AssignTypeFlags.RetainLiteralsForTypeVar;
    }

    if (isClassInstance(returnType) && isClassInstance(expectedType) && !isTypeSame(returnType, expectedType)) {
        const tempConstraints = new ConstraintTracker();
        if (
            addConstraintsForExpectedType(
                evaluator,
                returnType,
                expectedType,
                tempConstraints,
                liveTypeVarScopes,
                errorNode.start
            )
        ) {
            const genericReturnType = selfSpecializeClass(returnType, {
                overrideTypeArgs: true,
            });

            expectedType = evaluator.solveAndApplyConstraints(genericReturnType, tempConstraints, {
                replaceUnsolved: {
                    scopeIds: getTypeVarScopeIds(returnType),
                    useUnknown: true,
                    tupleClassType: evaluator.getTupleClassType(),
                },
            });

            assignFlags |= AssignTypeFlags.SkipPopulateUnknownExpectedType;
        }
    }

    expectedType = transformExpectedType(expectedType, liveTypeVarScopes, errorNode.start);

    evaluator.assignType(returnType, expectedType, /* diag */ undefined, constraints, assignFlags);

    return validateArgTypes(evaluator, state, registry, errorNode, matchResults, constraints, skipUnknownArgCheck);
}

export function validateArgTypesWithContext(
    evaluator: TypeEvaluator,
    state: TypeEvaluatorState,
    registry: TypeRegistry,
    errorNode: ExpressionNode,
    matchResults: MatchArgsToParamsResult,
    constraints: ConstraintTracker,
    skipUnknownArgCheck = false,
    inferenceContext: InferenceContext | undefined
): CallResult {
    const type = matchResults.overload;

    let expectedType: Type | undefined = inferenceContext?.expectedType;

    const returnType = inferenceContext?.returnTypeOverride ?? evaluator.getEffectiveReturnTypeResult(type).type;
    if (!returnType || !requiresSpecialization(returnType)) {
        expectedType = undefined;
    }

    const tryExpectedType = (expectedSubtype: Type): number => {
        const clonedConstraints = constraints.clone();
        const callResult = validateArgTypesWithExpectedType(
            evaluator,
            state,
            registry,
            errorNode,
            matchResults,
            clonedConstraints,
            /* skipUnknownArgCheck */ true,
            expectedSubtype,
            returnType
        );

        if (!callResult.argumentErrors && callResult.returnType) {
            const resolvedReturnType = inferenceContext?.returnTypeOverride
                ? evaluator.solveAndApplyConstraints(inferenceContext.returnTypeOverride, clonedConstraints)
                : callResult.returnType;

            if (
                evaluator.assignType(
                    expectedSubtype,
                    resolvedReturnType,
                    /* diag */ undefined,
                    /* constraints */ undefined,
                    AssignTypeFlags.Default
                )
            ) {
                const anyOrUnknown = containsAnyOrUnknown(callResult.returnType, /* recurse */ true);
                if (!anyOrUnknown) {
                    return 3;
                }

                return isAny(anyOrUnknown) ? 2 : 1;
            }
        }

        return 0;
    };

    if (expectedType) {
        expectedType = state.useSpeculativeMode(getSpeculativeNodeForCall(errorNode), () => {
            let validExpectedSubtype: Type | undefined;
            let bestSubtypeScore = -1;

            if (isUnion(expectedType!)) {
                doForEachSubtype(
                    expectedType!,
                    (expectedSubtype) => {
                        if (bestSubtypeScore < 3) {
                            const score = tryExpectedType(expectedSubtype);
                            if (score > 0 && score > bestSubtypeScore) {
                                validExpectedSubtype = expectedSubtype;
                                bestSubtypeScore = score;
                            }
                        }
                    },
                    /* sortSubtypes */ true
                );
            }

            if (bestSubtypeScore < 3) {
                const score = tryExpectedType(expectedType!);
                if (score > 0 && score > bestSubtypeScore) {
                    validExpectedSubtype = expectedType;
                }
            }

            return validExpectedSubtype;
        });
    }

    if (!expectedType || isAnyOrUnknown(expectedType) || isNever(expectedType)) {
        return validateArgTypes(evaluator, state, registry, errorNode, matchResults, constraints, skipUnknownArgCheck);
    }

    return validateArgTypesWithExpectedType(
        evaluator,
        state,
        registry,
        errorNode,
        matchResults,
        constraints,
        skipUnknownArgCheck,
        expectedType,
        returnType
    );
}

export function validateArgs(
    evaluator: TypeEvaluator,
    state: TypeEvaluatorState,
    registry: TypeRegistry,
    errorNode: ExpressionNode,
    argList: Arg[],
    typeResult: TypeResult<FunctionType>,
    constraints: ConstraintTracker | undefined,
    skipUnknownArgCheck = false,
    inferenceContext: InferenceContext | undefined
): CallResult {
    const matchResults = matchArgsToParams(evaluator, state, registry, errorNode, argList, typeResult, 0);

    if (matchResults.argumentErrors) {
        matchResults.argParams.forEach((argParam) => {
            if (argParam.argument.valueExpression && !state.isSpeculativeModeInUse(argParam.argument.valueExpression)) {
                evaluator.getTypeOfExpression(
                    argParam.argument.valueExpression,
                    /* flags */ undefined,
                    makeInferenceContext(argParam.paramType)
                );
            }
        });

        argList.forEach((arg) => {
            if (arg.valueExpression && !state.isSpeculativeModeInUse(arg.valueExpression)) {
                const wasEvaluated = matchResults.argParams.some((argParam) => argParam.argument === arg);
                if (!wasEvaluated) {
                    evaluator.getTypeOfExpression(arg.valueExpression);
                }
            }
        });

        const possibleType = FunctionType.getEffectiveReturnType(typeResult.type);
        return {
            returnType:
                possibleType && !isAnyOrUnknown(possibleType)
                    ? UnknownType.createPossibleType(possibleType, /* isIncomplete */ false)
                    : undefined,
            argumentErrors: true,
            activeParam: matchResults.activeParam,
            overloadsUsedForCall: [],
        };
    }

    return validateArgTypesWithContext(
        evaluator,
        state,
        registry,
        errorNode,
        matchResults,
        constraints ?? new ConstraintTracker(),
        skipUnknownArgCheck,
        makeInferenceContext(
            inferenceContext?.expectedType,
            inferenceContext?.isTypeIncomplete,
            inferenceContext?.returnTypeOverride
        )
    );
}

export function getBestOverloadForArgs(
    evaluator: TypeEvaluator,
    state: TypeEvaluatorState,
    registry: TypeRegistry,
    errorNode: ExpressionNode,
    typeResult: TypeResult<OverloadedType>,
    argList: Arg[]
): FunctionType | undefined {
    let overloadIndex = 0;
    const matches: MatchArgsToParamsResult[] = [];
    const speculativeNode = getSpeculativeNodeForCall(errorNode);

    state.useSignatureTracker(errorNode, () => {
        OverloadedType.getOverloads(typeResult.type).forEach((overload) => {
            state.useSpeculativeMode(speculativeNode, () => {
                const matchResults = matchArgsToParams(
                    evaluator,
                    state,
                    registry,
                    errorNode,
                    argList,
                    { type: overload, isIncomplete: typeResult.isIncomplete },
                    overloadIndex
                );

                if (!matchResults.argumentErrors) {
                    matches.push(matchResults);
                }

                overloadIndex++;
            });
        });
    });

    let winningOverloadIndex: number | undefined;

    matches.forEach((match, matchIndex) => {
        if (winningOverloadIndex === undefined) {
            state.useSpeculativeMode(speculativeNode, () => {
                const callResult = validateArgTypes(
                    evaluator,
                    state,
                    registry,
                    errorNode,
                    match,
                    new ConstraintTracker(),
                    /* skipUnknownArgCheck */ true
                );

                if (callResult && !callResult.argumentErrors) {
                    winningOverloadIndex = matchIndex;
                }
            });
        }
    });

    return winningOverloadIndex === undefined ? undefined : matches[winningOverloadIndex].overload;
}

const maxTotalOverloadArgTypeExpansionCount = 256;

export function validateOverloadsWithExpandedTypes(
    evaluator: TypeEvaluator,
    state: TypeEvaluatorState,
    registry: TypeRegistry,
    errorNode: ExpressionNode,
    expandedArgTypes: (Type | undefined)[][],
    argParamMatches: MatchArgsToParamsResult[],
    constraints: ConstraintTracker | undefined,
    skipUnknownArgCheck: boolean | undefined,
    inferenceContext: InferenceContext | undefined
): CallResult {
    const returnTypes: Type[] = [];
    let matchedOverloads: MatchedOverloadInfo[] = [];
    let isTypeIncomplete = false;
    let overloadsUsedForCall: FunctionType[] = [];
    let isDefinitiveMatchFound = false;
    const speculativeNode = getSpeculativeNodeForCall(errorNode);

    for (let expandedTypesIndex = 0; expandedTypesIndex < expandedArgTypes.length; expandedTypesIndex++) {
        let matchedOverload: FunctionType | undefined;
        const argTypeOverride = expandedArgTypes[expandedTypesIndex];
        const hasArgTypeOverride = argTypeOverride.some((a) => a !== undefined);
        let possibleMatchResults: MatchedOverloadInfo[] = [];
        let possibleMatchInvolvesIncompleteUnknown = false;
        isDefinitiveMatchFound = false;

        for (let overloadIndex = 0; overloadIndex < argParamMatches.length; overloadIndex++) {
            const overload = argParamMatches[overloadIndex].overload;

            let matchResults = argParamMatches[overloadIndex];
            if (hasArgTypeOverride) {
                matchResults = { ...argParamMatches[overloadIndex] };
                matchResults.argParams = matchResults.argParams.map((argParam, argIndex) => {
                    if (!argTypeOverride[argIndex]) {
                        return argParam;
                    }
                    const argParamCopy = { ...argParam };
                    argParamCopy.argType = argTypeOverride[argIndex];
                    return argParamCopy;
                });
            }

            const effectiveConstraints = constraints?.clone() ?? new ConstraintTracker();

            const callResult = state.useSpeculativeMode(speculativeNode, () => {
                return validateArgTypesWithContext(
                    evaluator,
                    state,
                    registry,
                    errorNode,
                    matchResults,
                    effectiveConstraints,
                    /* skipUnknownArgCheck */ true,
                    inferenceContext
                );
            });

            if (callResult.isTypeIncomplete) {
                isTypeIncomplete = true;
            }

            if (!callResult.argumentErrors && callResult.returnType) {
                overloadsUsedForCall.push(overload);

                matchedOverload = overload;
                const matchedOverloadInfo: MatchedOverloadInfo = {
                    overload: matchedOverload,
                    matchResults,
                    constraints: effectiveConstraints,
                    returnType: callResult.returnType,
                    argResults: callResult.argResults ?? [],
                };
                matchedOverloads.push(matchedOverloadInfo);

                if (callResult.anyOrUnknownArg || matchResults.unpackedArgOfUnknownLength) {
                    possibleMatchResults.push(matchedOverloadInfo);

                    if (callResult.anyOrUnknownArg) {
                        if (isIncompleteUnknown(callResult.anyOrUnknownArg)) {
                            possibleMatchInvolvesIncompleteUnknown = true;
                        }
                    }
                } else {
                    returnTypes.push(callResult.returnType);
                    isDefinitiveMatchFound = true;
                    break;
                }
            }
        }

        if (!isDefinitiveMatchFound && possibleMatchResults.length > 0) {
            possibleMatchResults = filterOverloadMatchesForUnpackedArgs(possibleMatchResults);
            possibleMatchResults = filterOverloadMatchesForAnyArgs(possibleMatchResults);

            if (possibleMatchResults.length === 1) {
                overloadsUsedForCall = [possibleMatchResults[0].overload];
                returnTypes.push(possibleMatchResults[0].returnType);
                matchedOverloads = [possibleMatchResults[0]];
            } else {
                let dedupedMatchResults: Type[] = [];
                let dedupedResultsIncludeAny = false;

                possibleMatchResults.forEach((result) => {
                    let isSubtypeSubsumed = false;

                    for (let dedupedIndex = 0; dedupedIndex < dedupedMatchResults.length; dedupedIndex++) {
                        if (evaluator.assignType(dedupedMatchResults[dedupedIndex], result.returnType)) {
                            const anyOrUnknown = containsAnyOrUnknown(
                                dedupedMatchResults[dedupedIndex],
                                /* recurse */ false
                            );
                            if (!anyOrUnknown) {
                                isSubtypeSubsumed = true;
                            } else if (isAny(anyOrUnknown)) {
                                dedupedResultsIncludeAny = true;
                            }
                            break;
                        } else if (evaluator.assignType(result.returnType, dedupedMatchResults[dedupedIndex])) {
                            const anyOrUnknown = containsAnyOrUnknown(result.returnType, /* recurse */ false);
                            if (!anyOrUnknown) {
                                dedupedMatchResults[dedupedIndex] = NeverType.createNever();
                            } else if (isAny(anyOrUnknown)) {
                                dedupedResultsIncludeAny = true;
                            }
                            break;
                        }
                    }

                    if (!isSubtypeSubsumed) {
                        dedupedMatchResults.push(result.returnType);
                    }
                });

                dedupedMatchResults = dedupedMatchResults.filter((t) => !isNever(t));
                const combinedTypes = combineTypes(dedupedMatchResults);

                let returnType = combinedTypes;
                if (dedupedMatchResults.length > 1) {
                    if (dedupedResultsIncludeAny) {
                        returnType = AnyType.create();
                    } else {
                        returnType = UnknownType.createPossibleType(
                            combinedTypes,
                            possibleMatchInvolvesIncompleteUnknown
                        );
                    }
                }

                returnTypes.push(returnType);
            }
        }

        if (!matchedOverload) {
            return { argumentErrors: true, isTypeIncomplete, overloadsUsedForCall };
        }
    }

    if (constraints && isDefinitiveMatchFound) {
        constraints.copyFromClone(matchedOverloads[matchedOverloads.length - 1].constraints);
    }

    const finalConstraints = constraints ?? matchedOverloads[0].constraints;
    const finalCallResult = validateArgTypesWithContext(
        evaluator,
        state,
        registry,
        errorNode,
        matchedOverloads[0].matchResults,
        finalConstraints,
        skipUnknownArgCheck,
        inferenceContext
    );

    if (finalCallResult.isTypeIncomplete) {
        isTypeIncomplete = true;
    }

    return {
        argumentErrors: finalCallResult.argumentErrors,
        anyOrUnknownArg: finalCallResult.anyOrUnknownArg,
        returnType: combineTypes(returnTypes),
        isTypeIncomplete,
        specializedInitSelfType: finalCallResult.specializedInitSelfType,
        overloadsUsedForCall,
    };
}

export function validateOverloadedArgTypes(
    evaluator: TypeEvaluator,
    state: TypeEvaluatorState,
    registry: TypeRegistry,
    errorNode: ExpressionNode,
    argList: Arg[],
    typeResult: TypeResult<OverloadedType>,
    constraints: ConstraintTracker | undefined,
    skipUnknownArgCheck: boolean | undefined,
    inferenceContext: InferenceContext | undefined
): CallResult {
    const filteredMatchResults: MatchArgsToParamsResult[] = [];
    let contextFreeArgTypes: Type[] | undefined;
    let isTypeIncomplete = !!typeResult.isIncomplete;
    const type = typeResult.type;
    const speculativeNode = getSpeculativeNodeForCall(errorNode);

    state.useSpeculativeMode(speculativeNode, () => {
        let overloadIndex = 0;
        OverloadedType.getOverloads(type).forEach((overload) => {
            const matchResults = matchArgsToParams(
                evaluator,
                state,
                registry,
                errorNode,
                argList,
                { type: overload, isIncomplete: typeResult.isIncomplete },
                overloadIndex
            );

            if (!matchResults.argumentErrors) {
                filteredMatchResults.push(matchResults);
            }

            overloadIndex++;
        });
    });

    if (filteredMatchResults.length === 0) {
        if (!state.canSkipDiagnosticForNode(errorNode)) {
            const overloads = OverloadedType.getOverloads(type);
            const functionName =
                overloads.length > 0 && overloads[0].shared.name
                    ? overloads[0].shared.name
                    : '<anonymous function>';
            const diagAddendum = new DiagnosticAddendum();
            const argTypes = argList.map((t) => {
                const typeString = evaluator.printType(getTypeOfArg(evaluator, t, /* inferenceContext */ undefined).type);

                if (t.argCategory === ArgCategory.UnpackedList) {
                    return `*${typeString}`;
                }

                if (t.argCategory === ArgCategory.UnpackedDictionary) {
                    return `**${typeString}`;
                }

                return typeString;
            });

            diagAddendum.addMessage(LocAddendum.argumentTypes().format({ types: argTypes.join(', ') }));
            evaluator.addDiagnostic(
                DiagnosticRule.reportCallIssue,
                LocMessage.noOverload().format({ name: functionName }) + diagAddendum.getString(),
                errorNode
            );
        }

        return { argumentErrors: true, isTypeIncomplete, overloadsUsedForCall: [] };
    }

    function evaluateUsingBestMatchingOverload(skipUnknownArgCheck: boolean, emitNoOverloadFoundError: boolean) {
        const bestMatch = filteredMatchResults.reduce((previous, current) => {
            if (current.argumentMatchScore === previous.argumentMatchScore) {
                return current.overloadIndex > previous.overloadIndex ? current : previous;
            }
            return current.argumentMatchScore < previous.argumentMatchScore ? current : previous;
        });

        if (emitNoOverloadFoundError) {
            const functionName = bestMatch.overload.shared.name || '<anonymous function>';
            const diagnostic = evaluator.addDiagnostic(
                DiagnosticRule.reportCallIssue,
                LocMessage.noOverload().format({ name: functionName }),
                errorNode
            );

            const overrideDecl = bestMatch.overload.shared.declaration;
            if (diagnostic && overrideDecl) {
                diagnostic.addRelatedInfo(
                    LocAddendum.overloadIndex().format({ index: bestMatch.overloadIndex + 1 }),
                    overrideDecl.uri,
                    overrideDecl.range
                );
            }
        }

        const effectiveConstraints = constraints ?? new ConstraintTracker();

        return validateArgTypesWithContext(
            evaluator,
            state,
            registry,
            errorNode,
            bestMatch,
            effectiveConstraints,
            skipUnknownArgCheck,
            inferenceContext
        );
    }

    if (filteredMatchResults.length === 1) {
        return evaluateUsingBestMatchingOverload(
            /* skipUnknownArgCheck */ false,
            /* emitNoOverloadFoundError */ false
        );
    }

    let expandedArgTypes: (Type | undefined)[][] | undefined = [argList.map(() => undefined)];

    while (true) {
        const callResult = validateOverloadsWithExpandedTypes(
            evaluator,
            state,
            registry,
            errorNode,
            expandedArgTypes,
            filteredMatchResults,
            constraints,
            skipUnknownArgCheck,
            inferenceContext
        );

        if (callResult.isTypeIncomplete) {
            isTypeIncomplete = true;
        }

        if (!callResult.argumentErrors) {
            return callResult;
        }

        if (!contextFreeArgTypes) {
            state.useSpeculativeMode(getSpeculativeNodeForCall(errorNode), () => {
                contextFreeArgTypes = argList.map((arg) => {
                    if (arg.typeResult) {
                        return arg.typeResult.type;
                    }

                    if (arg.valueExpression) {
                        const valueExpressionNode = arg.valueExpression;
                        return state.useSpeculativeMode(valueExpressionNode, () => {
                            return evaluator.getTypeOfExpression(valueExpressionNode).type;
                        });
                    }

                    return AnyType.create();
                });
            });
        }

        expandedArgTypes = expandArgTypes(evaluator, contextFreeArgTypes!, expandedArgTypes);

        if (!expandedArgTypes || expandedArgTypes.length > maxTotalOverloadArgTypeExpansionCount) {
            break;
        }
    }

    if (!state.canSkipDiagnosticForNode(errorNode) && !isTypeIncomplete) {
        const result = evaluateUsingBestMatchingOverload(
            /* skipUnknownArgCheck */ true,
            /* emitNoOverloadFoundError */ true
        );

        result.returnType = UnknownType.create();
        return { ...result, argumentErrors: true };
    }

    return { argumentErrors: true, isTypeIncomplete, overloadsUsedForCall: [] };
}

export function validateCallForFunction(
    evaluator: TypeEvaluator,
    state: TypeEvaluatorState,
    registry: TypeRegistry,
    errorNode: ExpressionNode,
    argList: Arg[],
    type: FunctionType,
    isCallTypeIncomplete: boolean,
    constraints: ConstraintTracker | undefined,
    skipUnknownArgCheck: boolean | undefined,
    inferenceContext: InferenceContext | undefined
): CallResult {
    if (TypeBase.isInstantiable(type)) {
        evaluator.addDiagnostic(
            DiagnosticRule.reportCallIssue,
            LocMessage.callableNotInstantiable().format({
                type: evaluator.printType(type),
            }),
            errorNode
        );
        return { returnType: undefined, argumentErrors: true };
    }

    if (FunctionType.isBuiltIn(type, 'namedtuple')) {
        evaluator.addDiagnostic(DiagnosticRule.reportUntypedNamedTuple, LocMessage.namedTupleNoTypes(), errorNode);

        const result: CallResult = {
            returnType: createNamedTupleType(evaluator, errorNode, argList, /* includesTypes */ false),
        };

        validateArgs(evaluator, state, registry, errorNode, argList, { type }, constraints, skipUnknownArgCheck, inferenceContext);

        return result;
    }

    if (FunctionType.isBuiltIn(type, 'NewType')) {
        return { returnType: specialForms.createNewType(evaluator, errorNode, argList, registry) };
    }

    const functionResult = validateArgs(
        evaluator,
        state,
        registry,
        errorNode,
        argList,
        { type, isIncomplete: isCallTypeIncomplete },
        constraints,
        skipUnknownArgCheck,
        inferenceContext
    );

    let isTypeIncomplete = !!functionResult.isTypeIncomplete;
    let returnType = functionResult.returnType;

    let argumentErrors = !!functionResult.argumentErrors;
    if (!argumentErrors) {
        const transformed = applyFunctionTransform(evaluator, errorNode, argList, type, {
            argumentErrors: !!functionResult.argumentErrors,
            returnType: functionResult.returnType ?? UnknownType.create(isTypeIncomplete),
            isTypeIncomplete,
        });

        returnType = transformed.returnType;
        if (transformed.isTypeIncomplete) {
            isTypeIncomplete = true;
        }
        if (transformed.argumentErrors) {
            argumentErrors = true;
        }
    }

    if (FunctionType.isBuiltIn(type, '__import__')) {
        returnType = AnyType.create();
    }

    return {
        returnType,
        isTypeIncomplete,
        argumentErrors,
        overloadsUsedForCall: functionResult.overloadsUsedForCall,
        specializedInitSelfType: functionResult.specializedInitSelfType,
    };
}

export function evaluateCastCall(evaluator: TypeEvaluator, argList: Arg[], errorNode: ExpressionNode) {
    if (argList[0].argCategory !== ArgCategory.Simple && argList[0].valueExpression) {
        evaluator.addDiagnostic(
            DiagnosticRule.reportInvalidTypeForm,
            LocMessage.unpackInAnnotation(),
            argList[0].valueExpression
        );
    }

    let castToType = getTypeOfArgExpectingType(evaluator, argList[0], { typeExpression: true }).type;

    const liveScopeIds = ParseTreeUtils.getTypeVarScopesForNode(errorNode);
    castToType = makeTypeVarsBound(castToType, liveScopeIds);

    let castFromType = getTypeOfArg(evaluator, argList[1], /* inferenceContext */ undefined).type;

    if (castFromType.props?.specialForm) {
        castFromType = castFromType.props.specialForm;
    }

    if (TypeBase.isInstantiable(castToType) && !isUnknown(castToType)) {
        if (
            isTypeSame(convertToInstance(castToType), castFromType, {
                ignorePseudoGeneric: true,
            })
        ) {
            evaluator.addDiagnostic(
                DiagnosticRule.reportUnnecessaryCast,
                LocMessage.unnecessaryCast().format({
                    type: evaluator.printType(castFromType),
                }),
                errorNode
            );
        }
    }

    return convertToInstance(castToType);
}

export function validateCallForOverloaded(
    evaluator: TypeEvaluator,
    state: TypeEvaluatorState,
    registry: TypeRegistry,
    errorNode: ExpressionNode,
    argList: Arg[],
    expandedCallType: OverloadedType,
    isCallTypeIncomplete: boolean,
    constraints: ConstraintTracker | undefined,
    skipUnknownArgCheck: boolean | undefined,
    inferenceContext: InferenceContext | undefined
): CallResult {
    const overloads = OverloadedType.getOverloads(expandedCallType);
    if (
        overloads.length > 0 &&
        FunctionType.isBuiltIn(overloads[0], ['typing.cast', 'typing_extensions.cast']) &&
        argList.length === 2
    ) {
        return { returnType: evaluateCastCall(evaluator, argList, errorNode) };
    }

    const callResult = validateOverloadedArgTypes(
        evaluator,
        state,
        registry,
        errorNode,
        argList,
        { type: expandedCallType, isIncomplete: isCallTypeIncomplete },
        constraints,
        skipUnknownArgCheck,
        inferenceContext
    );

    let returnType = callResult.returnType ?? UnknownType.create();
    let isTypeIncomplete = !!callResult.isTypeIncomplete;
    let argumentErrors = !!callResult.argumentErrors;

    if (!argumentErrors) {
        const transformed = applyFunctionTransform(evaluator, errorNode, argList, expandedCallType, {
            argumentErrors: !!callResult.argumentErrors,
            returnType: callResult.returnType ?? UnknownType.create(isTypeIncomplete),
            isTypeIncomplete,
        });

        returnType = transformed.returnType;
        if (transformed.isTypeIncomplete) {
            isTypeIncomplete = true;
        }

        if (transformed.argumentErrors) {
            argumentErrors = true;
        }
    }

    return {
        returnType,
        isTypeIncomplete,
        argumentErrors,
        overloadsUsedForCall: callResult.overloadsUsedForCall,
        specializedInitSelfType: callResult.specializedInitSelfType,
    };
}

export function printSrcDestTypes(
    evaluator: TypeEvaluator,
    srcType: Type,
    destType: Type,
    options?: PrintTypeOptions
): { sourceType: string; destType: string } {
    const simpleSrcType = evaluator.printType(srcType, options);
    const simpleDestType = evaluator.printType(destType, options);

    if (simpleSrcType !== simpleDestType) {
        return { sourceType: simpleSrcType, destType: simpleDestType };
    }

    const fullSrcType = evaluator.printType(srcType, { ...(options ?? {}), useFullyQualifiedNames: true });
    const fullDestType = evaluator.printType(destType, { ...(options ?? {}), useFullyQualifiedNames: true });

    if (fullSrcType !== fullDestType) {
        return { sourceType: fullSrcType, destType: fullDestType };
    }

    return { sourceType: simpleSrcType, destType: simpleDestType };
}

export function getTypeOfAssertType(
    evaluator: TypeEvaluator,
    node: CallNode,
    inferenceContext: InferenceContext | undefined
): TypeResult {
    if (
        node.d.args.length !== 2 ||
        node.d.args[0].d.argCategory !== ArgCategory.Simple ||
        node.d.args[0].d.name !== undefined ||
        node.d.args[0].d.argCategory !== ArgCategory.Simple ||
        node.d.args[1].d.name !== undefined
    ) {
        evaluator.addDiagnostic(DiagnosticRule.reportCallIssue, LocMessage.assertTypeArgs(), node);
        return { type: UnknownType.create() };
    }

    const arg0TypeResult = evaluator.getTypeOfExpression(node.d.args[0].d.valueExpr, /* flags */ undefined, inferenceContext);
    if (arg0TypeResult.isIncomplete) {
        return { type: UnknownType.create(/* isIncomplete */ true), isIncomplete: true };
    }

    const assertedType = convertToInstance(
        getTypeOfArgExpectingType(evaluator, convertNodeToArg(node.d.args[1]), {
            typeExpression: true,
        }).type
    );

    const arg0Type = evaluator.stripTypeGuard(arg0TypeResult.type);

    if (
        !isTypeSame(assertedType, arg0Type, {
            treatAnySameAsUnknown: true,
            ignorePseudoGeneric: true,
            ignoreConditions: true,
        })
    ) {
        const srcDestTypes = printSrcDestTypes(evaluator, arg0TypeResult.type, assertedType, { expandTypeAlias: true });

        evaluator.addDiagnostic(
            DiagnosticRule.reportAssertTypeFailure,
            LocMessage.assertTypeTypeMismatch().format({
                expected: srcDestTypes.destType,
                received: srcDestTypes.sourceType,
            }),
            node.d.args[0].d.valueExpr
        );
    }

    return { type: arg0TypeResult.type };
}

export function validateCallForInstantiableClass(
    evaluator: TypeEvaluator,
    state: TypeEvaluatorState,
    registry: TypeRegistry,
    errorNode: ExpressionNode,
    argList: Arg[],
    expandedCallType: ClassType,
    unexpandedCallType: Type,
    skipUnknownArgCheck: boolean | undefined,
    inferenceContext: InferenceContext | undefined
): CallResult {
    if (expandedCallType.priv.literalValue !== undefined) {
        evaluator.addDiagnostic(DiagnosticRule.reportCallIssue, LocMessage.literalNotCallable(), errorNode);
        return { returnType: UnknownType.create(), argumentErrors: true };
    }

    if (ClassType.isBuiltIn(expandedCallType)) {
        const className = expandedCallType.priv.aliasName ?? expandedCallType.shared.name;

        if (isInstantiableMetaclass(expandedCallType)) {
            if (expandedCallType.priv.typeArgs && expandedCallType.priv.isTypeArgExplicit) {
                evaluator.addDiagnostic(
                    DiagnosticRule.reportCallIssue,
                    LocMessage.objectNotCallable().format({ type: evaluator.printType(expandedCallType) }),
                    errorNode
                );
                return { returnType: UnknownType.create(), argumentErrors: true };
            }

            validateConstructorArgs(evaluator, errorNode, argList, expandedCallType, skipUnknownArgCheck, inferenceContext);

            if (expandedCallType.shared.name === 'type' && argList.length === 1) {
                const argTypeResult = getTypeOfArg(evaluator, argList[0], /* inferenceContext */ undefined);
                const argType = argTypeResult.type;
                const returnType = mapSubtypes(argType, (subtype) => {
                    if (isNever(subtype)) {
                        return subtype;
                    }

                    if (isClass(subtype)) {
                        if (
                            isClassInstance(subtype) &&
                            ClassType.isNewTypeClass(subtype) &&
                            !subtype.priv.includeSubclasses
                        ) {
                            if (registry.functionClass) {
                                return registry.functionClass;
                            }
                        }

                        return convertToInstantiable(evaluator.stripLiteralValue(subtype));
                    }

                    if (TypeBase.isInstance(subtype)) {
                        if (isFunction(subtype) || isTypeVar(subtype)) {
                            return convertToInstantiable(subtype);
                        }
                    }

                    return ClassType.specialize(ClassType.cloneAsInstance(expandedCallType), [UnknownType.create()]);
                });

                return { returnType, isTypeIncomplete: argTypeResult.isIncomplete };
            }

            if (argList.length >= 2) {
                return {
                    returnType:
                        specialForms.createClassFromMetaclass(evaluator, errorNode, argList, expandedCallType) ||
                        AnyType.create(),
                };
            }

            return { returnType: AnyType.create() };
        }

        if (className === 'TypeVar') {
            return { returnType: specialForms.createTypeVarType(evaluator, errorNode, expandedCallType, argList) };
        }

        if (className === 'TypeVarTuple') {
            return { returnType: specialForms.createTypeVarTupleType(evaluator, errorNode, expandedCallType, argList) };
        }

        if (className === 'ParamSpec') {
            return { returnType: specialForms.createParamSpecType(evaluator, errorNode, expandedCallType, argList) };
        }

        if (className === 'TypeAliasType') {
            const newTypeAlias = specialForms.createTypeAliasType(evaluator, errorNode, argList);
            if (newTypeAlias) {
                return { returnType: newTypeAlias };
            }
        }

        if (className === 'NamedTuple') {
            const result: CallResult = {
                returnType: createNamedTupleType(evaluator, errorNode, argList, /* includesTypes */ true),
            };

            const initTypeResult = getBoundInitMethod(
                evaluator,
                errorNode,
                ClassType.cloneAsInstance(expandedCallType),
                /* diag */ undefined,
                /* additionalFlags */ MemberAccessFlags.Default
            );

            if (initTypeResult && isOverloaded(initTypeResult.type)) {
                validateOverloadedArgTypes(
                    evaluator,
                    state,
                    registry,
                    errorNode,
                    argList,
                    { type: initTypeResult.type },
                    /* constraints */ undefined,
                    skipUnknownArgCheck,
                    /* inferenceContext */ undefined
                );
            }

            return result;
        }

        if (className === 'NewType') {
            return { returnType: specialForms.createNewType(evaluator, errorNode, argList, registry) };
        }

        if (className === 'Sentinel') {
            if (AnalyzerNodeInfo.getFileInfo(errorNode).diagnosticRuleSet.enableExperimentalFeatures) {
                return { returnType: createSentinelType(evaluator, errorNode, argList) };
            }
        }

        if (ClassType.isSpecialFormClass(expandedCallType)) {
            evaluator.addDiagnostic(
                DiagnosticRule.reportCallIssue,
                LocMessage.typeNotIntantiable().format({ type: className }),
                errorNode
            );
            return { returnType: UnknownType.create(), argumentErrors: true };
        }

        if (className === 'TypedDict') {
            return { returnType: createTypedDictType(evaluator, errorNode, expandedCallType, argList) };
        }

        if (className === 'auto' && argList.length === 0) {
            return { returnType: getEnumAutoValueType(evaluator, errorNode) };
        }
    }

    if (
        isClass(expandedCallType) &&
        expandedCallType.shared.effectiveMetaclass &&
        isClass(expandedCallType.shared.effectiveMetaclass) &&
        isEnumMetaclass(expandedCallType.shared.effectiveMetaclass) &&
        !isEnumClassWithMembers(evaluator, expandedCallType)
    ) {
        return {
            returnType:
                createEnumType(evaluator, errorNode, expandedCallType, argList) ??
                convertToInstance(unexpandedCallType),
        };
    }

    if (ClassType.supportsAbstractMethods(expandedCallType)) {
        const abstractSymbols = symbolResolution.getAbstractSymbols(evaluator, expandedCallType);

        if (
            abstractSymbols.length > 0 &&
            !expandedCallType.priv.includeSubclasses &&
            !isTypeVar(unexpandedCallType)
        ) {
            const diagAddendum = new DiagnosticAddendum();
            const errorsToDisplay = 2;

            abstractSymbols.forEach((abstractMethod, index) => {
                if (index === errorsToDisplay) {
                    diagAddendum.addMessage(
                        LocAddendum.memberIsAbstractMore().format({
                            count: abstractSymbols.length - errorsToDisplay,
                        })
                    );
                } else if (index < errorsToDisplay) {
                    if (isInstantiableClass(abstractMethod.classType)) {
                        const className = abstractMethod.classType.shared.name;
                        diagAddendum.addMessage(
                            LocAddendum.memberIsAbstract().format({
                                type: className,
                                name: abstractMethod.symbolName,
                            })
                        );
                    }
                }
            });

            evaluator.addDiagnostic(
                DiagnosticRule.reportAbstractUsage,
                LocMessage.instantiateAbstract().format({
                    type: expandedCallType.shared.name,
                }) + diagAddendum.getString(),
                errorNode
            );
        }
    }

    if (ClassType.isProtocolClass(expandedCallType) && !expandedCallType.priv.includeSubclasses) {
        evaluator.addDiagnostic(
            DiagnosticRule.reportAbstractUsage,
            LocMessage.instantiateProtocol().format({ type: expandedCallType.shared.name }),
            errorNode
        );
    }

    const constructorResult = validateConstructorArgs(
        evaluator,
        errorNode,
        argList,
        expandedCallType,
        skipUnknownArgCheck,
        inferenceContext
    );

    const overloadsUsedForCall = constructorResult.overloadsUsedForCall;
    const argumentErrors = constructorResult.argumentErrors;
    const isTypeIncomplete = constructorResult.isTypeIncomplete;

    let returnType = constructorResult.returnType;

    if (isTypeVar(unexpandedCallType)) {
        returnType = convertToInstance(unexpandedCallType);
    }

    if (
        errorNode.nodeType === ParseNodeType.Call &&
        returnType &&
        isClassInstance(returnType) &&
        ClassType.isBuiltIn(returnType, 'deprecated')
    ) {
        returnType = ClassType.cloneForDeprecatedInstance(returnType, getDeprecatedMessageFromCall(errorNode as CallNode));
    }

    if (
        returnType &&
        isClassInstance(returnType) &&
        returnType.shared.mro.some(
            (baseClass) => isInstantiableClass(baseClass) && ClassType.isBuiltIn(baseClass, 'type')
        )
    ) {
        let newClassName = '__class_' + returnType.shared.name;
        if (argList.length === 3) {
            const firstArgType = getTypeOfArg(evaluator, argList[0], /* inferenceContext */ undefined).type;

            if (
                isClassInstance(firstArgType) &&
                ClassType.isBuiltIn(firstArgType, 'str') &&
                typeof firstArgType.priv.literalValue === 'string'
            ) {
                newClassName = firstArgType.priv.literalValue;
            }
        }

        const newClassType = ClassType.createInstantiable(
            newClassName,
            '',
            '',
            AnalyzerNodeInfo.getFileInfo(errorNode).fileUri,
            ClassTypeFlags.None,
            ParseTreeUtils.getTypeSourceId(errorNode),
            ClassType.cloneAsInstantiable(returnType),
            ClassType.cloneAsInstantiable(returnType)
        );
        newClassType.shared.baseClasses.push(evaluator.getBuiltInType(errorNode, 'object'));
        newClassType.shared.effectiveMetaclass = expandedCallType;
        newClassType.shared.declaration = returnType.shared.declaration;

        computeMroLinearization(newClassType);
        returnType = newClassType;
    }

    return { returnType, overloadsUsedForCall, argumentErrors, isTypeIncomplete };
}

export function validateCallForClassInstance(
    evaluator: TypeEvaluator,
    errorNode: ExpressionNode,
    argList: Arg[],
    expandedCallType: ClassType,
    unexpandedCallType: Type,
    constraints: ConstraintTracker | undefined,
    skipUnknownArgCheck: boolean | undefined,
    inferenceContext: InferenceContext | undefined,
    recursionCount: number
): CallResult {
    const callDiag = new DiagnosticAddendum();
    const callMethodResult = evaluator.getTypeOfBoundMember(
        errorNode,
        expandedCallType,
        '__call__',
        /* usage */ undefined,
        callDiag,
        MemberAccessFlags.SkipInstanceMembers | MemberAccessFlags.SkipAttributeAccessOverride
    );
    const callMethodType = callMethodResult?.type;

    if (!callMethodType || callMethodResult.typeErrors) {
        evaluator.addDiagnostic(
            DiagnosticRule.reportCallIssue,
            LocMessage.objectNotCallable().format({
                type: evaluator.printType(expandedCallType),
            }) + callDiag.getString(),
            errorNode
        );

        return { returnType: UnknownType.create(), argumentErrors: true };
    }

    const callResult = evaluator.validateCallArgs(
        errorNode,
        argList,
        { type: callMethodType },
        constraints,
        skipUnknownArgCheck,
        inferenceContext
    );

    let returnType = callResult.returnType ?? UnknownType.create();
    if (
        isTypeVar(unexpandedCallType) &&
        TypeBase.isInstantiable(unexpandedCallType) &&
        isClass(expandedCallType) &&
        ClassType.isBuiltIn(expandedCallType, 'type')
    ) {
        returnType = convertToInstance(unexpandedCallType);
    }

    return {
        returnType,
        argumentErrors: callResult.argumentErrors,
        overloadsUsedForCall: callResult.overloadsUsedForCall,
    };
}

export function validateCallArgsForSubtype(
    evaluator: TypeEvaluator,
    state: TypeEvaluatorState,
    registry: TypeRegistry,
    errorNode: ExpressionNode,
    argList: Arg[],
    expandedCallType: Type,
    unexpandedCallType: Type,
    isCallTypeIncomplete: boolean,
    constraints: ConstraintTracker | undefined,
    skipUnknownArgCheck: boolean | undefined,
    inferenceContext: InferenceContext | undefined,
    recursionCount: number
): CallResult {
    function touchArgTypes() {
        if (!isCallTypeIncomplete) {
            argList.forEach((arg) => {
                if (arg.valueExpression && !state.isSpeculativeModeInUse(arg.valueExpression)) {
                    getTypeOfArg(evaluator, arg, /* inferenceContext */ undefined);
                }
            });
        }
    }

    switch (expandedCallType.category) {
        case TypeCategory.Never:
        case TypeCategory.Unknown:
        case TypeCategory.Any: {
            const dummyFunctionType = FunctionType.createInstance('', '', '', FunctionTypeFlags.None);
            FunctionType.addDefaultParams(dummyFunctionType);

            const dummyCallResult = validateCallForFunction(
                evaluator,
                state,
                registry,
                errorNode,
                argList,
                dummyFunctionType,
                isCallTypeIncomplete,
                constraints,
                skipUnknownArgCheck,
                inferenceContext
            );

            return { ...dummyCallResult, returnType: expandedCallType };
        }

        case TypeCategory.Function: {
            return validateCallForFunction(
                evaluator,
                state,
                registry,
                errorNode,
                argList,
                expandedCallType,
                isCallTypeIncomplete,
                constraints,
                skipUnknownArgCheck,
                inferenceContext
            );
        }

        case TypeCategory.Overloaded: {
            return validateCallForOverloaded(
                evaluator,
                state,
                registry,
                errorNode,
                argList,
                expandedCallType,
                isCallTypeIncomplete,
                constraints,
                skipUnknownArgCheck,
                inferenceContext
            );
        }

        case TypeCategory.Class: {
            if (isNoneInstance(expandedCallType)) {
                evaluator.addDiagnostic(DiagnosticRule.reportOptionalCall, LocMessage.noneNotCallable(), errorNode);

                touchArgTypes();
                return { argumentErrors: true };
            }

            if (TypeBase.isInstantiable(expandedCallType)) {
                return validateCallForInstantiableClass(
                    evaluator,
                    state,
                    registry,
                    errorNode,
                    argList,
                    expandedCallType,
                    unexpandedCallType,
                    skipUnknownArgCheck,
                    inferenceContext
                );
            }

            return validateCallForClassInstance(
                evaluator,
                errorNode,
                argList,
                expandedCallType,
                unexpandedCallType,
                constraints,
                skipUnknownArgCheck,
                inferenceContext,
                recursionCount
            );
        }

        case TypeCategory.TypeVar: {
            return evaluator.validateCallArgs(
                errorNode,
                argList,
                { type: transformPossibleRecursiveTypeAlias(expandedCallType), isIncomplete: isCallTypeIncomplete },
                constraints,
                skipUnknownArgCheck,
                inferenceContext
            );
        }

        case TypeCategory.Module: {
            evaluator.addDiagnostic(DiagnosticRule.reportCallIssue, LocMessage.moduleNotCallable(), errorNode);

            touchArgTypes();
            return { argumentErrors: true };
        }
    }

    touchArgTypes();
    return { argumentErrors: true };
}

export function validateInitSubclassArgs(
    evaluator: TypeEvaluator,
    state: TypeEvaluatorState,
    registry: TypeRegistry,
    node: ClassNode,
    classType: ClassType
) {
    const argList: Arg[] = [];

    node.d.arguments.forEach((arg) => {
        if (arg.d.name && arg.d.name.d.value !== 'metaclass') {
            argList.push({
                argCategory: ArgCategory.Simple,
                node: arg,
                name: arg.d.name,
                valueExpression: arg.d.valueExpr,
            });
        }
    });

    let newMethodMember: ClassMember | undefined;

    if (classType.shared.effectiveMetaclass && isClass(classType.shared.effectiveMetaclass)) {
        const metaclassCallsInitSubclass =
            ClassType.isBuiltIn(classType.shared.effectiveMetaclass, ['ABCMeta', 'type']) &&
            !ClassType.isTypedDictClass(classType);

        if (!metaclassCallsInitSubclass) {
            newMethodMember = lookUpClassMember(
                classType.shared.effectiveMetaclass,
                '__new__',
                MemberAccessFlags.SkipTypeBaseClass
            );
        }
    }

    if (newMethodMember) {
        const newMethodType = evaluator.getTypeOfMember(newMethodMember);
        if (isFunction(newMethodType)) {
            const paramListDetails = getParamListDetails(newMethodType);

            if (paramListDetails.firstKeywordOnlyIndex !== undefined) {
                const paramMap = new Map<string, number>();
                for (let i = paramListDetails.firstKeywordOnlyIndex; i < paramListDetails.params.length; i++) {
                    const paramInfo = paramListDetails.params[i];
                    if (
                        paramInfo.param.category === ParamCategory.Simple &&
                        paramInfo.param.name &&
                        paramInfo.kind !== ParamKind.Positional
                    ) {
                        paramMap.set(paramInfo.param.name, i);
                    }
                }

                argList.forEach((arg) => {
                    if (arg.argCategory === ArgCategory.Simple && arg.name) {
                        const paramIndex = paramMap.get(arg.name.d.value) ?? paramListDetails.kwargsIndex;

                        if (paramIndex !== undefined) {
                            const paramInfo = paramListDetails.params[paramIndex];
                            const argParam: ValidateArgTypeParams = {
                                paramCategory: paramInfo.param.category,
                                paramType: paramInfo.type,
                                requiresTypeVarMatching: false,
                                argument: arg,
                                errorNode: arg.valueExpression ?? node.d.name,
                            };

                            validateArgType(
                                evaluator,
                                state,
                                argParam,
                                new ConstraintTracker(),
                                { type: newMethodType },
                                { skipUnknownArgCheck: true }
                            );
                            paramMap.delete(arg.name.d.value);
                        } else {
                            evaluator.addDiagnostic(
                                DiagnosticRule.reportGeneralTypeIssues,
                                LocMessage.paramNameMissing().format({ name: arg.name.d.value }),
                                arg.name ?? node.d.name
                            );
                        }
                    }
                });

                const unassignedParams: string[] = [];
                paramMap.forEach((index, paramName) => {
                    const paramInfo = paramListDetails.params[index];
                    if (!paramInfo.defaultType) {
                        unassignedParams.push(paramName);
                    }
                });

                if (unassignedParams.length > 0) {
                    const missingParamNames = unassignedParams.map((p) => `"${p}"`).join(', ');
                    evaluator.addDiagnostic(
                        DiagnosticRule.reportGeneralTypeIssues,
                        unassignedParams.length === 1
                            ? LocMessage.argMissingForParam().format({ name: missingParamNames })
                            : LocMessage.argMissingForParams().format({ names: missingParamNames }),
                        node.d.name
                    );
                }
            }
        }
    } else {
        const initSubclassMethodInfo = evaluator.getTypeOfBoundMember(
            node.d.name,
            classType,
            '__init_subclass__',
            /* usage */ undefined,
            /* diag */ undefined,
            MemberAccessFlags.SkipClassMembers |
                MemberAccessFlags.SkipOriginalClass |
                MemberAccessFlags.SkipAttributeAccessOverride
        );

        if (initSubclassMethodInfo) {
            const initSubclassMethodType = initSubclassMethodInfo.type;

            if (initSubclassMethodType && initSubclassMethodInfo.classType) {
                const callResult = evaluator.validateCallArgs(
                    node.d.name,
                    argList,
                    { type: initSubclassMethodType },
                    /* constraints */ undefined,
                    /* skipUnknownArgCheck */ false,
                    makeInferenceContext(evaluator.getNoneType())
                );

                if (callResult.argumentErrors) {
                    const diag = evaluator.addDiagnostic(
                        DiagnosticRule.reportGeneralTypeIssues,
                        LocMessage.initSubclassCallFailed(),
                        node.d.name
                    );

                    const initSubclassFunction = isOverloaded(initSubclassMethodType)
                        ? OverloadedType.getOverloads(initSubclassMethodType)[0]
                        : initSubclassMethodType;
                    const initSubclassDecl = isFunction(initSubclassFunction)
                        ? initSubclassFunction.shared.declaration
                        : undefined;

                    if (diag && initSubclassDecl) {
                        diag.addRelatedInfo(
                            LocAddendum.initSubclassLocation().format({
                                name: evaluator.printType(convertToInstance(initSubclassMethodInfo.classType)),
                            }),
                            initSubclassDecl.uri,
                            initSubclassDecl.range
                        );
                    }
                }
            }
        }
    }

    argList.forEach((arg) => {
        if (arg.valueExpression) {
            evaluator.getTypeOfExpression(arg.valueExpression);
        }
    });
}
