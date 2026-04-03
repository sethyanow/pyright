/*
 * callValidation.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 *
 * Functions for call validation, overload resolution, and argument processing,
 * extracted from typeEvaluator.ts.
 */

import { ArgumentNode } from '../parser/parseNodes';
import { ArgWithExpression } from './typeEvaluatorTypes';

export function convertNodeToArg(node: ArgumentNode): ArgWithExpression {
    return {
        argCategory: node.d.argCategory,
        name: node.d.name,
        valueExpression: node.d.valueExpr,
    };
}
