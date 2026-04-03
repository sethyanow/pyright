/*
 * typeEvaluatorState.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 *
 * Manages the mutable state and infrastructure functions
 * extracted from the createTypeEvaluator() closure.
 */

import { CancellationToken } from 'vscode-languageserver';

import { throwIfCancellationRequested } from '../common/cancellationUtils';
import { DiagnosticLevel } from '../common/configOptions';
import { isThenable } from '../common/core';
import { assert, fail } from '../common/debug';
import { convertOffsetToPosition } from '../common/positionUtils';
import { TextRange } from '../common/textRange';
import { ExpressionNode, FunctionNode, ParseNode } from '../parser/parseNodes';
import { ImportLookup } from './analyzerFileInfo';
import * as AnalyzerNodeInfo from './analyzerNodeInfo';
import { CodeFlowAnalyzer, CodeFlowEngine } from './codeFlowEngine';
import { Declaration } from './declaration';
import * as ParseTreeUtils from './parseTreeUtils';
import { Symbol } from './symbol';
import { SpeculativeModeOptions, SpeculativeTypeTracker } from './typeCacheUtils';
import { EffectiveTypeResult, EvalFlags, TypeResult } from './typeEvaluatorTypes';
import { isFunctionOrOverloaded, isTypeSame, Type } from './types';
import { ensureSignaturesAreUnique, InferenceContext, UniqueSignatureTracker } from './typeUtils';

// Interfaces for state entries, moved from typeEvaluator.ts.

export interface SymbolResolutionStackEntry {
    symbolId: number;
    declaration: Declaration;
    isResultValid: boolean;
    partialType?: Type | undefined;
}

export interface ReturnTypeInferenceContext {
    functionNode: FunctionNode;
    codeFlowAnalyzer: CodeFlowAnalyzer;
}

export interface SignatureTrackerStackEntry {
    tracker: UniqueSignatureTracker;
    rootNode: ParseNode;
}

export interface TypeCacheEntry {
    typeResult: TypeResult;
    incompleteGenCount: number;
    flags: EvalFlags | undefined;
}

export interface SuppressedNodeStackEntry {
    node: ParseNode;
    suppressedDiags: string[] | undefined;
}

export interface AssignClassToSelfInfo {
    class: import('./types').ClassType;
    assumedVariance: import('./types').Variance;
}

export interface DeferredClassCompletion {
    dependsUpon: import('./types').ClassType;
    classesToComplete: import('../parser/parseNodes').ClassNode[];
}

export interface CodeFlowAnalyzerCacheEntry {
    typeAtStart: TypeResult | undefined;
    codeFlowAnalyzer: CodeFlowAnalyzer;
}

export interface FunctionRecursionInfo {
    callerNode: ExpressionNode | undefined;
}

export interface EvaluatorOptions {
    printTypeFlags: number;
    logCalls: boolean;
    minimumLoggingThreshold: number;
    evaluateUnknownImportsAsAny: boolean;
    verifyTypeCacheEvaluatorFlags: boolean;
}

export type LogWrapper = <T extends (...args: any[]) => any>(func: T) => (...args: Parameters<T>) => ReturnType<T>;

// Module-level constant matching the one in typeEvaluator.ts.
const verifyTypeCacheEvaluatorFlags = false;

export class TypeEvaluatorState {
    // 17 mutable closure variables, now instance fields.
    symbolResolutionStack: SymbolResolutionStackEntry[] = [];
    speculativeTypeTracker = new SpeculativeTypeTracker();
    suppressedNodeStack: SuppressedNodeStackEntry[] = [];
    assignClassToSelfStack: AssignClassToSelfInfo[] = [];

    functionRecursionMap = new Map<number, FunctionRecursionInfo[]>();
    codeFlowAnalyzerCache = new Map<number, CodeFlowAnalyzerCacheEntry[]>();
    typeCache = new Map<number, TypeCacheEntry>();
    effectiveTypeCache = new Map<number, Map<string, EffectiveTypeResult>>();
    expectedTypeCache = new Map<number, Type>();
    asymmetricAccessorAssignmentCache = new Set<number>();
    deferredClassCompletions: DeferredClassCompletion[] = [];
    cancellationToken: CancellationToken | undefined;
    printExpressionSpaceCount = 0;
    incompleteGenCount = 0;
    returnTypeInferenceContextStack: ReturnTypeInferenceContext[] = [];
    returnTypeInferenceTypeCache: Map<number, TypeCacheEntry> | undefined;
    signatureTrackerStack: SignatureTrackerStackEntry[] = [];

