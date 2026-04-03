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
import { ConstraintTracker } from './constraintTracker';
import {
    Arg,
    ArgResult,
    ArgWithExpression,
    EvaluatorUsage,
    ValidateArgTypeParams,
} from './typeEvaluatorTypes';
import { TypeEvaluator } from './typeEvaluatorTypes';
import { FunctionParam, FunctionType, isAnyOrUnknown, isClassInstance, ParamSpecType, Type, UnknownType } from './types';
import { enumerateLiteralsForType } from './typeGuards';
import { areTypesSame, doForEachSubtype } from './typeUtils';
import { expandTuple } from './tuples';
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
