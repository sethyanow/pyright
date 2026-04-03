/*
 * callValidation.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 *
 * Functions for call validation, overload resolution, and argument processing,
 * extracted from typeEvaluator.ts.
 */

import { ArgCategory, ArgumentNode, ExpressionNode, ParamCategory, ParameterNode, ParseNode, ParseNodeType } from '../parser/parseNodes';
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
    isUnpackedClass,
    maxTypeRecursionCount,
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
    isTupleClass,
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