    // Post-construction dependencies: set after evaluatorInterface and codeFlowEngine are created.
    private _isNodeReachable: ((node: ParseNode) => boolean) | undefined;
    private _importLookup: ImportLookup | undefined;
    private _codeFlowEngine: CodeFlowEngine | undefined;
    private _wrapWithLogger: LogWrapper | undefined;

    private _evaluatorOptions: EvaluatorOptions;

    constructor(evaluatorOptions: EvaluatorOptions) {
        this._evaluatorOptions = evaluatorOptions;
    }

    get evaluatorOptions(): EvaluatorOptions {
        return this._evaluatorOptions;
    }

    get importLookup(): ImportLookup {
        assert(this._importLookup !== undefined, 'importLookup not yet initialized');
        return this._importLookup!;
    }

    get codeFlowEngine(): CodeFlowEngine {
        assert(this._codeFlowEngine !== undefined, 'codeFlowEngine not yet initialized');
        return this._codeFlowEngine!;
    }

    get wrapWithLogger(): LogWrapper {
        assert(this._wrapWithLogger !== undefined, 'wrapWithLogger not yet initialized');
        return this._wrapWithLogger!;
    }

    setIsNodeReachable(fn: (node: ParseNode) => boolean): void {
        this._isNodeReachable = fn;
    }

    setImportLookup(importLookup: ImportLookup): void {
        this._importLookup = importLookup;
    }

    setCodeFlowEngine(engine: CodeFlowEngine): void {
        this._codeFlowEngine = engine;
    }

    setWrapWithLogger(wrapper: LogWrapper): void {
        this._wrapWithLogger = wrapper;
    }

    // --- Cache management (7 methods) ---

    readTypeCacheEntry(node: ParseNode): TypeCacheEntry | undefined {
        if (this.returnTypeInferenceTypeCache && this.isNodeInReturnTypeInferenceContext(node)) {
            return this.returnTypeInferenceTypeCache.get(node.id);
        } else {
            return this.typeCache.get(node.id);
        }
    }

    isTypeCached(node: ParseNode): boolean {
        const cacheEntry = this.readTypeCacheEntry(node);
        if (!cacheEntry) {
            return false;
        }

        return !cacheEntry.typeResult.isIncomplete || cacheEntry.incompleteGenCount === this.incompleteGenCount;
    }

    readTypeCache(node: ParseNode, flags: EvalFlags | undefined): Type | undefined {
        const cacheEntry = this.readTypeCacheEntry(node);
        if (!cacheEntry || cacheEntry.typeResult.isIncomplete) {
            return undefined;
        }

        if (this._evaluatorOptions.verifyTypeCacheEvaluatorFlags || verifyTypeCacheEvaluatorFlags) {
            if (flags !== undefined) {
                const expectedFlags = cacheEntry.flags;

                if (expectedFlags !== undefined && flags !== expectedFlags) {
                    const fileInfo = AnalyzerNodeInfo.getFileInfo(node);
                    const position = convertOffsetToPosition(node.start, fileInfo.lines);

                    const message =
                        `Type cache flag mismatch for node type ${node.nodeType} ` +
                        `(parent ${node.parent?.nodeType ?? 'none'}): ` +
                        `cached flags = ${expectedFlags}, access flags = ${flags}, ` +
                        `file = {${fileInfo.fileUri} [${position.line + 1}:${position.character + 1}]}`;
                    if (this._evaluatorOptions.verifyTypeCacheEvaluatorFlags) {
                        fail(message);
                    } else {
                        console.log(message);
                    }
                }
            }
        }

        return cacheEntry.typeResult.type;
    }

    writeTypeCache(
        node: ParseNode,
        typeResult: TypeResult,
        flags: EvalFlags | undefined,
        inferenceContext?: InferenceContext,
        allowSpeculativeCaching = false
    ): void {
        const typeCacheToUse =
            this.returnTypeInferenceTypeCache && this.isNodeInReturnTypeInferenceContext(node)
                ? this.returnTypeInferenceTypeCache
                : this.typeCache;

        if (!typeResult.isIncomplete) {
            this.incompleteGenCount++;
        } else {
            const oldValue = typeCacheToUse.get(node.id);
            if (oldValue !== undefined && !isTypeSame(typeResult.type, oldValue.typeResult.type)) {
                this.incompleteGenCount++;
            }
        }

        typeCacheToUse.set(node.id, { typeResult, flags, incompleteGenCount: this.incompleteGenCount });

        if (this.isSpeculativeModeInUse(node)) {
            this.speculativeTypeTracker.trackEntry(typeCacheToUse, node.id);
            if (allowSpeculativeCaching) {
                this.speculativeTypeTracker.addSpeculativeType(
                    node,
                    typeResult,
                    this.incompleteGenCount,
                    inferenceContext?.expectedType
                );
            }
        }
    }

