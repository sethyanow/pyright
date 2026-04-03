/*
 * callValidation.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 *
 * Functions for call validation, overload resolution, and argument processing,
 * extracted from typeEvaluator.ts.
 */

import { ArgCategory, ArgumentNode, ExpressionNode, ParamCategory, ParameterNode, ParseNode, ParseNodeType } from '../parser/parseNodes';
import {
    getParamListDetails,
    isParamSpecArgs,
    isParamSpecKwargs,
    ParamAssignmentTracker,
    ParamKind,
} from './parameterUtils';
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
import { getTypedDictMembersForClass } from './typedDicts';
import {
    Arg,
    ArgResult,
    ArgWithExpression,
    AssignTypeFlags,
    EvalFlags,
    EvaluatorUsage,
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
    isNever,
    isUnpacked,
    isUnpackedClass,
    isUnpackedTypeVarTuple,
    maxTypeRecursionCount,
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

    // Construct an object that racks which parameters have been assigned arguments.
    const paramTracker = new ParamAssignmentTracker(paramDetails.params);

    let positionalOnlyLimitIndex = paramDetails.positionOnlyParamCount;
    let positionParamLimitIndex = paramDetails.firstKeywordOnlyIndex ?? paramDetails.params.length;

    const varArgListParamIndex = paramDetails.argsIndex;
    const varArgDictParamIndex = paramDetails.kwargsIndex;

    // Is this an function that uses the *args and **kwargs
    // from a param spec? If so, we need to treat all positional parameters
    // prior to the *args as positional-only according to PEP 612.
    let paramSpecArgList: Arg[] | undefined;
    let paramSpecTarget: ParamSpecType | undefined;
    let hasParamSpecArgsKwargs = false;

    // Determine how many positional args are being passed before
    // we see a keyword arg.
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

            // Does this function define the param spec, or is it an inner
            // function nested within another function that defines the param
            // spec? We need to handle these two cases differently.
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

    // If there are keyword arguments present after a *args argument,
    // the keyword arguments may target one or more parameters that are positional.
    // In this case, we will limit the number of positional parameters so the
    // *args doesn't consume them all.
    if (argList.some((arg) => arg.argCategory === ArgCategory.UnpackedList)) {
        argList.forEach((arg) => {
            if (arg.name) {
                const keywordParamIndex = paramDetails.params.findIndex((paramInfo) => {
                    assert(paramInfo, 'paramInfo entry is undefined fork kwargs check');
                    return (
                        paramInfo.param.name === arg.name!.d.value &&
                        paramInfo.param.category === ParamCategory.Simple
                    );
                });

                // Is this a parameter that can be interpreted as either a keyword or a positional?
                // If so, we'll treat it as a keyword parameter in this case because it's being
                // targeted by a keyword argument.
                if (keywordParamIndex >= 0 && keywordParamIndex >= positionalOnlyLimitIndex) {
                    if (positionParamLimitIndex < 0 || keywordParamIndex < positionParamLimitIndex) {
                        positionParamLimitIndex = keywordParamIndex;
                    }
                }
            }
        });
    }

    // If we didn't see any special cases, then all parameters are positional.
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

    // Map the positional args to parameters.
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
                // Push the remaining positional args onto the param spec arg list.
                while (argIndex < positionalArgCount) {
                    paramSpecArgList.push(argList[argIndex]);
                    argIndex++;
                }
            } else {
                let tooManyPositionals = false;

                if (argList[argIndex].argCategory === ArgCategory.UnpackedList) {
                    // If this is an unpacked iterable, we will conservatively assume that it
                    // might have zero iterations unless we can tell from its type that it
                    // definitely has at least one iterable value.
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

            // Handle the case where *args is being passed to a function defined
            // with a ParamSpec and a Concatenate operator. PEP 612 indicates that
            // all positional parameters specified in the Concatenate must be
            // filled explicitly.
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
                // Allow an unpacked TypeVarTuple arg to satisfy an
                // unpacked TypeVarTuple param.
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
                // Handle the case where an unpacked TypeVarTuple has
                // been packaged into a tuple.
                listElementType = argType.priv.tupleTypeArgs[0].type;
                isArgCompatibleWithVariadic = true;
                advanceToNextArg = true;
                isTypeVarTupleFullyMatched = true;
            } else if (isParamVariadic && isClassInstance(argType) && isTupleClass(argType)) {
                // Handle the case where an unpacked tuple argument is
                // matched to a TypeVarTuple parameter.
                isArgCompatibleWithVariadic = true;
                advanceToNextArg = true;

                // Determine whether we should treat the variadic type as fully matched.
                // This depends on how many args and unmatched parameters exist.
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

            // It's not allowed to use unpacked arguments with a variadic *args
            // parameter unless the argument is a variadic arg as well.
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

            // Note that the parameter has received an argument.
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
                            // Have we run out of arguments and still have parameters left to fill?
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

            // Note that the parameter has received an argument.
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

        // Calculate the number of remaining positional parameters to report.
        let argsRemainingCount = positionOnlyWithoutDefaultsCount - positionalArgCount;
        if (skippedArgsParam) {
            // If we skipped an args parameter above, reduce the count by one
            // because it's permitted to pass zero arguments to *args.
            argsRemainingCount--;
        }

        const firstArgsParam = paramDetails.params.findIndex(
            (paramInfo) => paramInfo.param.category === ParamCategory.ArgsList && !isParamSpec(paramInfo.type)
        );
        if (firstArgsParam >= paramIndex && firstArgsParam < positionalOnlyLimitIndex) {
            // If there is another args parameter beyond the current param index,
            // reduce the count by one because it's permitted to pass zero arguments
            // to *args.
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
                // Verify that the type used in this expression is a SupportsKeysAndGetItem[str, T].
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
                    // Handle the special case where it is a TypedDict and we know which
                    // keys are present.
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

                            // Remember that this parameter has already received a value.
                            paramTracker.addKeywordParam(name, paramDetails.params[paramDetails.kwargsIndex]);
                        } else {
                            // If the function doesn't have a **kwargs parameter, we need to emit an error.
                            // However, it's possible that there was a **kwargs but it was eliminated by
                            // getParamListDetails because it was associated with an unpacked TypedDict.
                            // In this case, we can skip the error.
                            if (!paramDetails.hasUnpackedTypedDict) {
                                diag.addMessage(LocMessage.paramNameMissing().format({ name }));
                            }
                        }
                    });

                    const extraItemsType = tdEntries.extraItems?.valueType ?? registry.objectClass ? convertToInstance(registry.objectClass) : UnknownType.create();
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

                        // If this was a TypeVar (e.g. for pseudo-generic classes),
                        // don't emit this error.
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
                // Protect against the case where a non-keyword argument appears after
                // a keyword argument. This will have already been reported as a parse
                // error, but we need to protect against it here.
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

                            // Remember that this parameter has already received a value.
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
                    // Handle the case where a *args: P.args (or *args: Any) is passed as an
                    // argument to a function that accepts a ParamSpec.
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
            // Don't consider any position-only parameters, since they cannot be matched to
            // **kwargs arguments. Consider parameters that are either positional or keyword
            // if there is no *args argument.
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
        // but have not yet received them. If we received a dictionary argument
        // (i.e. an arg starting with a "**"), we will assume that all parameters
        // are matched.
        if (!unpackedDictArgType && !FunctionType.isDefaultParamCheckDisabled(overload)) {
            const unassignedParams = paramTracker.getUnassignedParams();

            if (unassignedParams.length > 0) {
                if (!state.canSkipDiagnosticForNode(errorNode)) {
                    const missingParamNames = unassignedParams.map((p) => `"${p}"`).join(', ');
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

            // Add any implicit (default) arguments that are needed for resolving
            // generic types. For example, if the function is defined as
            // def foo(v1: _T = 'default')
            // and _T is a TypeVar, we need to match the TypeVar to the default
            // value's type if it's not provided by the caller.
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

    // If we're in speculative mode and an arg/param mismatch has already been reported, don't
    // bother doing the extra work here. This occurs frequently when attempting to find the
    // correct overload.
    if (!reportedArgError || !state.isSpeculativeModeInUse(undefined)) {
        // If there are arguments that map to a variadic *args parameter that hasn't
        // already been matched, see if the type of that *args parameter is a
        // TypeVarTuple. If so, we'll preprocess those arguments and combine them
        // into a tuple.
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
