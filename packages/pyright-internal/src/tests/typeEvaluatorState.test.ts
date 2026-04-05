/*
 * typeEvaluatorState.test.ts
 *
 * Unit tests for TypeEvaluatorState extracted from the
 * createTypeEvaluator closure.
 */

import { EvaluatorOptions, TypeEvaluatorState } from '../analyzer/typeEvaluatorState';
import { Declaration, DeclarationType } from '../analyzer/declaration';
import { Symbol } from '../analyzer/symbol';
import { ParseNode, ParseNodeType } from '../parser/parseNodes';

function createMockEvaluatorOptions(): EvaluatorOptions {
    return {
        printTypeFlags: 0,
        logCalls: false,
        minimumLoggingThreshold: 0,
        evaluateUnknownImportsAsAny: false,
        verifyTypeCacheEvaluatorFlags: false,
    };
}

function createMockSymbol(id: number): Symbol {
    return { id } as unknown as Symbol;
}

function createMockDeclaration(): Declaration {
    return { type: DeclarationType.Variable } as unknown as Declaration;
}

function createMockParseNode(id: number): ParseNode {
    return { id, nodeType: ParseNodeType.Name } as unknown as ParseNode;
}

describe('TypeEvaluatorState', () => {
    let state: TypeEvaluatorState;

    beforeEach(() => {
        state = new TypeEvaluatorState(createMockEvaluatorOptions());
    });

    describe('cache management', () => {
        test('initial type cache is empty', () => {
            expect(state.getTypeCacheEntryCount()).toBe(0);
        });

        test('disposeEvaluator resets all caches', () => {
            state.disposeEvaluator();
            expect(state.getTypeCacheEntryCount()).toBe(0);
        });
    });

    describe('symbol resolution', () => {
        test('pushSymbolResolution returns true for new symbol', () => {
            const symbol = createMockSymbol(1);
            const decl = createMockDeclaration();
            expect(state.pushSymbolResolution(symbol, decl)).toBe(true);
        });

        test('pushSymbolResolution returns false for duplicate (cycle detection)', () => {
            const symbol = createMockSymbol(1);
            const decl = createMockDeclaration();
            state.pushSymbolResolution(symbol, decl);
            expect(state.pushSymbolResolution(symbol, decl)).toBe(false);
        });

        test('popSymbolResolution returns validity after push', () => {
            const symbol = createMockSymbol(1);
            const decl = createMockDeclaration();
            state.pushSymbolResolution(symbol, decl);
            expect(state.popSymbolResolution(symbol)).toBe(true);
        });

        test('popSymbolResolution returns false when cycle was detected', () => {
            const sym1 = createMockSymbol(1);
            const sym2 = createMockSymbol(2);
            const decl = createMockDeclaration();

            // Push sym1, then sym2, then sym1 again (cycle).
            // The cycle detection marks entries between the duplicate as invalid.
            state.pushSymbolResolution(sym1, decl);
            state.pushSymbolResolution(sym2, decl);
            state.pushSymbolResolution(sym1, decl); // returns false, marks sym2 invalid

            // sym2 was between the two sym1 entries, so its validity is false
            expect(state.popSymbolResolution(sym2)).toBe(false);
        });

        test('getSymbolResolutionPartialType returns undefined when not set', () => {
            const symbol = createMockSymbol(1);
            const decl = createMockDeclaration();
            expect(state.getSymbolResolutionPartialType(symbol, decl)).toBeUndefined();
        });
    });

    describe('speculative mode', () => {
        test('isSpeculativeModeInUse returns false initially', () => {
            expect(state.isSpeculativeModeInUse(undefined)).toBe(false);
        });
    });

    describe('cancellation', () => {
        test('checkForCancellation does not throw when no token set', () => {
            expect(() => state.checkForCancellation()).not.toThrow();
        });
    });

    describe('diagnostic suppression', () => {
        test('isDiagnosticSuppressedForNode returns false with empty stack', () => {
            const node = createMockParseNode(1);
            expect(state.isDiagnosticSuppressedForNode(node)).toBe(false);
        });

        test('canSkipDiagnosticForNode returns false with empty stack', () => {
            const node = createMockParseNode(1);
            expect(state.canSkipDiagnosticForNode(node)).toBe(false);
        });
    });

    describe('misc', () => {
        test('getPrintExpressionTypesSpaces returns empty string initially', () => {
            expect(state.getPrintExpressionTypesSpaces()).toBe('');
        });

        test('isAsymmetricAccessorAssignment returns false for unknown node', () => {
            const node = createMockParseNode(999);
            expect(state.isAsymmetricAccessorAssignment(node)).toBe(false);
        });

        test('getCodeFlowAnalyzerForReturnTypeInferenceContext throws when stack empty', () => {
            expect(() => state.getCodeFlowAnalyzerForReturnTypeInferenceContext()).toThrow();
        });
    });
});
