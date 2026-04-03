/*
 * returnTypeInference.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 *
 * Functions for inferring and computing return types of functions,
 * extracted from the createTypeEvaluator() closure.
 */

import { DiagnosticRule } from '../common/diagnosticRules';
import { TextRange } from '../common/textRange';
import { ParseNode, ParseNodeType } from '../parser/parseNodes';
import * as AnalyzerNodeInfo from './analyzerNodeInfo';
import { LocMessage } from '../localization/localize';
import * as ParseTreeUtils from './parseTreeUtils';
import { inferFunctionReturnType } from './symbolResolution';
import { maxCodeComplexity } from './typeEvaluator';
import { TypeCacheEntry, TypeEvaluatorState } from './typeEvaluatorState';
import {
    CallSiteEvaluationInfo,
    EvalFlags,
    TypeEvaluator,
    TypeResult,
} from './typeEvaluatorTypes';
import {
    FunctionParam,
    FunctionType,
    isTypeSame,
    isUnknown,
    removeUnbound,
    Type,
    TypeVarScopeId,
    UnknownType,
} from './types';
import { isPartlyUnknown, makeTypeVarsFree, stripTypeForm } from './typeUtils';

const maxReturnCallSiteTypeInferenceCodeFlowComplexity = 8;
const maxReturnTypeInferenceArgCount = 6;
const maxReturnTypeInferenceStackSize = 2;
const maxCallSiteReturnTypeCacheSize = 8;
const maxReturnTypeInferenceAttempts = 8;
const maxReturnTypeInferenceCodeFlowComplexity = 32;

export function inferReturnTypeForCallSite(
    evaluator: TypeEvaluator,
    state: TypeEvaluatorState,
    type: FunctionType,
    callSiteInfo: CallSiteEvaluationInfo
): Type | undefined {
    const args = callSiteInfo.args;
    let contextualReturnType: Type | undefined;

    if (!type.shared.declaration) {
        return undefined;
    }
    const functionNode = type.shared.declaration.node;
    const codeFlowComplexity = AnalyzerNodeInfo.getCodeFlowComplexity(functionNode);

    if (codeFlowComplexity >= maxReturnCallSiteTypeInferenceCodeFlowComplexity) {
        return undefined;
    }

    // If an arg hasn't been matched to a specific named parameter,
    // it's an unpacked value that corresponds to multiple parameters.
    // That's an edge case that we don't handle here.
    if (args.some((arg) => !arg.paramName)) {
        return undefined;
    }

    // Detect recurrence. If a function invokes itself either directly
    // or indirectly, we won't attempt to infer contextual return
    // types any further.
    if (state.returnTypeInferenceContextStack.some((context) => context.functionNode === functionNode)) {
        return undefined;
    }

    const functionTypeResult = evaluator.getTypeOfFunction(functionNode);
    if (!functionTypeResult) {
        return undefined;
    }

    // Very complex functions with many arguments can take a long time to analyze,
    // so we'll use a heuristic and avoiding this inference technique for any
    // call site that involves too many arguments.
    if (args.length > maxReturnTypeInferenceArgCount) {
        return undefined;
    }

    // Don't explore arbitrarily deep in the call graph.
    if (state.returnTypeInferenceContextStack.length >= maxReturnTypeInferenceStackSize) {
        return undefined;
    }

    const paramTypes: Type[] = [];
    let isResultFromCache = false;

    // If the call is located in a loop, don't use literal argument types
    // for the same reason we don't do literal math in loops.
    const stripLiteralArgTypes = ParseTreeUtils.isWithinLoop(callSiteInfo.errorNode);

    // Suppress diagnostics because we don't want to generate errors.
    state.suppressDiagnostics(functionNode, () => {
        // Allocate a new temporary type cache for the context of just
        // this function so we can analyze it separately without polluting
        // the main type cache.
        const prevTypeCache = state.returnTypeInferenceTypeCache;
        state.returnTypeInferenceContextStack.push({
            functionNode,
            codeFlowAnalyzer: state.codeFlowEngine.createCodeFlowAnalyzer(),
        });

        try {
            state.returnTypeInferenceTypeCache = new Map<number, TypeCacheEntry>();

            let allArgTypesAreUnknown = true;
            functionNode.d.params.forEach((param, index) => {
                if (param.d.name) {
                    let paramType: Type | undefined;
                    const arg = args.find((arg) => param.d.name!.d.value === arg.paramName);

                    if (arg && arg.argument.valueExpression) {
                        paramType = evaluator.getTypeOfExpression(arg.argument.valueExpression).type;
                        if (!isUnknown(paramType)) {
                            allArgTypesAreUnknown = false;
                        }
                    } else if (param.d.defaultValue) {
                        paramType = evaluator.getTypeOfExpression(param.d.defaultValue).type;
                        if (!isUnknown(paramType)) {
                            allArgTypesAreUnknown = false;
                        }
                    } else if (index === 0) {
                        // If this is an instance or class method, use the implied
                        // parameter type for the "self" or "cls" parameter.
                        if (
                            FunctionType.isInstanceMethod(functionTypeResult.functionType) ||
                            FunctionType.isClassMethod(functionTypeResult.functionType)
                        ) {
                            if (functionTypeResult.functionType.shared.parameters.length > 0) {
                                if (functionNode.d.params[0].d.name) {
                                    paramType = FunctionType.getParamType(functionTypeResult.functionType, 0);
                                }
                            }
                        }
                    }

                    if (!paramType) {
                        paramType = UnknownType.create();
                    }

                    if (stripLiteralArgTypes) {
                        paramType = stripTypeForm(
                            evaluator.convertSpecialFormToRuntimeValue(
                                evaluator.stripLiteralValue(paramType),
                                EvalFlags.None,
                                /* convertModule */ true
                            )
                        );
                    }

                    paramTypes.push(paramType);
                    state.writeTypeCache(param.d.name, { type: paramType }, EvalFlags.None);
                }
            });

            // Don't bother trying to determine the contextual return
            // type if none of the argument types are known.
            if (!allArgTypesAreUnknown) {
                // See if the return type is already cached. If so, skip the
                // inference step, which is potentially very expensive.
                const cacheEntry = functionTypeResult.functionType.priv.callSiteReturnTypeCache?.find((entry) => {
                    return (
                        entry.paramTypes.length === paramTypes.length &&
                        entry.paramTypes.every((t, i) => isTypeSame(t, paramTypes[i]))
                    );
                });

                if (cacheEntry) {
                    contextualReturnType = cacheEntry.returnType;
                    isResultFromCache = true;
                } else {
                    contextualReturnType = inferFunctionReturnType(
                        evaluator,
                        state,
                        functionNode,
                        FunctionType.isAbstractMethod(type),
                        callSiteInfo?.errorNode
                    )?.type;
                }
            }
        } finally {
            state.returnTypeInferenceContextStack.pop();
            state.returnTypeInferenceTypeCache = prevTypeCache;
        }
    });

    if (contextualReturnType) {
        contextualReturnType = removeUnbound(contextualReturnType);

        if (!isResultFromCache) {
            // Cache the resulting type.
            if (!functionTypeResult.functionType.priv.callSiteReturnTypeCache) {
                functionTypeResult.functionType.priv.callSiteReturnTypeCache = [];
            }
            if (
                functionTypeResult.functionType.priv.callSiteReturnTypeCache.length >=
                maxCallSiteReturnTypeCacheSize
            ) {
                functionTypeResult.functionType.priv.callSiteReturnTypeCache =
                    functionTypeResult.functionType.priv.callSiteReturnTypeCache.slice(1);
            }
            functionTypeResult.functionType.priv.callSiteReturnTypeCache.push({
                paramTypes,
                returnType: contextualReturnType,
            });
        }

        return contextualReturnType;
    }

    return undefined;
}