    getTypeCacheEntryCount(): number {
        return this.typeCache.size;
    }

    disposeEvaluator(): void {
        this.functionRecursionMap = new Map<number, FunctionRecursionInfo[]>();
        this.codeFlowAnalyzerCache = new Map<number, CodeFlowAnalyzerCacheEntry[]>();
        this.typeCache = new Map<number, TypeCacheEntry>();
        this.effectiveTypeCache = new Map<number, Map<string, EffectiveTypeResult>>();
        this.expectedTypeCache = new Map<number, Type>();
        this.asymmetricAccessorAssignmentCache = new Set<number>();
    }

    isNodeInReturnTypeInferenceContext(node: ParseNode): boolean {
        const stackSize = this.returnTypeInferenceContextStack.length;
        if (stackSize === 0) {
            return false;
        }

        const contextNode = this.returnTypeInferenceContextStack[stackSize - 1];

        let curNode: ParseNode | undefined = node;
        while (curNode) {
            if (curNode === contextNode.functionNode) {
                return true;
            }
            curNode = curNode.parent;
        }

        return false;
    }

    // --- Symbol resolution (5 methods) ---

    getIndexOfSymbolResolution(symbol: Symbol, declaration: Declaration): number {
        return this.symbolResolutionStack.findIndex(
            (entry) => entry.symbolId === symbol.id && entry.declaration === declaration
        );
    }

    pushSymbolResolution(symbol: Symbol, declaration: Declaration): boolean {
        const index = this.getIndexOfSymbolResolution(symbol, declaration);
        if (index >= 0) {
            for (let i = index + 1; i < this.symbolResolutionStack.length; i++) {
                this.symbolResolutionStack[i].isResultValid = false;
            }
            return false;
        }

        this.symbolResolutionStack.push({
            symbolId: symbol.id,
            declaration,
            isResultValid: true,
        });
        return true;
    }

    popSymbolResolution(symbol: Symbol): boolean {
        const poppedEntry = this.symbolResolutionStack.pop()!;
        assert(poppedEntry.symbolId === symbol.id);
        return poppedEntry.isResultValid;
    }

    setSymbolResolutionPartialType(symbol: Symbol, declaration: Declaration, type: Type): void {
        const index = this.getIndexOfSymbolResolution(symbol, declaration);
        if (index >= 0) {
            this.symbolResolutionStack[index].partialType = type;
        }
    }

    getSymbolResolutionPartialType(symbol: Symbol, declaration: Declaration): Type | undefined {
        const index = this.getIndexOfSymbolResolution(symbol, declaration);
        if (index >= 0) {
            return this.symbolResolutionStack[index].partialType;
        }

        return undefined;
    }

    // --- Speculative mode (3 methods) ---

    useSpeculativeMode<T>(
        speculativeNode: ParseNode | undefined,
        callback: () => T,
        options?: SpeculativeModeOptions
    ): T {
        if (!speculativeNode) {
            return callback();
        }

        this.speculativeTypeTracker.enterSpeculativeContext(speculativeNode, options);

        try {
            const result = callback();
            this.speculativeTypeTracker.leaveSpeculativeContext();
            return result;
        } catch (e) {
            this.speculativeTypeTracker.leaveSpeculativeContext();
            throw e;
        }
    }

    disableSpeculativeMode(callback: () => void): void {
        const stack = this.speculativeTypeTracker.disableSpeculativeMode();

        try {
            callback();
            this.speculativeTypeTracker.enableSpeculativeMode(stack);
        } catch (e) {
            this.speculativeTypeTracker.enableSpeculativeMode(stack);
            throw e;
        }
    }

    isSpeculativeModeInUse(node: ParseNode | undefined): boolean {
        return this.speculativeTypeTracker.isSpeculative(node);
    }

    // --- Diagnostic suppression (4 methods) ---

    suppressDiagnostics<T>(node: ParseNode, callback: () => T, diagCallback?: (suppressedDiags: string[]) => void): T {
        this.suppressedNodeStack.push({ node, suppressedDiags: diagCallback ? [] : undefined });

        try {
            const result = callback();
            const poppedNode = this.suppressedNodeStack.pop();
            if (diagCallback && poppedNode?.suppressedDiags) {
                diagCallback(poppedNode.suppressedDiags);
            }
            return result;
        } catch (e) {
            this.suppressedNodeStack.pop();
            throw e;
        }
    }

    isDiagnosticSuppressedForNode(node: ParseNode): boolean {
        if (this.speculativeTypeTracker.isSpeculative(node, /* ignoreIfDiagnosticsAllowed */ true)) {
            return true;
        }

        return this.suppressedNodeStack.some((suppressedNode) =>
            ParseTreeUtils.isNodeContainedWithin(node, suppressedNode.node)
        );
    }

