/*
 * specialForms.test.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 *
 * Smoke tests verifying that special form creation functions
 * are exported from the specialForms module after extraction
 * from the createTypeEvaluator closure.
 */

import {
    createTypeVarType,
    createTypeVarTupleType,
    createParamSpecType,
    createTypeAliasType,
    createNewType,
    createCallableType,
    createOptionalType,
    createLiteralType,
    createClassVarType,
    createTypeFormType,
    createTypeGuardType,
    createSelfType,
    createRequiredOrReadOnlyType,
    createUnpackType,
    createFinalType,
    createConcatenateType,
    createAnnotatedType,
    createSpecialType,
    createUnionType,
    createGenericType,
    createSpecialBuiltInClass,
    createSubclass,
    createSpecializedClassType,
    createSpecializedTypeAlias,
    createAsyncFunction,
    createAwaitableReturnType,
    createClassFromMetaclass,
} from '../analyzer/specialForms';

describe('specialForms module exports', () => {
    test('all create* functions are exported as functions', () => {
        const exports = [
            createTypeVarType,
            createTypeVarTupleType,
            createParamSpecType,
            createTypeAliasType,
            createNewType,
            createCallableType,
            createOptionalType,
            createLiteralType,
            createClassVarType,
            createTypeFormType,
            createTypeGuardType,
            createSelfType,
            createRequiredOrReadOnlyType,
            createUnpackType,
            createFinalType,
            createConcatenateType,
            createAnnotatedType,
            createSpecialType,
            createUnionType,
            createGenericType,
            createSpecialBuiltInClass,
            createSubclass,
            createSpecializedClassType,
            createSpecializedTypeAlias,
            createAsyncFunction,
            createAwaitableReturnType,
            createClassFromMetaclass,
        ];

        for (const fn of exports) {
            expect(typeof fn).toBe('function');
        }
    });
});