function checkCodeFlowTooComplex(evaluator: TypeEvaluator, node: ParseNode): boolean {
    const scopeNode = node.nodeType === ParseNodeType.Function ? node : ParseTreeUtils.getExecutionScopeNode(node);
    const codeComplexity = AnalyzerNodeInfo.getCodeFlowComplexity(scopeNode);

    if (codeComplexity > maxCodeComplexity) {
        let errorRange: TextRange = scopeNode;
        if (scopeNode.nodeType === ParseNodeType.Function) {
            errorRange = scopeNode.d.name;
        } else if (scopeNode.nodeType === ParseNodeType.Module) {
            errorRange = { start: 0, length: 0 };
        }

        const fileInfo = AnalyzerNodeInfo.getFileInfo(node);
        evaluator.addDiagnosticForTextRange(
            fileInfo,
            DiagnosticRule.reportGeneralTypeIssues,
            LocMessage.codeTooComplexToAnalyze(),
            errorRange
        );

        return true;
    }

    return false;
}

export function getInferredReturnTypeResultImpl(
    evaluator: TypeEvaluator,
    state: TypeEvaluatorState,
    type: FunctionType,
    callSiteInfo?: CallSiteEvaluationInfo
): TypeResult {
    let returnType: Type | undefined;
    let isIncomplete = false;
    const analyzeUnannotatedFunctions = true;

    // Don't attempt to infer the return type for a stub file.
    if (FunctionType.isStubDefinition(type)) {
        return { type: UnknownType.create() };
    }

    // Don't infer the return type for a ParamSpec value.
    if (FunctionType.isParamSpecValue(type)) {
        return { type: UnknownType.create() };
    }

    // Don't infer the return type for an overloaded function (unless it's synthesized,
    // which is needed for proper operation of the __get__ method in properties).
    if (FunctionType.isOverloaded(type) && !FunctionType.isSynthesizedMethod(type)) {
        return { type: UnknownType.create() };
    }

    const evalCount = type.shared.inferredReturnType?.evaluationCount ?? 0;

    // If the return type has already been lazily evaluated,
    // don't bother computing it again.
    if (type.shared.inferredReturnType && !type.shared.inferredReturnType.isIncomplete) {
        returnType = type.shared.inferredReturnType.type;
    } else if (evalCount > maxReturnTypeInferenceAttempts) {
        // Detect a case where a return type won't converge because of recursion.
        returnType = UnknownType.create();
    } else {
        // Don't bother inferring the return type of __init__ because it's
        // always None.
        if (FunctionType.isInstanceMethod(type) && type.shared.name === '__init__') {
            returnType = evaluator.getNoneType();
        } else if (type.shared.declaration) {
            const functionNode = type.shared.declaration.node;
            const skipUnannotatedFunction =
                !AnalyzerNodeInfo.getFileInfo(functionNode).diagnosticRuleSet.analyzeUnannotatedFunctions &&
                ParseTreeUtils.isUnannotatedFunction(functionNode);

            // Skip return type inference if we are in "skip unannotated function" mode.
            if (!skipUnannotatedFunction && !checkCodeFlowTooComplex(evaluator, functionNode.d.suite)) {
                const codeFlowComplexity = AnalyzerNodeInfo.getCodeFlowComplexity(functionNode);

                // For very complex functions that have no annotated parameter types,
                // don't attempt to infer the return type because it can be extremely
                // expensive.
                const parametersAreAnnotated =
                    type.shared.parameters.length <= 1 ||
                    type.shared.parameters.some((param) => FunctionParam.isTypeDeclared(param));

                if (parametersAreAnnotated || codeFlowComplexity < maxReturnTypeInferenceCodeFlowComplexity) {
                    // Temporarily disable speculative mode while we
                    // lazily evaluate the return type.
                    let returnTypeResult: TypeResult | undefined;
                    state.disableSpeculativeMode(() => {
                        returnTypeResult = inferFunctionReturnType(
                            evaluator,
                            state,
                            functionNode,
                            FunctionType.isAbstractMethod(type),
                            callSiteInfo?.errorNode
                        );
                    });

                    returnType = returnTypeResult?.type;
                    if (returnTypeResult?.isIncomplete) {
                        isIncomplete = true;
                    }
                }
            }
        }

        if (!returnType) {
            returnType = UnknownType.create();
        }

        // Externalize any TypeVars that appear in the type.
        const typeVarScopes: TypeVarScopeId[] = [];
        if (type.shared.typeVarScopeId) {
            typeVarScopes.push(type.shared.typeVarScopeId);
        }
        if (type.shared.methodClass?.shared.typeVarScopeId) {
            typeVarScopes.push(type.shared.methodClass.shared.typeVarScopeId);
        }
        returnType = makeTypeVarsFree(returnType, typeVarScopes);

        // Cache the type for next time.
        type.shared.inferredReturnType = { type: returnType, isIncomplete, evaluationCount: evalCount + 1 };
    }

    // If the type is partially unknown and the function has one or more unannotated
    // params, try to analyze the function with the provided argument types and
    // attempt to do a better job at inference.
    if (
        !isIncomplete &&
        analyzeUnannotatedFunctions &&
        isPartlyUnknown(returnType) &&
        FunctionType.hasUnannotatedParams(type) &&
        !FunctionType.isStubDefinition(type) &&
        !FunctionType.isPyTypedDefinition(type) &&
        callSiteInfo
    ) {
        let hasDecorators = false;
        let isAsync = false;
        const declNode = type.shared.declaration?.node;
        if (declNode) {
            if (declNode.d.decorators.length > 0) {
                hasDecorators = true;
            }
            if (declNode.d.isAsync) {
                isAsync = true;
            }
        }

        // We can't use this technique if decorators or async are used because they
        // would need to be applied to the inferred return type.
        if (!hasDecorators && !isAsync) {
            const contextualReturnType = inferReturnTypeForCallSite(evaluator, state, type, callSiteInfo);
            if (contextualReturnType) {
                returnType = contextualReturnType;

                if (type.shared.declaration?.node) {
                    // Externalize any TypeVars that appear in the type.
                    const liveScopeIds = ParseTreeUtils.getTypeVarScopesForNode(type.shared.declaration.node);
                    returnType = makeTypeVarsFree(returnType, liveScopeIds);
                }
            }
        }
    }

    return { type: returnType, isIncomplete };
}

