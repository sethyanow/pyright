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
import { ParamCategory } from '../parser/parseNodes';
import { ConstraintTracker } from './constraintTracker';
import { ParamKind, ParamListDetails } from './parameterUtils';
import { makeTupleObject } from './tuples';
import { AssignTypeFlags, TypeEvaluator } from './typeEvaluatorTypes';
import {
    AnyType,
    ClassType,
    FunctionParam,
    FunctionParamFlags,
    isParamSpec,
    isTypeVarTuple,
    isUnpacked,
    isUnpackedClass,
    isUnpackedTypeVarTuple,
    TupleTypeArg,
    Type,
    TypeVarType,
    UnknownType,
} from './types';
import { getTypeVarArgsRecursive } from './typeUtils';

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
