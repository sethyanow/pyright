/*
 * callValidation.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 *
 * Functions for call validation, overload resolution, and argument processing,
 * extracted from typeEvaluator.ts.
 */

import { ArgumentNode, ExpressionNode, ParseNode, ParseNodeType } from '../parser/parseNodes';
import * as ParseTreeUtils from './parseTreeUtils';
import { assert } from '../common/debug';
import { DiagnosticRule } from '../common/diagnosticRules';
import { LocMessage } from '../localization/localize';
import { ConstraintTracker } from './constraintTracker';
import * as specialForms from './specialForms';
import {
    Arg,
    ArgResult,
    ArgWithExpression,
    EvaluatorUsage,
    ExpectedTypeOptions,
    TypeEvaluator,
    TypeResult,
    TypeResultWithNode,
    ValidateArgTypeParams,
} from './typeEvaluatorTypes';
import {
    FunctionParam,
    FunctionType,
    isAnyOrUnknown,
    isClassInstance,
    isFunction,
    isParamSpec,
    isTypeVarTuple,
    isUnpackedClass,
    ParamSpecType,
    TupleTypeArg,
    Type,
    TypeVarScopeId,
    TypeVarScopeType,
    TypeVarType,
    UnknownType,
} from './types';
import { ConstraintSolution } from './constraintSolution';
import { enumerateLiteralsForType } from './typeGuards';
import { expandTuple, makeTupleObject } from './tuples';
import {
    applySolvedTypeVars,
    areTypesSame,
    convertToInstance,
    doForEachSubtype,
    getTypeVarArgsRecursive,
    InferenceContext,
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
export function getTypeOfArgExpectingType(evaluator: TypeEvaluator, arg: Arg, options?: ExpectedTypeOptions): TypeResult {
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