    canSkipDiagnosticForNode(node: ParseNode): boolean {
        if (this.speculativeTypeTracker.isSpeculative(node, /* ignoreIfDiagnosticsAllowed */ true)) {
            return true;
        }

        const suppressedEntries = this.suppressedNodeStack.filter((suppressedNode) =>
            ParseTreeUtils.isNodeContainedWithin(node, suppressedNode.node)
        );

        if (suppressedEntries.length === 0) {
            return false;
        }

        return suppressedEntries.every((entry) => !entry.suppressedDiags);
    }

    addDiagnosticWithSuppressionCheck(diagLevel: DiagnosticLevel, message: string, node: ParseNode, range?: TextRange) {
        if (this.isDiagnosticSuppressedForNode(node)) {
            const suppressionEntry = this.suppressedNodeStack.find(
                (suppressedNode) =>
                    ParseTreeUtils.isNodeContainedWithin(node, suppressedNode.node) && suppressedNode.suppressedDiags
            );
            suppressionEntry?.suppressedDiags?.push(message);

            return undefined;
        }

        if (this._isNodeReachable && this._isNodeReachable(node)) {
            const fileInfo = AnalyzerNodeInfo.getFileInfo(node);
            return fileInfo.diagnosticSink.addDiagnosticWithTextRange(diagLevel, message, range ?? node);
        }

        return undefined;
    }

    // --- Asymmetric accessor (2 methods) ---

    setAsymmetricDescriptorAssignment(node: ParseNode): void {
        if (this.isSpeculativeModeInUse(/* node */ undefined)) {
            return;
        }

        this.asymmetricAccessorAssignmentCache.add(node.id);
    }

    isAsymmetricAccessorAssignment(node: ParseNode): boolean {
        return this.asymmetricAccessorAssignmentCache.has(node.id);
    }

    // --- Signature tracking (3 methods) ---

    getSignatureTrackerForNode(node: ParseNode): UniqueSignatureTracker | undefined {
        for (let i = this.signatureTrackerStack.length - 1; i >= 0; i--) {
            const rootNode = this.signatureTrackerStack[i].rootNode;
            if (ParseTreeUtils.isNodeContainedWithin(node, rootNode)) {
                return this.signatureTrackerStack[i].tracker;
            }
        }

        return undefined;
    }

    useSignatureTracker<T>(node: ParseNode, callback: () => T): T {
        const tracker = this.getSignatureTrackerForNode(node);

        try {
            if (!tracker) {
                this.signatureTrackerStack.push({
                    tracker: new UniqueSignatureTracker(),
                    rootNode: node,
                });
            }

            const result = callback();

            if (!tracker) {
                this.signatureTrackerStack.pop();
            }

            return result;
        } catch (e) {
            if (!tracker) {
                this.signatureTrackerStack.pop();
            }

            throw e;
        }
    }

    ensureSignatureIsUnique<T extends Type>(type: T, node: ParseNode): T {
        const tracker = this.getSignatureTrackerForNode(node);
        if (!tracker) {
            return type;
        }

        if (isFunctionOrOverloaded(type)) {
            return ensureSignaturesAreUnique(type, tracker, node.start);
        }

        return type;
    }

    // --- Cancellation (2 methods) ---

    runWithCancellationToken<T>(token: CancellationToken, callback: () => T): T;
    runWithCancellationToken<T>(token: CancellationToken, callback: () => Promise<T>): Promise<T>;
    runWithCancellationToken<T>(token: CancellationToken, callback: () => T | Promise<T>): T | Promise<T> {
        const oldToken = this.cancellationToken;
        let result: T | Promise<T> | undefined = undefined;
        try {
            this.cancellationToken = token;
            result = callback();

            if (!isThenable(result)) {
                return result;
            }

            return result.finally(() => {
                this.cancellationToken = oldToken;
            });
        } finally {
            if (!isThenable(result)) {
                this.cancellationToken = oldToken;
            }
        }
    }

    checkForCancellation(): void {
        if (this.cancellationToken) {
            throwIfCancellationRequested(this.cancellationToken);
        }
    }

    // --- Return type inference context (1 method) ---

    getCodeFlowAnalyzerForReturnTypeInferenceContext(): CodeFlowAnalyzer {
        const stackSize = this.returnTypeInferenceContextStack.length;
        assert(stackSize > 0);
        const contextNode = this.returnTypeInferenceContextStack[stackSize - 1];
        return contextNode.codeFlowAnalyzer;
    }

    // --- Misc (1 method) ---

    getPrintExpressionTypesSpaces(): string {
        return ' '.repeat(this.printExpressionSpaceCount);
    }
}
