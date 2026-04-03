/*
 * typeEvaluator.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 * Author: Eric Traut
 *
 * Module that evaluates types of parse tree nodes within
 * a program.
 *
 * Note: This is a gargantuan module - much larger than I would
 * normally create. It is written this way primarily for performance,
 * with the internal methods having access to the full closure of
 * the createTypeEvaluator function. This is the same approach
 * taken by the TypeScript compiler.
 */

import { CancellationToken } from 'vscode-languageserver';

import { invalidateTypeCacheIfCanceled } from '../common/cancellationUtils';
import { appendArray } from '../common/collectionUtils';
import { DiagnosticLevel } from '../common/configOptions';
import { ConsoleInterface } from '../common/console';
import { assert, assertNever, fail } from '../common/debug';
import { DiagnosticAddendum } from '../common/diagnostic';
import { DiagnosticRule } from '../common/diagnosticRules';
import { convertOffsetsToRange } from '../common/positionUtils';
import { PythonVersion, pythonVersion3_6, pythonVersion3_7, pythonVersion3_9 } from '../common/pythonVersion';
import { TextRange } from '../common/textRange';
import { LocAddendum, LocMessage } from '../localization/localize';
import {
    ArgCategory,
    ArgumentNode,
    AssignmentNode,
    AugmentedAssignmentNode,
    AwaitNode,
    CallNode,
    CaseNode,
    ClassNode,
    ComprehensionForIfNode,
    ComprehensionNode,
    ConstantNode,
    DecoratorNode,
    DictionaryNode,
    ErrorExpressionCategory,
    ExceptNode,
    ExecutionScopeNode,
    ExpressionNode,
    FormatStringNode,
    ForNode,
    FunctionNode,
    ImportAsNode,
    ImportFromAsNode,
    ImportFromNode,
    IndexNode,
    isExpressionNode,
    LambdaNode,
    ListNode,
    MatchNode,
    MemberAccessNode,
    NameNode,
    NumberNode,
    ParamCategory,
    ParameterNode,
    ParseNode,
    ParseNodeType,
    SetNode,
    SliceNode,
    StringListNode,
    StringNode,
    TupleNode,
    TypeAliasNode,
    TypeAnnotationNode,
    TypeParameterListNode,
    TypeParameterNode,
    TypeParameterScopeNode,
    TypeParamKind,
    UnpackNode,
    WithItemNode,
    YieldFromNode,
    YieldNode,
} from '../parser/parseNodes';
import { ParseOptions, Parser, ParseTextMode } from '../parser/parser';
import { KeywordType, OperatorType, StringTokenFlags } from '../parser/tokenizerTypes';
import { AnalyzerFileInfo, ImportLookup, isAnnotationEvaluationPostponed } from './analyzerFileInfo';
import * as AnalyzerNodeInfo from './analyzerNodeInfo';
import { CodeFlowAnalyzer, FlowNodeTypeOptions, FlowNodeTypeResult, getCodeFlowEngine } from './codeFlowEngine';
import {
    CodeFlowReferenceExpressionNode,
    createKeyForReference,
    FlowFlags,
    FlowNode,
    FlowWildcardImport,
    isCodeFlowSupportedForReference,
    wildcardImportReferenceKey,
} from './codeFlowTypes';
import { ConstraintSolution } from './constraintSolution';
import {
    addConstraintsForExpectedType,
    applySourceSolutionToConstraints,
    solveConstraints,
    solveConstraintSet,
} from './constraintSolver';
import { ConstraintSet, ConstraintTracker } from './constraintTracker';
import { createFunctionFromConstructor, getBoundInitMethod, validateConstructorArgs } from './constructors';
import { applyDataClassClassBehaviorOverrides, synthesizeDataClassMethods } from './dataClasses';
import {
    ClassDeclaration,
    Declaration,
    DeclarationType,
    FunctionDeclaration,
    VariableDeclaration,
} from './declaration';
import { getNameNodeForDeclaration, ResolvedAliasInfo } from './declarationUtils';
import { LogWrapper, TypeEvaluatorState } from './typeEvaluatorState';
import { populateTypeRegistry, TypeRegistry } from './typeRegistry';
import {
    addOverloadsToFunctionType,
    applyClassDecorator,
    applyFunctionDecorator,
    getDeprecatedMessageFromCall,
    getFunctionInfoFromDecorators,
} from './decorators';
import {
    createEnumType,
    getEnumAutoValueType,
    getTypeOfEnumMember,
    isDeclInEnumClass,
    isEnumClassWithMembers,
    isEnumMetaclass,
} from './enums';
import { applyFunctionTransform } from './functionTransform';
import { createNamedTupleType } from './namedTuples';
import {
    getTypeOfAugmentedAssignment,
    getTypeOfBinaryOperation,
    getTypeOfTernaryOperation,
    getTypeOfUnaryOperation,
} from './operations';
import {
    getParamListDetails,
    isParamSpecArgs,
    isParamSpecKwargs,
    ParamAssignmentTracker,
    ParamKind,
    ParamListDetails,
} from './parameterUtils';
import * as ParseTreeUtils from './parseTreeUtils';
import { assignTypeToPatternTargets, checkForUnusedPattern, narrowTypeBasedOnPattern } from './patternMatching';
import { Scope, ScopeType, SymbolWithScope } from './scope';
import * as memberAccessModule from './memberAccess';
import * as specialForms from './specialForms';
import * as typeAssignment from './typeAssignment';
import * as returnTypeInference from './returnTypeInference';
import * as symbolResolution from './symbolResolution';
import * as ScopeUtils from './scopeUtils';
import { createSentinelType } from './sentinel';
import { evaluateStaticBoolExpression } from './staticExpressions';
import { indeterminateSymbolId, Symbol, SymbolFlags } from './symbol';
import { isConstantName, isPrivateName, isPrivateOrProtectedName } from './symbolNameUtils';
import { isEffectivelyClassVar } from './symbolUtils';
import { expandTuple, getSlicedTupleType, getTypeOfTuple, makeTupleObject } from './tuples';
import { SpeculativeModeOptions } from './typeCacheUtils';
import {
    assignToTypedDict,
    createTypedDictType,
    createTypedDictTypeInlined,
    getTypedDictMembersForClass,
    getTypeOfIndexedTypedDict,
    synthesizeTypedDictClassMethods,
} from './typedDicts';
import {
    AbstractSymbol,
    Arg,
    ArgResult,
    ArgWithExpression,
    AssignTypeFlags,
    CallResult,
    CallSignature,
    CallSignatureInfo,
    CallSiteEvaluationInfo,
    ClassMemberLookup,
    ClassTypeResult,
    DeclaredSymbolTypeInfo,
    EffectiveTypeResult,
    EvalFlags,
    EvaluatorUsage,
    ExpectedTypeOptions,
    GetTypeArgsOptions,
    ExpectedTypeResult,
    FunctionTypeResult,
    MapSubtypesOptions,
    maxInferredContainerDepth,
    maxSubtypesForInferredType,
    MemberAccessDeprecationInfo,
    PrintTypeOptions,
    Reachability,
    ResolveAliasOptions,
    SolveConstraintsOptions,
    SymbolDeclInfo,
    TypeEvaluator,
    TypeResult,
    TypeResultWithNode,
    ValidateArgTypeParams,
    ValidateTypeArgsOptions,
} from './typeEvaluatorTypes';
import { enumerateLiteralsForType } from './typeGuards';
import * as TypePrinter from './typePrinter';
import {
    AnyType,
    ClassType,
    ClassTypeFlags,
    combineTypes,
    DataClassBehaviors,
    EnumLiteral,
    findSubtype,
    FunctionParam,
    FunctionParamFlags,
    FunctionType,
    FunctionTypeFlags,
    isAny,
    isAnyOrUnknown,
    isClass,
    isClassInstance,
    isFunction,
    isFunctionOrOverloaded,
    isInstantiableClass,
    isMethodType,
    isModule,
    isNever,
    isOverloaded,
    isParamSpec,
    isTypeSame,
    isTypeVar,
    isTypeVarTuple,
    isUnbound,
    isUnion,
    isUnknown,
    isUnpacked,
    isUnpackedClass,
    isUnpackedTypeVarTuple,
    LiteralValue,
    maxTypeRecursionCount,
    ModuleType,
    NeverType,
    OverloadedType,
    ParamSpecType,
    removeUnbound,
    SentinelLiteral,
    TupleTypeArg,
    Type,
    TypeBase,
    TypeCategory,
    TypeCondition,
    TypedDictEntries,
    TypeVarKind,
    TypeVarScopeId,
    TypeVarScopeType,
    TypeVarType,
    UnboundType,
    UnionType,
    UnknownType,
    Variance,
} from './types';
import {
    addConditionToType,
    addTypeVarsToListIfUnique,
    applySolvedTypeVars,
    ApplyTypeVarOptions,
    areTypesSame,
    buildSolutionFromSpecializedClass,
    ClassMember,
    combineSameSizedTuples,
    combineVariances,
    computeMroLinearization,
    containsAnyOrUnknown,
    containsLiteralType,
    convertToInstance,
    convertToInstantiable,
    convertTypeToParamSpecValue,
    derivesFromAnyOrUnknown,
    derivesFromClassRecursive,
    derivesFromStdlibClass,
    doForEachSubtype,
    getContainerDepth,
    getGeneratorTypeArgs,
    getGeneratorYieldType,
    getSpecializedTupleType,
    getTypeCondition,
    getTypeVarArgsRecursive,
    getTypeVarScopeIds,
    getUnknownTypeForCallable,
    InferenceContext,
    invertVariance,
    isDescriptorInstance,
    isEffectivelyInstantiable,
    isEllipsisType,
    isIncompleteUnknown,
    isInstantiableMetaclass,
    isLiteralType,
    isMaybeDescriptorInstance,
    isMetaclassInstance,
    isNoneInstance,
    isOptionalType,
    isPartlyUnknown,
    isProperty,
    isSentinelLiteral,
    isTupleClass,
    isTupleIndexUnambiguous,
    isTypeAliasPlaceholder,
    isTypeAliasRecursive,
    isUnboundedTupleClass,
    lookUpClassMember,
    lookUpObjectMember,
    makeFunctionTypeVarsBound,
    makeInferenceContext,
    makePacked,
    makeTypeVarsBound,
    makeTypeVarsFree,
    mapSubtypes,
    MemberAccessFlags,
    partiallySpecializeType,
    preserveUnknown,
    removeNoneFromUnion,
    requiresSpecialization,
    requiresTypeArgs,
    selfSpecializeClass,
    simplifyFunctionToParamSpec,
    sortTypes,
    specializeForBaseClass,
    specializeWithDefaultTypeArgs,
    stripTypeForm,
    stripTypeFormRecursive,
    synthesizeTypeVarForSelfCls,
    transformExpectedType,
    transformPossibleRecursiveTypeAlias,
} from './typeUtils';

interface MatchArgsToParamsResult {
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

export interface MemberAccessTypeResult {
    type: Type;
    isDescriptorApplied?: boolean;
    isAsymmetricAccessor?: boolean;
    memberAccessDeprecationInfo?: MemberAccessDeprecationInfo;
    typeErrors?: boolean;
}

interface ScopedTypeVarResult {
    type: TypeVarType;
    scopeNode: TypeParameterScopeNode | AssignmentNode | undefined;
    foundInterveningClass: boolean;
}

interface AliasMapEntry {
    alias: string;
    module: 'builtins' | 'collections' | 'internals';
    implicitBaseClass?: string;
    isSpecialForm?: boolean;
    isIllegalInIsinstance?: boolean;
    typeParamVariance?: Variance;
}

interface MatchedOverloadInfo {
    overload: FunctionType;
    matchResults: MatchArgsToParamsResult;
    constraints: ConstraintTracker;
    argResults: ArgResult[];
    returnType: Type;
}

interface ValidateArgTypeOptions {
    skipUnknownArgCheck?: boolean;
    isArgFirstPass?: boolean;
    conditionFilter?: TypeCondition[];
    skipReportError?: boolean;
}

interface EffectiveReturnTypeOptions {
    callSiteInfo?: CallSiteEvaluationInfo;
}

// This table contains the names of several built-in types that
// are not subscriptable at runtime on older versions of Python.
// It lists the first version of Python where subscripting is
// allowed.
const nonSubscriptableBuiltinTypes: Map<string, PythonVersion> = new Map([
    ['asyncio.futures.Future', pythonVersion3_9],
    ['asyncio.tasks.Task', pythonVersion3_9],
    ['builtins.dict', pythonVersion3_9],
    ['builtins.frozenset', pythonVersion3_9],
    ['builtins.list', pythonVersion3_9],
    ['builtins._PathLike', pythonVersion3_9],
    ['builtins.set', pythonVersion3_9],
    ['builtins.tuple', pythonVersion3_9],
    ['collections.ChainMap', pythonVersion3_9],
    ['collections.Counter', pythonVersion3_9],
    ['collections.defaultdict', pythonVersion3_9],
    ['collections.DefaultDict', pythonVersion3_9],
    ['collections.deque', pythonVersion3_9],
    ['collections.OrderedDict', pythonVersion3_9],
    ['queue.Queue', pythonVersion3_9],
]);

// Some types that do not inherit from others are still considered
// "compatible" based on the Python spec. These are sometimes referred
// to as "type promotions".
const typePromotions: Map<string, string[]> = new Map([
    ['builtins.float', ['builtins.int']],
    ['builtins.complex', ['builtins.float', 'builtins.int']],
    ['builtins.bytes', ['builtins.bytearray', 'builtins.memoryview']],
]);

interface ParamSpecArgResult {
    argumentErrors: boolean;
    constraintTrackers: (ConstraintTracker | undefined)[];
}

// How many levels deep should we attempt to infer return
// How many entries in a list, set, or dict should we examine
// when inferring the type? We need to cut it off at some point
// to avoid excessive computation.
const maxEntriesToUseForInference = 64;

// How many assignments to an unannotated variable should be used
// Maximum number of times to attempt effective type evaluation
// of a variable that has no type declaration.
const maxEffectiveTypeEvaluationAttempts = 16;

// Maximum number of combinatoric argument type expansions allowed
// when resolving an overload.
const maxTotalOverloadArgTypeExpansionCount = 256;

// Maximum size of an enum that will be expanded during overload
// argument type expansion.
const maxSingleOverloadArgTypeExpansionCount = 64;

// Maximum recursion amount when comparing two recursive type aliases.
// Increasing this can greatly increase the time required to evaluate
// two recursive type aliases that have the same definition. Decreasing
// Normally a symbol can have only one type declaration, but there are
// cases where multiple are possible (e.g. a property with a setter
// This debugging option prints each expression and its evaluated type.
const printExpressionTypes = false;

// The following number is chosen somewhat arbitrarily. We need to cut
// off code flow analysis at some point for code flow graphs that are too
// complex. Otherwise we risk overflowing the stack or incurring extremely
// long analysis times. This number has been tuned empirically.
export const maxCodeComplexity = 768;

export interface EvaluatorOptions {
    printTypeFlags: TypePrinter.PrintTypeFlags;
    logCalls: boolean;
    minimumLoggingThreshold: number;
    evaluateUnknownImportsAsAny: boolean;
    verifyTypeCacheEvaluatorFlags: boolean;
}

// Describes a "deferred class completion" that is run when a class type is
// fully created and the "PartiallyEvaluated" flag has just been cleared.
// This allows us to properly compute information like the MRO which
// depends on a full understanding of base classes.
export function createTypeEvaluator(
    importLookup: ImportLookup,
    evaluatorOptions: EvaluatorOptions,
    wrapWithLogger: LogWrapper
): TypeEvaluator {
    const state = new TypeEvaluatorState(evaluatorOptions);
    state.setImportLookup(importLookup);
    state.setWrapWithLogger(wrapWithLogger);
    const isTypeFormSupported = specialForms.isTypeFormSupported;
    const applyUnpackToTupleLike = specialForms.applyUnpackToTupleLike;
    const getFunctionFullName = specialForms.getFunctionFullName;
    let registry!: TypeRegistry;
    let registryInitialized = false;

    // Infrastructure functions delegated to state.
    function runWithCancellationToken<T>(token: CancellationToken, callback: () => T): T;
    function runWithCancellationToken<T>(token: CancellationToken, callback: () => Promise<T>): Promise<T>;
    function runWithCancellationToken<T>(token: CancellationToken, callback: () => T | Promise<T>): T | Promise<T> {
        return state.runWithCancellationToken(token, callback);
    }
    function checkForCancellation() {
        state.checkForCancellation();
    }
    function getTypeCacheEntryCount() {
        return state.getTypeCacheEntryCount();
    }
    function disposeEvaluator() {
        state.disposeEvaluator();
    }
    function readTypeCacheEntry(node: ParseNode) {
        return state.readTypeCacheEntry(node);
    }
    function isTypeCached(node: ParseNode) {
        return state.isTypeCached(node);
    }
    function readTypeCache(node: ParseNode, flags: EvalFlags | undefined) {
        return state.readTypeCache(node, flags);
    }
    function writeTypeCache(
        node: ParseNode,
        typeResult: TypeResult,
        flags: EvalFlags | undefined,
        inferenceContext?: InferenceContext,
        allowSpeculativeCaching = false
    ) {
        state.writeTypeCache(node, typeResult, flags, inferenceContext, allowSpeculativeCaching);
    }
    function setTypeResultForNode(node: ParseNode, typeResult: TypeResult, flags = EvalFlags.None) {
        state.writeTypeCache(node, typeResult, flags);
    }
    function setAsymmetricDescriptorAssignment(node: ParseNode) {
        state.setAsymmetricDescriptorAssignment(node);
    }
    function isAsymmetricAccessorAssignment(node: ParseNode) {
        return state.isAsymmetricAccessorAssignment(node);
    }
    function isNodeInReturnTypeInferenceContext(node: ParseNode) {
        return state.isNodeInReturnTypeInferenceContext(node);
    }
    function getCodeFlowAnalyzerForReturnTypeInferenceContext() {
        return state.getCodeFlowAnalyzerForReturnTypeInferenceContext();
    }
    function pushSymbolResolution(symbol: Symbol, declaration: Declaration) {
        return state.pushSymbolResolution(symbol, declaration);
    }
    function popSymbolResolution(symbol: Symbol) {
        return state.popSymbolResolution(symbol);
    }
    function setSymbolResolutionPartialType(symbol: Symbol, declaration: Declaration, type: Type) {
        state.setSymbolResolutionPartialType(symbol, declaration, type);
    }
    // Determines the type of the specified node by evaluating it in
    // context, logging any errors in the process. This may require the
    // type of surrounding statements to be evaluated.
    function getType(node: ExpressionNode): Type | undefined {
        ensureRegistryInitialized(node);

        let type = evaluateTypeForSubnode(node, () => {
            evaluateTypesForExpressionInContext(node);
        })?.type;

        // If this is a type parameter with a calculated variance, see if we
        // can swap it out for a version that has a computed variance.
        if (type && isTypeVar(type) && type.shared.declaredVariance === Variance.Auto) {
            const typeVarType = type;
            const typeParamListNode = ParseTreeUtils.getParentNodeOfType<TypeParameterListNode>(
                node,
                ParseNodeType.TypeParameterList
            );

            if (typeParamListNode?.parent?.nodeType === ParseNodeType.Class) {
                const classTypeResult = getTypeOfClass(typeParamListNode.parent);

                if (classTypeResult) {
                    inferVarianceForClass(classTypeResult.classType);

                    const typeParam = classTypeResult.classType.shared.typeParams.find((param) =>
                        isTypeSame(param, typeVarType, { ignoreTypeFlags: true })
                    );

                    if (typeParam?.priv.computedVariance !== undefined) {
                        type = TypeVarType.cloneWithComputedVariance(type, typeParam.priv.computedVariance);
                    }
                }
            } else if (typeParamListNode?.parent?.nodeType === ParseNodeType.TypeAlias) {
                const typeAliasType = getTypeOfTypeAlias(typeParamListNode.parent);
                const typeParamIndex = typeParamListNode.d.params.findIndex((param) => param.d.name === node);

                if (typeParamIndex >= 0) {
                    inferVarianceForTypeAlias(typeAliasType);

                    const typeAliasInfo = typeAliasType.props?.typeAliasInfo;
                    if (typeAliasInfo?.shared.computedVariance) {
                        const computedVariance = typeAliasInfo.shared.computedVariance[typeParamIndex];

                        type = TypeVarType.cloneWithComputedVariance(type, computedVariance);
                    }
                }
            }
        }

        if (type) {
            type = transformPossibleRecursiveTypeAlias(type);
        }

        return type;
    }

    function getTypeResult(node: ExpressionNode): TypeResult | undefined {
        return evaluateTypeForSubnode(node, () => {
            evaluateTypesForExpressionInContext(node);
        });
    }

    function getTypeResultForDecorator(node: DecoratorNode): TypeResult | undefined {
        return evaluateTypeForSubnode(node, () => {
            evaluateTypesForExpressionInContext(node.d.expr);
        });
    }

    // Reads the type of the node from the cache.
    function getCachedType(node: ExpressionNode | DecoratorNode): Type | undefined {
        return readTypeCache(node, EvalFlags.None);
    }

    // Determines the expected type of a specified node based on surrounding
    // context. For example, if it's a subexpression of an argument expression,
    // the associated parameter type might inform the expected type.
    function getExpectedType(node: ExpressionNode): ExpectedTypeResult | undefined {
        // This is a primary entry point called by language server providers,
        // and it might be called before any other type evaluation has occurred.
        // Use this opportunity to do some initialization.
        ensureRegistryInitialized(node);

        // Scan up the parse tree to find the top-most expression node
        // so we can evaluate the entire expression.
        let topExpression = node;
        let curNode: ParseNode | undefined = node;
        while (curNode) {
            if (isExpressionNode(curNode)) {
                topExpression = curNode;
            }

            curNode = curNode.parent;
        }

        // Evaluate the expression. This will have the side effect of
        // storing an expected type in the expected type cache.
        evaluateTypesForExpressionInContext(topExpression);

        // Look for the resulting expected type by scanning up the parse tree.
        curNode = node;
        while (curNode) {
            const expectedType = state.expectedTypeCache.get(curNode.id);
            if (expectedType) {
                return {
                    type: expectedType,
                    node: curNode,
                };
            }

            if (curNode === topExpression) {
                break;
            }

            curNode = curNode.parent;
        }

        return undefined;
    }

    function ensureRegistryInitialized(node: ParseNode): void {
        if (registryInitialized) return;
        registryInitialized = true;
        // Set empty object before factory call so re-entrant evaluator
        // calls that access registry fields get undefined (not a crash),
        // matching original pattern where prefetched = {} before resolution.
        registry = {} as TypeRegistry;
        populateTypeRegistry(registry, evaluatorInterface, importLookup, node);
    }

    function getTypeOfExpression(
        node: ExpressionNode,
        flags = EvalFlags.None,
        inferenceContext?: InferenceContext
    ): TypeResult {
        // Is this type already cached?
        const cacheEntry = readTypeCacheEntry(node);
        if (cacheEntry) {
            if (!cacheEntry.typeResult.isIncomplete || cacheEntry.incompleteGenCount === state.incompleteGenCount) {
                if (printExpressionTypes) {
                    console.log(
                        `${getPrintExpressionTypesSpaces()}${ParseTreeUtils.printExpression(node)} (${getLineNum(
                            node
                        )}): Cached ${printType(cacheEntry.typeResult.type)} ${
                            cacheEntry.typeResult.typeErrors ? ' Errors' : ''
                        }`
                    );
                }

                return cacheEntry.typeResult;
            }
        }

        // Is it cached in the speculative type cache?
        const specCacheEntry = state.speculativeTypeTracker.getSpeculativeType(node, inferenceContext?.expectedType);
        if (specCacheEntry) {
            if (
                !specCacheEntry.typeResult.isIncomplete ||
                specCacheEntry.incompleteGenerationCount === state.incompleteGenCount
            ) {
                if (printExpressionTypes) {
                    console.log(
                        `${getPrintExpressionTypesSpaces()}${ParseTreeUtils.printExpression(node)} (${getLineNum(
                            node
                        )}): Speculative ${printType(specCacheEntry.typeResult.type)}`
                    );
                }

                return specCacheEntry.typeResult;
            }
        }

        if (printExpressionTypes) {
            console.log(
                `${getPrintExpressionTypesSpaces()}${ParseTreeUtils.printExpression(node)} (${getLineNum(node)}): Pre`
            );
            state.printExpressionSpaceCount++;
        }

        // This is a frequently-called routine, so it's a good place to call
        // the cancellation check. If the operation is canceled, an exception
        // will be thrown at this point.
        checkForCancellation();

        if (inferenceContext) {
            inferenceContext.expectedType = transformPossibleRecursiveTypeAlias(inferenceContext.expectedType);
        }

        // If we haven't already fetched some core type definitions from the
        // typeshed stubs, do so here. It would be better to fetch this when it's
        // needed in assignType, but we don't have access to the parse tree
        // at that point.
        ensureRegistryInitialized(node);

        let typeResult = getTypeOfExpressionCore(node, flags, inferenceContext);

        // Should we disable type promotions for bytes?
        if (
            isInstantiableClass(typeResult.type) &&
            typeResult.type.priv.includePromotions &&
            !typeResult.type.priv.includeSubclasses &&
            ClassType.isBuiltIn(typeResult.type, 'bytes')
        ) {
            if (AnalyzerNodeInfo.getFileInfo(node).diagnosticRuleSet.disableBytesTypePromotions) {
                typeResult = {
                    ...typeResult,
                    type: ClassType.cloneRemoveTypePromotions(typeResult.type),
                };
            }
        }

        if (inferenceContext) {
            // Handle TypeForm assignments.
            typeResult.type = convertToTypeFormType(inferenceContext.expectedType, typeResult.type);
        }

        // Don't allow speculative caching for assignment expressions because
        // the target name node won't have a corresponding type cached speculatively.
        const allowSpeculativeCaching = node.nodeType !== ParseNodeType.AssignmentExpression;

        writeTypeCache(node, typeResult, flags, inferenceContext, allowSpeculativeCaching);

        if (node.nodeType === ParseNodeType.Name || node.nodeType === ParseNodeType.MemberAccess) {
            // If this is a generic function and there is a signature tracker,
            // make sure the signature is unique.
            typeResult.type = ensureSignatureIsUnique(typeResult.type, node);
        }

        // If there was an expected type, make sure that the result type is compatible.
        if (
            inferenceContext &&
            !isAnyOrUnknown(inferenceContext.expectedType) &&
            !isNever(inferenceContext.expectedType)
        ) {
            state.expectedTypeCache.set(node.id, inferenceContext.expectedType);

            if (!typeResult.isIncomplete && !typeResult.expectedTypeDiagAddendum) {
                const diag = new DiagnosticAddendum();

                // Make sure the resulting type is assignable to the expected type.
                if (
                    !assignType(
                        inferenceContext.expectedType,
                        typeResult.type,
                        diag,
                        /* constraints */ undefined,
                        AssignTypeFlags.Default
                    )
                ) {
                    // Set the typeErrors to true, but first make a copy of the
                    // type result because the (non-error) version may already
                    // be cached.
                    typeResult = { ...typeResult, typeErrors: true };
                    typeResult.expectedTypeDiagAddendum = diag;
                    diag.addTextRange(node);
                }
            }
        }

        if (printExpressionTypes) {
            state.printExpressionSpaceCount--;
            console.log(
                `${getPrintExpressionTypesSpaces()}${ParseTreeUtils.printExpression(node)} (${getLineNum(
                    node
                )}): Post ${printType(typeResult.type)}${typeResult.isIncomplete ? ' Incomplete' : ''}`
            );
        }

        return typeResult;
    }

    // This is a helper function that implements the core of getTypeOfExpression.
    function getTypeOfExpressionCore(
        node: ExpressionNode,
        flags = EvalFlags.None,
        inferenceContext?: InferenceContext
    ): TypeResult {
        let typeResult: TypeResult | undefined;
        let expectingInstantiable = (flags & EvalFlags.InstantiableType) !== 0;

        switch (node.nodeType) {
            case ParseNodeType.Name: {
                typeResult = getTypeOfName(node, flags);
                break;
            }

            case ParseNodeType.MemberAccess: {
                typeResult = getTypeOfMemberAccess(node, flags);
                break;
            }

            case ParseNodeType.Index: {
                typeResult = getTypeOfIndex(node, flags);
                break;
            }

            case ParseNodeType.Call: {
                typeResult = useSignatureTracker(node, () => getTypeOfCall(node, flags, inferenceContext));
                break;
            }

            case ParseNodeType.Tuple: {
                typeResult = getTypeOfTuple(evaluatorInterface, node, flags, inferenceContext);
                break;
            }

            case ParseNodeType.Constant: {
                typeResult = getTypeOfConstant(node, flags);
                break;
            }

            case ParseNodeType.StringList: {
                if ((flags & EvalFlags.StrLiteralAsType) !== 0) {
                    // Don't report expecting type errors again. We will have already
                    // reported them when analyzing the contents of the string.
                    expectingInstantiable = false;
                }

                typeResult = getTypeOfStringList(node, flags);
                break;
            }

            case ParseNodeType.Number: {
                typeResult = getTypeOfNumber(node, typeResult);
                break;
            }

            case ParseNodeType.Ellipsis: {
                typeResult = getTypeOfEllipsis(flags, typeResult, node);
                break;
            }

            case ParseNodeType.UnaryOperation: {
                typeResult = getTypeOfUnaryOperation(evaluatorInterface, node, flags, inferenceContext);
                break;
            }

            case ParseNodeType.BinaryOperation: {
                let effectiveFlags = flags;

                // If we're expecting an instantiable type and this isn't a union operator,
                // don't require that the two operands are also instantiable types.
                if (expectingInstantiable && node.d.operator !== OperatorType.BitwiseOr) {
                    effectiveFlags &= ~EvalFlags.InstantiableType;
                }

                typeResult = getTypeOfBinaryOperation(evaluatorInterface, node, effectiveFlags, inferenceContext);
                break;
            }

            case ParseNodeType.AugmentedAssignment: {
                typeResult = getTypeOfAugmentedAssignment(evaluatorInterface, node, inferenceContext);
                break;
            }

            case ParseNodeType.List:
            case ParseNodeType.Set: {
                typeResult = getTypeOfListOrSet(node, flags, inferenceContext);
                break;
            }

            case ParseNodeType.Slice: {
                typeResult = getTypeOfSlice(node);
                break;
            }

            case ParseNodeType.Await: {
                typeResult = getTypeOfAwaitOperator(node, flags, inferenceContext);
                break;
            }

            case ParseNodeType.Ternary: {
                typeResult = getTypeOfTernaryOperation(evaluatorInterface, node, flags, inferenceContext);
                break;
            }

            case ParseNodeType.Comprehension: {
                typeResult = getTypeOfComprehension(node, flags, inferenceContext);
                break;
            }

            case ParseNodeType.Dictionary: {
                typeResult = getTypeOfDictionary(node, flags, inferenceContext);
                break;
            }

            case ParseNodeType.Lambda: {
                typeResult = getTypeOfLambda(node, inferenceContext);
                break;
            }

            case ParseNodeType.Assignment: {
                typeResult = getTypeOfExpression(node.d.rightExpr, flags, inferenceContext);
                assignTypeToExpression(
                    node.d.leftExpr,
                    typeResult,
                    node.d.rightExpr,
                    /* ignoreEmptyContainers */ true,
                    /* allowAssignmentToFinalVar */ true
                );
                break;
            }

            case ParseNodeType.AssignmentExpression: {
                if ((flags & EvalFlags.TypeExpression) !== 0) {
                    addDiagnostic(DiagnosticRule.reportInvalidTypeForm, LocMessage.walrusNotAllowed(), node);
                }

                typeResult = getTypeOfExpression(node.d.rightExpr, flags, inferenceContext);
                assignTypeToExpression(node.d.name, typeResult, node.d.rightExpr, /* ignoreEmptyContainers */ true);
                break;
            }

            case ParseNodeType.Yield: {
                typeResult = getTypeOfYield(node);
                break;
            }

            case ParseNodeType.YieldFrom: {
                typeResult = getTypeOfYieldFrom(node);
                break;
            }

            case ParseNodeType.Unpack: {
                typeResult = getTypeOfUnpackOperator(node, flags, inferenceContext);
                break;
            }

            case ParseNodeType.TypeAnnotation: {
                typeResult = getTypeOfExpression(
                    node.d.annotation,
                    EvalFlags.InstantiableType |
                        EvalFlags.TypeExpression |
                        EvalFlags.StrLiteralAsType |
                        EvalFlags.NoParamSpec |
                        EvalFlags.NoTypeVarTuple |
                        EvalFlags.VarTypeAnnotation
                );
                break;
            }

            case ParseNodeType.String:
            case ParseNodeType.FormatString: {
                typeResult = getTypeOfString(node);
                break;
            }

            case ParseNodeType.Error: {
                // Evaluate the child expression as best we can so the
                // type information is cached for the completion handler.
                suppressDiagnostics(node, () => {
                    if (node.d.child) {
                        getTypeOfExpression(node.d.child);
                    }
                });
                typeResult = { type: UnknownType.create() };
                break;
            }

            default:
                assertNever(node, `Illegal node type: ${(node as any).nodeType}`);
        }

        if (!typeResult) {
            // We shouldn't get here. If we do, report an error.
            fail(`Unhandled expression type '${ParseTreeUtils.printExpression(node)}'`);
        }

        // Do we need to validate that the type is instantiable?
        if (expectingInstantiable) {
            validateTypeIsInstantiable(typeResult, flags, node);
        }

        // If this is a PEP 695 type alias, remove the special form so the type
        // printer prints it as its aliased type rather than TypeAliasType.
        if ((flags & EvalFlags.TypeExpression) !== 0 && typeResult.type.props?.typeForm === undefined) {
            const specialForm = typeResult.type.props?.specialForm;
            if (specialForm && ClassType.isBuiltIn(specialForm, 'TypeAliasType')) {
                typeResult.type = TypeBase.cloneAsSpecialForm(typeResult.type, undefined);
            }
        }

        return typeResult;
    }

    // Reports the case where a function or class has been decorated with
    // @type_check_only and is used in a value expression.
    function reportUseOfTypeCheckOnly(type: Type, node: ExpressionNode) {
        let isTypeCheckingOnly = false;
        let name = '';

        if (isInstantiableClass(type) && !type.priv.includeSubclasses) {
            isTypeCheckingOnly = ClassType.isTypeCheckOnly(type);
            name = type.shared.name;
        } else if (isFunction(type)) {
            isTypeCheckingOnly = FunctionType.isTypeCheckOnly(type);
            name = type.shared.name;
        }

        if (isTypeCheckingOnly) {
            const fileInfo = AnalyzerNodeInfo.getFileInfo(node);

            if (!fileInfo.isStubFile) {
                addDiagnostic(
                    DiagnosticRule.reportGeneralTypeIssues,
                    LocMessage.typeCheckOnly().format({ name }),
                    node
                );
            }
        }
    }

    function validateTypeIsInstantiable(typeResult: TypeResult, flags: EvalFlags, node: ExpressionNode) {
        // If the type is incomplete, don't log any diagnostics yet.
        if (typeResult.isIncomplete) {
            return;
        }

        if ((flags & EvalFlags.NoTypeVarTuple) !== 0) {
            if (isTypeVarTuple(typeResult.type) && !typeResult.type.priv.isInUnion) {
                addDiagnostic(DiagnosticRule.reportInvalidTypeForm, LocMessage.typeVarTupleContext(), node);
                typeResult.type = UnknownType.create();
            }
        }

        if (isEffectivelyInstantiable(typeResult.type, { honorTypeVarBounds: true })) {
            return;
        }

        // Exempt ellipses.
        if (isClassInstance(typeResult.type) && ClassType.isBuiltIn(typeResult.type, ['EllipsisType', 'ellipsis'])) {
            return;
        }

        // Emit these errors only if we know we're evaluating a type expression.
        if ((flags & EvalFlags.TypeExpression) !== 0) {
            const diag = new DiagnosticAddendum();
            if (isUnion(typeResult.type)) {
                doForEachSubtype(typeResult.type, (subtype) => {
                    if (!isEffectivelyInstantiable(subtype, { honorTypeVarBounds: true })) {
                        diag.addMessage(LocAddendum.typeNotClass().format({ type: printType(subtype) }));
                    }
                });
            }

            addDiagnostic(
                DiagnosticRule.reportGeneralTypeIssues,
                LocMessage.typeExpectedClass().format({ type: printType(typeResult.type) }) + diag.getString(),
                node
            );

            typeResult.type = UnknownType.create();
        }

        typeResult.typeErrors = true;
    }

    function getTypeOfAwaitOperator(node: AwaitNode, flags: EvalFlags, inferenceContext?: InferenceContext) {
        if ((flags & EvalFlags.TypeExpression) !== 0) {
            addDiagnostic(DiagnosticRule.reportInvalidTypeForm, LocMessage.awaitNotAllowed(), node);
            return { type: UnknownType.create() };
        }

        const expectedType = inferenceContext
            ? specialForms.createAwaitableReturnType(
                  evaluatorInterface,
                  node,
                  inferenceContext.expectedType,
                  /* isGenerator */ false,
                  /* useCoroutine */ false
              )
            : undefined;

        const exprTypeResult = getTypeOfExpression(node.d.expr, flags, makeInferenceContext(expectedType));
        const awaitableResult = getTypeOfAwaitable(exprTypeResult, node.d.expr);
        const typeResult: TypeResult = {
            type: awaitableResult.type,
            isIncomplete: exprTypeResult.isIncomplete || awaitableResult.isIncomplete,
            typeErrors: exprTypeResult.typeErrors,
        };

        if (exprTypeResult.isIncomplete) {
            typeResult.isIncomplete = true;
        }
        return typeResult;
    }

    function getTypeOfEllipsis(flags: EvalFlags, typeResult: TypeResult | undefined, node: ExpressionNode) {
        if ((flags & EvalFlags.ConvertEllipsisToAny) !== 0) {
            typeResult = { type: AnyType.create(/* isEllipsis */ true) };
        } else {
            if ((flags & EvalFlags.TypeExpression) !== 0 && (flags & EvalFlags.AllowEllipsis) === 0) {
                addDiagnostic(DiagnosticRule.reportInvalidTypeForm, LocMessage.ellipsisContext(), node);
                typeResult = { type: UnknownType.create() };
            } else {
                const ellipsisType =
                    getBuiltInObject(node, 'EllipsisType') ?? getBuiltInObject(node, 'ellipsis') ?? AnyType.create();
                typeResult = { type: ellipsisType };
            }
        }
        return typeResult;
    }

    function getTypeOfNumber(node: NumberNode, typeResult: TypeResult | undefined) {
        if (node.d.isImaginary) {
            typeResult = { type: getBuiltInObject(node, 'complex') };
        } else if (node.d.isInteger) {
            typeResult = { type: cloneBuiltinObjectWithLiteral(node, 'int', node.d.value) };
        } else {
            typeResult = { type: getBuiltInObject(node, 'float') };
        }
        return typeResult;
    }

    function getTypeOfUnpackOperator(node: UnpackNode, flags: EvalFlags, inferenceContext?: InferenceContext) {
        let typeResult: TypeResult | undefined;
        let iterExpectedType: Type | undefined;

        if (inferenceContext) {
            const iterableType = getBuiltInType(node, 'Iterable');
            if (iterableType && isInstantiableClass(iterableType)) {
                iterExpectedType = ClassType.cloneAsInstance(
                    ClassType.specialize(iterableType, [inferenceContext.expectedType])
                );
            }
        }

        const iterTypeResult = getTypeOfExpression(node.d.expr, flags, makeInferenceContext(iterExpectedType));
        const iterType = iterTypeResult.type;
        if ((flags & EvalFlags.NoTypeVarTuple) === 0 && isTypeVarTuple(iterType) && !iterType.priv.isUnpacked) {
            typeResult = { type: TypeVarType.cloneForUnpacked(iterType) };
        } else if (
            (flags & EvalFlags.AllowUnpackedTuple) !== 0 &&
            isInstantiableClass(iterType) &&
            ClassType.isBuiltIn(iterType, 'tuple')
        ) {
            typeResult = { type: ClassType.cloneForUnpacked(iterType) };
        } else if ((flags & EvalFlags.TypeExpression) !== 0) {
            addDiagnostic(
                DiagnosticRule.reportInvalidTypeForm,
                LocMessage.unpackInAnnotation(),
                node,
                node.d.starToken
            );
            typeResult = { type: UnknownType.create() };
        } else {
            const iteratorTypeResult = getTypeOfIterator(iterTypeResult, /* isAsync */ false, node) ?? {
                type: UnknownType.create(!!iterTypeResult.isIncomplete),
                isIncomplete: iterTypeResult.isIncomplete,
            };
            typeResult = {
                type: iteratorTypeResult.type,
                typeErrors: iterTypeResult.typeErrors,
                unpackedType: iterType,
                isIncomplete: iteratorTypeResult.isIncomplete,
            };
        }

        return typeResult;
    }

    function getTypeOfStringList(node: StringListNode, flags: EvalFlags): TypeResult {
        let typeResult: TypeResult | undefined;

        if ((flags & EvalFlags.StrLiteralAsType) !== 0 && (flags & EvalFlags.TypeFormArg) === 0) {
            return getTypeOfStringListAsType(node, flags);
        }

        const isBytesNode = (node: StringNode | FormatStringNode) =>
            (node.d.token.flags & StringTokenFlags.Bytes) !== 0;

        // Check for mixing of bytes and str, which is not allowed.
        const firstStrIndex = node.d.strings.findIndex((str) => !isBytesNode(str));
        const firstBytesIndex = node.d.strings.findIndex((str) => isBytesNode(str));
        if (firstStrIndex >= 0 && firstBytesIndex >= 0) {
            addDiagnostic(
                DiagnosticRule.reportGeneralTypeIssues,
                LocMessage.mixingBytesAndStr(),
                node.d.strings[Math.max(firstBytesIndex, firstStrIndex)]
            );

            return { type: UnknownType.create() };
        }

        const isBytes = firstBytesIndex >= 0;
        let isLiteralString = true;
        let isIncomplete = false;
        let isTemplate = false;

        node.d.strings.forEach((expr) => {
            // Handle implicit concatenation.
            const typeResult = getTypeOfString(expr);

            if (typeResult.isIncomplete) {
                isIncomplete = true;
            }

            let isExprLiteralString = false;

            if (isClassInstance(typeResult.type)) {
                if (ClassType.isBuiltIn(typeResult.type, 'str') && typeResult.type.priv.literalValue !== undefined) {
                    isExprLiteralString = true;
                } else if (ClassType.isBuiltIn(typeResult?.type, 'LiteralString')) {
                    isExprLiteralString = true;
                }

                if (typeResult.type.shared.name === 'Template') {
                    isTemplate = true;
                }
            }

            if (!isExprLiteralString) {
                isLiteralString = false;
            }
        });

        if (isTemplate) {
            const templateType =
                registry.templateClass && isInstantiableClass(registry.templateClass)
                    ? ClassType.cloneAsInstance(registry.templateClass)
                    : UnknownType.create();

            typeResult = { type: templateType, isIncomplete };
        } else if (node.d.strings.some((str) => str.nodeType === ParseNodeType.FormatString)) {
            if (isLiteralString) {
                const literalStringType = getTypingType(node, 'LiteralString');
                if (literalStringType && isInstantiableClass(literalStringType)) {
                    typeResult = { type: ClassType.cloneAsInstance(literalStringType) };
                }
            }

            if (!typeResult) {
                typeResult = {
                    type: getBuiltInObject(node, isBytes ? 'bytes' : 'str'),
                    isIncomplete,
                };
            }
        } else {
            typeResult = {
                type: cloneBuiltinObjectWithLiteral(
                    node,
                    isBytes ? 'bytes' : 'str',
                    node.d.strings.map((s) => s.d.value).join('')
                ),
                isIncomplete,
            };
        }

        if (
            node.d.strings.length !== 1 ||
            node.d.strings[0].nodeType !== ParseNodeType.String ||
            !isTypeFormSupported(node)
        ) {
            return typeResult;
        }

        // For performance reasons, do not attempt to treat the string literal
        // as a TypeForm if it's going to fail anyway or is unlikely to be a
        // TypeForm (really long, triple-quoted, etc.).
        const stringNode = node.d.strings[0];
        const tokenFlags = stringNode.d.token.flags;
        const disallowedTokenFlags =
            StringTokenFlags.Bytes |
            StringTokenFlags.Raw |
            StringTokenFlags.Format |
            StringTokenFlags.Template |
            StringTokenFlags.Triplicate;
        const maxTypeFormStringLength = 256;

        if (
            (tokenFlags & disallowedTokenFlags) !== 0 ||
            stringNode.d.token.escapedValue.length >= maxTypeFormStringLength
        ) {
            return typeResult;
        }

        const typeFormResult = getTypeOfStringListAsType(node, flags);
        if (typeFormResult.type.props?.typeForm) {
            typeResult.type = TypeBase.cloneWithTypeForm(typeResult.type, typeFormResult.type.props.typeForm);
        }

        return typeResult;
    }

    function getTypeOfStringListAsType(node: StringListNode, flags: EvalFlags): TypeResult {
        const reportTypeErrors = (flags & EvalFlags.StrLiteralAsType) !== 0;
        let updatedFlags = flags | EvalFlags.ForwardRefs | EvalFlags.InstantiableType;
        let typeResult: TypeResult | undefined;

        // In most cases, annotations within a string are not parsed by the interpreter.
        // There are a few exceptions (e.g. the "bound" value for a TypeVar constructor).
        if ((flags & EvalFlags.ParsesStringLiteral) === 0) {
            updatedFlags |= EvalFlags.NotParsed;
        }

        updatedFlags &= ~EvalFlags.TypeFormArg;

        if (node.d.annotation && (flags & EvalFlags.TypeExpression) !== 0) {
            return getTypeOfExpression(node.d.annotation, updatedFlags);
        }

        if (node.d.strings.length === 1) {
            const tokenFlags = node.d.strings[0].d.token.flags;

            if (tokenFlags & StringTokenFlags.Bytes) {
                if (reportTypeErrors) {
                    addDiagnostic(DiagnosticRule.reportGeneralTypeIssues, LocMessage.annotationBytesString(), node);
                }
                return { type: UnknownType.create() };
            }

            if (tokenFlags & StringTokenFlags.Raw) {
                if (reportTypeErrors) {
                    addDiagnostic(DiagnosticRule.reportGeneralTypeIssues, LocMessage.annotationRawString(), node);
                }
                return { type: UnknownType.create() };
            }

            if (tokenFlags & StringTokenFlags.Format) {
                if (reportTypeErrors) {
                    addDiagnostic(DiagnosticRule.reportGeneralTypeIssues, LocMessage.annotationFormatString(), node);
                }
                return { type: UnknownType.create() };
            }

            if (tokenFlags & StringTokenFlags.Template) {
                if (reportTypeErrors) {
                    addDiagnostic(DiagnosticRule.reportGeneralTypeIssues, LocMessage.annotationTemplateString(), node);
                }
                return { type: UnknownType.create() };
            }

            // We didn't know at parse time that this string node was going
            // to be evaluated as a forward-referenced type. We need
            // to re-invoke the parser at this stage.
            const expr = parseStringAsTypeAnnotation(node, reportTypeErrors);
            if (expr) {
                typeResult = useSpeculativeMode(reportTypeErrors ? undefined : node, () => {
                    return getTypeOfExpression(expr, updatedFlags);
                });
            }
        }

        if (!typeResult) {
            if (reportTypeErrors) {
                addDiagnostic(DiagnosticRule.reportGeneralTypeIssues, LocMessage.expectedTypeNotString(), node);
            }
            typeResult = { type: UnknownType.create() };
        }

        return typeResult;
    }

    function getTypeOfString(node: StringNode | FormatStringNode): TypeResult {
        const isBytes = (node.d.token.flags & StringTokenFlags.Bytes) !== 0;
        let typeResult: TypeResult | undefined;
        let isIncomplete = false;

        if (node.nodeType === ParseNodeType.String) {
            typeResult = {
                type: cloneBuiltinObjectWithLiteral(node, isBytes ? 'bytes' : 'str', node.d.value),
                isIncomplete,
            };
        } else {
            const isTemplateString = (node.d.token.flags & StringTokenFlags.Template) !== 0;
            let isLiteralString = true;

            // If all of the format expressions are of type LiteralString, then
            // the resulting formatted string is also LiteralString.
            node.d.fieldExprs.forEach((expr) => {
                const exprTypeResult = getTypeOfExpression(expr);
                const exprType = exprTypeResult.type;

                if (exprTypeResult.isIncomplete) {
                    isIncomplete = true;
                }

                doForEachSubtype(exprType, (exprSubtype) => {
                    if (!isClassInstance(exprSubtype)) {
                        isLiteralString = false;
                        return;
                    }

                    if (ClassType.isBuiltIn(exprSubtype, 'LiteralString')) {
                        return;
                    }

                    if (ClassType.isBuiltIn(exprSubtype, 'str') && exprSubtype.priv.literalValue !== undefined) {
                        return;
                    }

                    isLiteralString = false;
                });
            });

            if (isTemplateString) {
                const templateType =
                    registry.templateClass && isInstantiableClass(registry.templateClass)
                        ? ClassType.cloneAsInstance(registry.templateClass)
                        : UnknownType.create();

                typeResult = { type: templateType, isIncomplete };
            } else if (!isBytes && isLiteralString) {
                const literalStringType = getTypingType(node, 'LiteralString');
                if (literalStringType && isInstantiableClass(literalStringType)) {
                    typeResult = { type: ClassType.cloneAsInstance(literalStringType), isIncomplete };
                }
            }

            if (!typeResult) {
                typeResult = {
                    type: getBuiltInObject(node, isBytes ? 'bytes' : 'str'),
                    isIncomplete,
                };

                if (isClass(typeResult.type) && typeResult.type.priv.includePromotions) {
                    typeResult.type = ClassType.cloneRemoveTypePromotions(typeResult.type);
                }
            }
        }

        return typeResult;
    }

    function stripLiteralValue(type: Type): Type {
        // Handle the not-uncommon case where the type is a union that consists
        // only of literal values.
        if (isUnion(type) && type.priv.subtypes.length > 0) {
            if (
                type.priv.literalInstances.literalStrMap?.size === type.priv.subtypes.length ||
                type.priv.literalInstances.literalIntMap?.size === type.priv.subtypes.length ||
                type.priv.literalInstances.literalEnumMap?.size === type.priv.subtypes.length
            ) {
                return stripLiteralValue(type.priv.subtypes[0]);
            }
        }

        return mapSubtypes(type, (subtype) => {
            if (isClass(subtype)) {
                if (subtype.priv.literalValue !== undefined) {
                    subtype = ClassType.cloneWithLiteral(subtype, /* value */ undefined);
                }

                if (ClassType.isBuiltIn(subtype, 'LiteralString')) {
                    // Handle "LiteralString" specially.
                    if (registry.strClass && isInstantiableClass(registry.strClass)) {
                        let strInstance = ClassType.cloneAsInstance(registry.strClass);
                        strInstance = TypeBase.cloneForCondition(strInstance, getTypeCondition(subtype));
                        return strInstance;
                    }
                }
            }

            return subtype;
        });
    }

    function getTypeOfParamAnnotation(paramTypeNode: ExpressionNode, paramCategory: ParamCategory) {
        return getTypeOfAnnotation(paramTypeNode, {
            typeVarGetsCurScope: true,
            allowUnpackedTuple: paramCategory === ParamCategory.ArgsList,
            allowUnpackedTypedDict: paramCategory === ParamCategory.KwargsDict,
        });
    }

    function getTypeOfAnnotation(node: ExpressionNode, options?: ExpectedTypeOptions): Type {
        const fileInfo = AnalyzerNodeInfo.getFileInfo(node);

        // Special-case the typing.pyi file, which contains some special
        // types that the type analyzer needs to interpret differently.
        if (fileInfo.isTypingStubFile || fileInfo.isTypingExtensionsStubFile) {
            const specialType = handleTypingStubTypeAnnotation(node);
            if (specialType) {
                return specialType;
            }
        }

        const adjustedOptions: ExpectedTypeOptions = options ? { ...options } : {};

        adjustedOptions.typeExpression = true;
        adjustedOptions.convertEllipsisToAny = true;

        // If the annotation is part of a comment, allow forward references
        // even if it's not enclosed in quotes.
        if (node?.parent?.nodeType === ParseNodeType.Assignment && node.parent.d.annotationComment === node) {
            adjustedOptions.forwardRefs = true;
            adjustedOptions.notParsed = true;
        } else if (node?.parent?.nodeType === ParseNodeType.FunctionAnnotation) {
            if (node.parent.d.returnAnnotation === node || node.parent.d.paramAnnotations.some((n) => n === node)) {
                adjustedOptions.forwardRefs = true;
                adjustedOptions.notParsed = true;
            }
        } else if (node?.parent?.nodeType === ParseNodeType.Parameter) {
            if (node.parent.d.annotationComment === node) {
                adjustedOptions.forwardRefs = true;
                adjustedOptions.notParsed = true;
            }
        }

        const annotationType = getTypeOfExpressionExpectingType(node, adjustedOptions).type;

        if (isModule(annotationType)) {
            addDiagnostic(DiagnosticRule.reportGeneralTypeIssues, LocMessage.moduleAsType(), node);
        }

        return convertToInstance(annotationType);
    }

    function canBeFalsy(type: Type, recursionCount = 0): boolean {
        type = makeTopLevelTypeVarsConcrete(type);

        if (recursionCount > maxTypeRecursionCount) {
            return true;
        }
        recursionCount++;

        switch (type.category) {
            case TypeCategory.Unbound:
            case TypeCategory.Unknown:
            case TypeCategory.Any:
            case TypeCategory.Never: {
                return true;
            }

            case TypeCategory.Union: {
                return findSubtype(type, (subtype) => canBeFalsy(subtype, recursionCount)) !== undefined;
            }

            case TypeCategory.Function:
            case TypeCategory.Overloaded:
            case TypeCategory.Module:
            case TypeCategory.TypeVar: {
                return false;
            }

            case TypeCategory.Class: {
                if (TypeBase.isInstantiable(type)) {
                    return false;
                }

                // Sentinels are always truthy.
                if (isSentinelLiteral(type)) {
                    return false;
                }

                // Handle tuples specially.
                if (isTupleClass(type) && type.priv.tupleTypeArgs) {
                    return isUnboundedTupleClass(type) || type.priv.tupleTypeArgs.length === 0;
                }

                // Handle subclasses of tuple, such as NamedTuple.
                const tupleBaseClass = type.shared.mro.find((mroClass) => !isClass(mroClass) || isTupleClass(mroClass));
                if (tupleBaseClass && isClass(tupleBaseClass) && tupleBaseClass.priv.tupleTypeArgs) {
                    return isUnboundedTupleClass(tupleBaseClass) || tupleBaseClass.priv.tupleTypeArgs.length === 0;
                }

                // Handle TypedDicts specially. If one or more entries are required
                // or known to exist, we can say for sure that the type is not falsy.
                if (ClassType.isTypedDictClass(type)) {
                    const tdEntries = getTypedDictMembersForClass(evaluatorInterface, type, /* allowNarrowed */ true);
                    if (tdEntries) {
                        for (const tdEntry of tdEntries.knownItems.values()) {
                            if (tdEntry.isRequired || tdEntry.isProvided) {
                                return false;
                            }
                        }
                    }
                }

                // Check for bool, int, str and bytes literals that are never falsy.
                if (type.priv.literalValue !== undefined) {
                    if (ClassType.isBuiltIn(type, ['bool', 'int', 'str', 'bytes'])) {
                        return !type.priv.literalValue || type.priv.literalValue === BigInt(0);
                    }

                    if (type.priv.literalValue instanceof EnumLiteral) {
                        // Does the Enum class forward the truthiness check to the
                        // underlying member type?
                        if (type.priv.literalValue.isReprEnum) {
                            return canBeFalsy(type.priv.literalValue.itemType, recursionCount);
                        }
                    }
                }

                // If this is a protocol class, don't make any assumptions about the absence
                // of specific methods. These could be provided by a class that conforms
                // to the protocol.
                if (ClassType.isProtocolClass(type)) {
                    return true;
                }

                const lenMethod = lookUpObjectMember(type, '__len__');
                if (lenMethod) {
                    return true;
                }

                const boolMethod = lookUpObjectMember(type, '__bool__');
                if (boolMethod) {
                    const boolMethodType = getTypeOfMember(boolMethod);

                    // If the __bool__ function unconditionally returns True, it can never be falsy.
                    if (isFunction(boolMethodType) && boolMethodType.shared.declaredReturnType) {
                        const returnType = boolMethodType.shared.declaredReturnType;
                        if (
                            isClassInstance(returnType) &&
                            ClassType.isBuiltIn(returnType, 'bool') &&
                            returnType.priv.literalValue === true
                        ) {
                            return false;
                        }
                    }

                    return true;
                }

                // If the class is not final, it's possible that it could be overridden
                // such that it is falsy. To be fully correct, we'd need to do the
                // following:
                // return !ClassType.isFinal(type);
                // However, pragmatically if the class is not an `object`, it's typically
                // OK to assume that it will not be overridden in this manner.
                return ClassType.isBuiltIn(type, 'object');
            }
        }
    }

    function canBeTruthy(type: Type, recursionCount = 0): boolean {
        type = makeTopLevelTypeVarsConcrete(type);

        if (recursionCount > maxTypeRecursionCount) {
            return true;
        }
        recursionCount++;

        switch (type.category) {
            case TypeCategory.Unknown:
            case TypeCategory.Function:
            case TypeCategory.Overloaded:
            case TypeCategory.Module:
            case TypeCategory.TypeVar:
            case TypeCategory.Never:
            case TypeCategory.Any: {
                return true;
            }

            case TypeCategory.Union: {
                return findSubtype(type, (subtype) => canBeTruthy(subtype, recursionCount)) !== undefined;
            }

            case TypeCategory.Unbound: {
                return false;
            }

            case TypeCategory.Class: {
                if (TypeBase.isInstantiable(type)) {
                    return true;
                }

                if (isNoneInstance(type)) {
                    return false;
                }

                // // Check for tuple[()] (an empty tuple).
                if (type.priv.tupleTypeArgs && type.priv.tupleTypeArgs.length === 0) {
                    return false;
                }

                // Check for bool, int, str and bytes literals that are never falsy.
                if (type.priv.literalValue !== undefined) {
                    if (ClassType.isBuiltIn(type, ['bool', 'int', 'str', 'bytes'])) {
                        return !!type.priv.literalValue && type.priv.literalValue !== BigInt(0);
                    }

                    if (type.priv.literalValue instanceof EnumLiteral) {
                        // Does the Enum class forward the truthiness check to the
                        // underlying member type?
                        if (type.priv.literalValue.isReprEnum) {
                            return canBeTruthy(type.priv.literalValue.itemType, recursionCount);
                        }
                    }
                }

                // If this is a protocol class, don't make any assumptions about the absence
                // of specific methods. These could be provided by a class that conforms
                // to the protocol.
                if (ClassType.isProtocolClass(type)) {
                    return true;
                }

                const boolMethod = lookUpObjectMember(type, '__bool__');
                if (boolMethod) {
                    const boolMethodType = getTypeOfMember(boolMethod);

                    // If the __bool__ function unconditionally returns False, it can never be truthy.
                    if (isFunction(boolMethodType) && boolMethodType.shared.declaredReturnType) {
                        const returnType = boolMethodType.shared.declaredReturnType;
                        if (
                            isClassInstance(returnType) &&
                            ClassType.isBuiltIn(returnType, 'bool') &&
                            returnType.priv.literalValue === false
                        ) {
                            return false;
                        }
                    }
                }

                return true;
            }
        }
    }

    // Filters a type such that that no part of it is definitely
    // truthy. For example, if a type is a union of None
    // and a custom class "Foo" that has no __len__ or __nonzero__
    // method, this method would strip off the "Foo"
    // and return only the "None".
    function removeTruthinessFromType(type: Type): Type {
        return mapSubtypes(type, (subtype) => {
            const concreteSubtype = makeTopLevelTypeVarsConcrete(subtype);

            if (isClassInstance(concreteSubtype)) {
                if (concreteSubtype.priv.literalValue !== undefined) {
                    let isLiteralFalsy: boolean;

                    if (concreteSubtype.priv.literalValue instanceof EnumLiteral) {
                        isLiteralFalsy = !canBeTruthy(concreteSubtype);
                    } else {
                        isLiteralFalsy = !concreteSubtype.priv.literalValue;
                    }

                    // If the object is already definitely falsy, it's fine to
                    // include, otherwise it should be removed.
                    return isLiteralFalsy ? subtype : undefined;
                }

                // If the object is a sentinel, we can eliminate it.
                if (isSentinelLiteral(concreteSubtype)) {
                    return undefined;
                }

                // If the object is a bool, make it "false", since
                // "true" is a truthy value.
                if (ClassType.isBuiltIn(concreteSubtype, 'bool')) {
                    return ClassType.cloneWithLiteral(concreteSubtype, /* value */ false);
                }

                // If the object is an int, str or bytes, narrow to a literal type.
                // This is slightly unsafe in that someone could subclass `int`, `str`
                // or `bytes` and override the `__bool__` method to change its behavior,
                // but this is extremely unlikely (and ill advised).
                if (ClassType.isBuiltIn(concreteSubtype, 'int')) {
                    return ClassType.cloneWithLiteral(concreteSubtype, /* value */ 0);
                } else if (ClassType.isBuiltIn(concreteSubtype, ['str', 'bytes'])) {
                    return ClassType.cloneWithLiteral(concreteSubtype, /* value */ '');
                }
            }

            // If it's possible for the type to be falsy, include it.
            if (canBeFalsy(subtype)) {
                return subtype;
            }

            return undefined;
        });
    }

    // Filters a type such that that no part of it is definitely
    // falsy. For example, if a type is a union of None
    // and an "int", this method would strip off the "None"
    // and return only the "int".
    function removeFalsinessFromType(type: Type): Type {
        return mapSubtypes(type, (subtype) => {
            const concreteSubtype = makeTopLevelTypeVarsConcrete(subtype);

            if (isClassInstance(concreteSubtype)) {
                if (concreteSubtype.priv.literalValue !== undefined) {
                    let isLiteralTruthy: boolean;

                    if (concreteSubtype.priv.literalValue instanceof EnumLiteral) {
                        isLiteralTruthy = !canBeFalsy(concreteSubtype);
                    } else if (concreteSubtype.priv.literalValue instanceof SentinelLiteral) {
                        isLiteralTruthy = true;
                    } else {
                        isLiteralTruthy = !!concreteSubtype.priv.literalValue;
                    }

                    // If the object is already definitely truthy, it's fine to
                    // include, otherwise it should be removed.
                    return isLiteralTruthy ? subtype : undefined;
                }

                // If the object is a bool, make it "true", since
                // "false" is a falsy value.
                if (ClassType.isBuiltIn(concreteSubtype, 'bool')) {
                    return ClassType.cloneWithLiteral(concreteSubtype, /* value */ true);
                }

                // If the object is a "None" instance, we can eliminate it.
                if (isNoneInstance(concreteSubtype)) {
                    return undefined;
                }

                // If this is an instance of a class that cannot be subclassed,
                // we cannot say definitively that it's not falsy because a subclass
                // could override `__bool__`. For this reason, the code should not
                // remove any classes that are not final.
                // if (!ClassType.isFinal(concreteSubtype)) {
                //     return subtype;
                // }
                // However, we're going to pragmatically assume that any classes
                // other than `object` will not be overridden in this manner.
                if (ClassType.isBuiltIn(concreteSubtype, 'object')) {
                    return subtype;
                }
            }

            // If it's possible for the type to be truthy, include it.
            if (canBeTruthy(subtype)) {
                return subtype;
            }

            return undefined;
        });
    }

    // If a type contains a TypeGuard or TypeIs, convert it to a bool.
    function stripTypeGuard(type: Type): Type {
        return mapSubtypes(type, (subtype) => {
            if (isClassInstance(subtype) && ClassType.isBuiltIn(subtype, ['TypeGuard', 'TypeIs'])) {
                return registry.boolClass ? convertToInstance(registry.boolClass) : UnknownType.create();
            }

            return subtype;
        });
    }

    function solveAndApplyConstraints(
        type: Type,
        constraints: ConstraintTracker,
        applyOptions?: ApplyTypeVarOptions,
        solveOptions?: SolveConstraintsOptions
    ): Type {
        const solution = solveConstraints(evaluatorInterface, constraints, solveOptions);
        return applySolvedTypeVars(type, solution, applyOptions);
    }

    // Gets a member type from an object or class. If it's a function, binds
    // it to the object or class. If selfType is undefined, the binding is done
    // using the objectType parameter. Callers can specify these separately
    // to handle the case where we're fetching the object member from a
    // metaclass but binding to the class.
    function getTypeOfBoundMember(
        errorNode: ExpressionNode | undefined,
        objectType: ClassType,
        memberName: string,
        usage: EvaluatorUsage = { method: 'get' },
        diag: DiagnosticAddendum | undefined = undefined,
        flags = MemberAccessFlags.Default,
        selfType?: ClassType | TypeVarType,
        recursionCount = 0
    ): TypeResult | undefined {
        if (ClassType.isPartiallyEvaluated(objectType)) {
            if (errorNode) {
                addDiagnostic(
                    DiagnosticRule.reportGeneralTypeIssues,
                    LocMessage.classDefinitionCycle().format({ name: objectType.shared.name }),
                    errorNode
                );
            }
            return { type: UnknownType.create() };
        }

        // If this is an unspecialized generic class, specialize it using the default
        // values for its type parameters.
        if (
            isInstantiableClass(objectType) &&
            !objectType.priv.includeSubclasses &&
            objectType.shared.typeParams.length > 0
        ) {
            // Skip this if we're suppressing the use of attribute access override,
            // such as with dundered methods (like __call__).
            if ((flags & MemberAccessFlags.SkipAttributeAccessOverride) === 0) {
                objectType = specializeWithDefaultTypeArgs(objectType);
            }
        }

        // Determine the class that was used to instantiate the objectType.
        // If the objectType is a class itself, then the class used to instantiate
        // it is the metaclass.
        const objectTypeIsInstantiable = TypeBase.isInstantiable(objectType);
        const metaclass = objectType.shared.effectiveMetaclass;

        let memberInfo: ClassMemberLookup | undefined;

        // If the object type is an instantiable (i.e. it derives from "type") and
        // we've been asked not to consider instance members, don't look in the class.
        // Consider only the metaclass class variables in this case.
        let skipObjectTypeLookup = objectTypeIsInstantiable && (flags & MemberAccessFlags.SkipInstanceMembers) !== 0;

        // Look up the attribute in the metaclass first. If the member is a descriptor
        // (an object with a __get__ and __set__ method) and the access is a 'get',
        // the Python runtime uses this descriptor to satisfy the lookup. Skip this
        // costly lookup in the common case where the metaclass is 'type' since we know
        // that `type` doesn't have any attributes that are descriptors.
        if (
            usage.method === 'get' &&
            objectTypeIsInstantiable &&
            metaclass &&
            isInstantiableClass(metaclass) &&
            !ClassType.isBuiltIn(metaclass, 'type') &&
            !ClassType.isSameGenericClass(metaclass, objectType)
        ) {
            const descMemberInfo = getTypeOfClassMemberName(
                errorNode,
                metaclass,
                memberName,
                usage,
                /* diag */ undefined,
                flags | MemberAccessFlags.SkipAttributeAccessOverride | MemberAccessFlags.SkipTypedDictEntries,
                objectType,
                recursionCount
            );

            if (descMemberInfo) {
                const isProperty =
                    isClassInstance(descMemberInfo.type) && ClassType.isPropertyClass(descMemberInfo.type);
                if (isDescriptorInstance(descMemberInfo.type, /* requireSetter */ true) || isProperty) {
                    skipObjectTypeLookup = true;
                }
            }
        }

        let subDiag: DiagnosticAddendum | undefined;

        if (!skipObjectTypeLookup) {
            let effectiveFlags = flags | MemberAccessFlags.SkipTypedDictEntries;

            if (objectTypeIsInstantiable) {
                effectiveFlags |=
                    MemberAccessFlags.SkipInstanceMembers |
                    MemberAccessFlags.SkipAttributeAccessOverride |
                    MemberAccessFlags.DisallowGenericInstanceVariableAccess;
                effectiveFlags &= ~MemberAccessFlags.SkipClassMembers;
            } else {
                effectiveFlags |= MemberAccessFlags.DisallowClassVarWrites;
            }

            subDiag = diag ? new DiagnosticAddendum() : undefined;

            // See if the member is present in the object itself.
            memberInfo = getTypeOfClassMemberName(
                errorNode,
                objectType,
                memberName,
                usage,
                subDiag,
                effectiveFlags,
                selfType,
                recursionCount
            );
        }

        // If it wasn't found on the object, see if it's part of the metaclass.
        if (!memberInfo && metaclass && isInstantiableClass(metaclass)) {
            let effectiveFlags = flags;

            // Class members cannot be accessed on a class's metaclass through
            // an instance of a class. Limit access to metaclass instance members
            // in this case.
            if (!objectTypeIsInstantiable) {
                effectiveFlags |=
                    MemberAccessFlags.SkipClassMembers |
                    MemberAccessFlags.SkipAttributeAccessOverride |
                    MemberAccessFlags.SkipTypeBaseClass;
                effectiveFlags &= ~MemberAccessFlags.SkipInstanceMembers;
            }

            const metaclassDiag = diag ? new DiagnosticAddendum() : undefined;
            memberInfo = getTypeOfClassMemberName(
                errorNode,
                ClassType.cloneAsInstance(metaclass),
                memberName,
                usage,
                metaclassDiag,
                effectiveFlags,
                objectTypeIsInstantiable ? objectType : ClassType.cloneAsInstantiable(objectType),
                recursionCount
            );

            // If there was a descriptor error (as opposed to an error where the members
            // was simply not found), use this diagnostic message.
            if (memberInfo?.isDescriptorError) {
                subDiag = metaclassDiag;
            }
        }

        if (memberInfo) {
            if (memberInfo.isDescriptorError && diag && subDiag) {
                diag.addAddendum(subDiag);
            }

            return {
                type: memberInfo.type,
                classType: memberInfo.classType,
                isIncomplete: !!memberInfo.isTypeIncomplete,
                isAsymmetricAccessor: memberInfo.isAsymmetricAccessor,
                narrowedTypeForSet: memberInfo.narrowedTypeForSet,
                memberAccessDeprecationInfo: memberInfo.memberAccessDeprecationInfo,
                typeErrors: memberInfo.isDescriptorError,
            };
        }

        // If this is a type[Any] or type[Unknown], allow any other members.
        if (
            isClassInstance(objectType) &&
            ClassType.isBuiltIn(objectType, 'type') &&
            objectType.priv.includeSubclasses
        ) {
            if ((flags & (MemberAccessFlags.SkipTypeBaseClass | MemberAccessFlags.SkipAttributeAccessOverride)) === 0) {
                const typeArg =
                    objectType.priv.typeArgs && objectType.priv.typeArgs.length >= 1
                        ? objectType.priv.typeArgs[0]
                        : UnknownType.create();

                if (isAnyOrUnknown(typeArg)) {
                    return { type: typeArg, classType: UnknownType.create() };
                }
            }
        }

        if (diag && subDiag) {
            diag.addAddendum(subDiag);
        }

        return undefined;
    }

    function getBoundMagicMethod(
        classType: ClassType,
        memberName: string,
        selfType?: ClassType | TypeVarType | undefined,
        errorNode?: ExpressionNode | undefined,
        diag?: DiagnosticAddendum,
        recursionCount = 0
    ): FunctionType | OverloadedType | undefined {
        const boundMethodResult = getTypeOfBoundMember(
            errorNode,
            classType,
            memberName,
            /* usage */ undefined,
            diag,
            MemberAccessFlags.SkipInstanceMembers | MemberAccessFlags.SkipAttributeAccessOverride,
            selfType,
            recursionCount
        );

        if (!boundMethodResult || boundMethodResult.typeErrors) {
            return undefined;
        }

        if (isFunctionOrOverloaded(boundMethodResult.type)) {
            return boundMethodResult.type;
        }

        if (isClassInstance(boundMethodResult.type)) {
            if (recursionCount > maxTypeRecursionCount) {
                return undefined;
            }
            recursionCount++;

            return getBoundMagicMethod(
                boundMethodResult.type,
                '__call__',
                /* selfType */ undefined,
                errorNode,
                diag,
                recursionCount
            );
        }

        if (isAnyOrUnknown(boundMethodResult.type)) {
            return getUnknownTypeForCallable();
        }

        return undefined;
    }

    // Returns the signature(s) associated with a call node that contains
    // the specified node. It also returns the index of the argument
    // that contains the node.
    function getCallSignatureInfo(
        callNode: CallNode,
        activeIndex: number,
        activeOrFake: boolean
    ): CallSignatureInfo | undefined {
        const exprNode = callNode.d.leftExpr;
        const callType = getType(exprNode);
        if (!callType) {
            return undefined;
        }

        const argList: Arg[] = [];
        let previousCategory = ArgCategory.Simple;

        // Empty arguments do not enter the AST as nodes, but instead are left blank.
        // Instead, we detect when we appear to be between two known arguments or at the
        // end of the argument list and insert a fake argument of an unknown type to have
        // something to match later.
        function addFakeArg() {
            argList.push({
                argCategory: previousCategory,
                typeResult: { type: UnknownType.create() },
                active: true,
            });
        }

        callNode.d.args.forEach((arg, index) => {
            let active = false;
            if (index === activeIndex) {
                if (activeOrFake) {
                    active = true;
                } else {
                    addFakeArg();
                }
            }

            previousCategory = arg.d.argCategory;

            argList.push({
                valueExpression: arg.d.valueExpr,
                argCategory: arg.d.argCategory,
                name: arg.d.name,
                active: active,
            });
        });

        if (callNode.d.args.length < activeIndex) {
            addFakeArg();
        }

        let signatures: CallSignature[] = [];

        function addOneFunctionToSignature(type: FunctionType) {
            let callResult: CallResult | undefined;

            useSpeculativeMode(callNode, () => {
                callResult = validateArgs(
                    exprNode,
                    argList,
                    { type },
                    /* constraints */ undefined,
                    /* skipUnknownArgCheck */ true,
                    /* inferenceContext */ undefined
                );
            });

            signatures.push({
                type: expandTypedKwargs(type),
                activeParam: callResult?.activeParam,
            });
        }

        function addFunctionToSignature(type: FunctionType | OverloadedType) {
            if (isFunction(type)) {
                addOneFunctionToSignature(type);
            } else {
                OverloadedType.getOverloads(type).forEach((func) => {
                    addOneFunctionToSignature(func);
                });
            }
        }

        doForEachSubtype(callType, (subtype) => {
            switch (subtype.category) {
                case TypeCategory.Function:
                case TypeCategory.Overloaded: {
                    addFunctionToSignature(subtype);
                    break;
                }

                case TypeCategory.Class: {
                    if (TypeBase.isInstantiable(subtype)) {
                        const constructorType = createFunctionFromConstructor(evaluatorInterface, subtype);

                        if (constructorType) {
                            doForEachSubtype(constructorType, (subtype) => {
                                if (isFunctionOrOverloaded(subtype)) {
                                    addFunctionToSignature(subtype);
                                }
                            });

                            // It's common for either the `__new__` or `__init__` methods to be
                            // simple (*args: Any, **kwargs: Any) signatures. If so, we'll try
                            // to filter out these signatures if they add nothing of value.
                            const filteredSignatures = signatures.filter(
                                (sig) =>
                                    !FunctionType.isGradualCallableForm(sig.type) ||
                                    sig.type.shared.parameters.length > 2 ||
                                    sig.type.shared.docString ||
                                    sig.type.shared.deprecatedMessage
                            );

                            if (filteredSignatures.length > 0) {
                                signatures = filteredSignatures;
                            }
                        }
                    } else {
                        const methodType = getBoundMagicMethod(subtype, '__call__');
                        if (methodType) {
                            addFunctionToSignature(methodType);
                        }
                    }
                    break;
                }
            }
        });

        if (signatures.length === 0) {
            return undefined;
        }

        return { callNode, signatures };
    }

    function expandTypedKwargs(functionType: FunctionType): FunctionType {
        return memberAccessModule.expandTypedKwargs(functionType);
    }

    // Determines whether the specified expression is an explicit TypeAlias declaration.
    function isDeclaredTypeAlias(expression: ExpressionNode): boolean {
        if (expression.nodeType === ParseNodeType.TypeAnnotation) {
            if (expression.d.valueExpr.nodeType === ParseNodeType.Name) {
                const symbolWithScope = lookUpSymbolRecursive(
                    expression,
                    expression.d.valueExpr.d.value,
                    /* honorCodeFlow */ false
                );
                if (symbolWithScope) {
                    const symbol = symbolWithScope.symbol;
                    return symbol.getDeclarations().find((decl) => isExplicitTypeAliasDeclaration(decl)) !== undefined;
                }
            }
        }

        return false;
    }

    function getDeclaredTypeForExpression(expression: ExpressionNode, usage?: EvaluatorUsage): Type | undefined {
        return symbolResolution.getDeclaredTypeForExpression(evaluatorInterface, expression, usage);
    }

    // Applies an "await" operation to the specified type and returns
    // the result. According to PEP 492, await operates on an Awaitable
    // (object that provides an __await__ that returns a generator object).
    // If errorNode is undefined, no errors are reported.
    function getTypeOfAwaitable(typeResult: TypeResult, errorNode?: ExpressionNode): TypeResult {
        if (
            !registry.awaitableClass ||
            !isInstantiableClass(registry.awaitableClass) ||
            registry.awaitableClass.shared.typeParams.length !== 1
        ) {
            return { type: UnknownType.create(), isIncomplete: typeResult.isIncomplete };
        }

        const awaitableProtocolObj = ClassType.cloneAsInstance(registry.awaitableClass);
        const isIncomplete = !!typeResult.isIncomplete;

        const type = mapSubtypes(typeResult.type, (subtype) => {
            subtype = makeTopLevelTypeVarsConcrete(subtype);

            if (isAnyOrUnknown(subtype)) {
                return subtype;
            }

            const diag = errorNode ? new DiagnosticAddendum() : undefined;

            if (isClassInstance(subtype)) {
                const constraints = new ConstraintTracker();

                if (assignType(awaitableProtocolObj, subtype, diag, constraints)) {
                    const specializedType = solveAndApplyConstraints(awaitableProtocolObj, constraints);

                    if (
                        isClass(specializedType) &&
                        specializedType.priv.typeArgs &&
                        specializedType.priv.typeArgs.length > 0
                    ) {
                        return specializedType.priv.typeArgs[0];
                    }

                    return UnknownType.create();
                }
            }

            if (errorNode && !typeResult.isIncomplete) {
                addDiagnostic(
                    DiagnosticRule.reportGeneralTypeIssues,
                    LocMessage.typeNotAwaitable().format({ type: printType(subtype) }) + diag?.getString(),
                    errorNode
                );
            }

            return UnknownType.create();
        });

        return { type, isIncomplete };
    }

    // Validates that the type is an iterator and returns the iterated type
    // (i.e. the type returned from the '__next__' or '__anext__' method).
    function getTypeOfIterator(
        typeResult: TypeResult,
        isAsync: boolean,
        errorNode: ExpressionNode,
        emitNotIterableError = true
    ): TypeResult | undefined {
        const iterMethodName = isAsync ? '__aiter__' : '__iter__';
        const nextMethodName = isAsync ? '__anext__' : '__next__';
        let isValidIterator = true;
        let isIncomplete = typeResult.isIncomplete;

        let type = transformPossibleRecursiveTypeAlias(typeResult.type);
        type = makeTopLevelTypeVarsConcrete(type);
        type = removeUnbound(type);

        if (isOptionalType(type) && emitNotIterableError) {
            if (!typeResult.isIncomplete) {
                addDiagnostic(DiagnosticRule.reportOptionalIterable, LocMessage.noneNotIterable(), errorNode);
            }
            type = removeNoneFromUnion(type);
        }

        const iterableType = mapSubtypes(type, (subtype) => {
            subtype = makeTopLevelTypeVarsConcrete(subtype);

            if (isAnyOrUnknown(subtype)) {
                return subtype;
            }

            const diag = new DiagnosticAddendum();
            if (isClass(subtype)) {
                // Handle an empty tuple specially.
                if (
                    TypeBase.isInstance(subtype) &&
                    isTupleClass(subtype) &&
                    subtype.priv.tupleTypeArgs &&
                    subtype.priv.tupleTypeArgs.length === 0
                ) {
                    return NeverType.createNever();
                }

                const iterReturnType = getTypeOfMagicMethodCall(subtype, iterMethodName, [], errorNode)?.type;

                if (!iterReturnType) {
                    // There was no __iter__. See if we can fall back to
                    // the __getitem__ method instead.
                    if (!isAsync && isClassInstance(subtype)) {
                        const getItemReturnType = getTypeOfMagicMethodCall(
                            subtype,
                            '__getitem__',
                            [
                                {
                                    type:
                                        registry.intClass && isInstantiableClass(registry.intClass)
                                            ? ClassType.cloneAsInstance(registry.intClass)
                                            : UnknownType.create(),
                                },
                            ],
                            errorNode
                        )?.type;
                        if (getItemReturnType) {
                            return getItemReturnType;
                        }
                    }

                    diag.addMessage(LocMessage.methodNotDefined().format({ name: iterMethodName }));
                } else {
                    const iterReturnTypeDiag = new DiagnosticAddendum();

                    const returnType = mapSubtypesExpandTypeVars(iterReturnType, /* options */ undefined, (subtype) => {
                        if (isAnyOrUnknown(subtype)) {
                            return subtype;
                        }

                        let nextReturnType = getTypeOfMagicMethodCall(subtype, nextMethodName, [], errorNode)?.type;

                        if (!nextReturnType) {
                            iterReturnTypeDiag.addMessage(
                                LocMessage.methodNotDefinedOnType().format({
                                    name: nextMethodName,
                                    type: printType(subtype),
                                })
                            );
                        } else {
                            // Convert any unpacked TypeVarTuples into object instances. We don't
                            // know anything more about them.
                            nextReturnType = mapSubtypes(nextReturnType, (returnSubtype) => {
                                if (isTypeVar(returnSubtype) && isUnpackedTypeVarTuple(returnSubtype)) {
                                    return getObjectType();
                                }

                                return returnSubtype;
                            });

                            if (!isAsync) {
                                return nextReturnType;
                            }

                            // If it's an async iteration, there's an implicit
                            // 'await' operator applied.
                            const awaitableResult = getTypeOfAwaitable(
                                { type: nextReturnType, isIncomplete: typeResult.isIncomplete },
                                errorNode
                            );
                            if (awaitableResult.isIncomplete) {
                                isIncomplete = true;
                            }
                            return awaitableResult.type;
                        }

                        return undefined;
                    });

                    if (iterReturnTypeDiag.isEmpty()) {
                        return returnType;
                    }

                    diag.addAddendum(iterReturnTypeDiag);
                }
            }

            if (!isIncomplete && emitNotIterableError) {
                addDiagnostic(
                    DiagnosticRule.reportGeneralTypeIssues,
                    LocMessage.typeNotIterable().format({ type: printType(subtype) }) + diag.getString(),
                    errorNode
                );
            }

            isValidIterator = false;
            return undefined;
        });

        return isValidIterator ? { type: iterableType, isIncomplete } : undefined;
    }

    // Validates that the type is an iterable and returns the iterable type argument.
    function getTypeOfIterable(
        typeResult: TypeResult,
        isAsync: boolean,
        errorNode: ExpressionNode,
        emitNotIterableError = true
    ): TypeResult | undefined {
        const iterMethodName = isAsync ? '__aiter__' : '__iter__';
        let isValidIterable = true;

        let type = makeTopLevelTypeVarsConcrete(typeResult.type);

        if (isOptionalType(type)) {
            if (!typeResult.isIncomplete && emitNotIterableError) {
                addDiagnostic(DiagnosticRule.reportOptionalIterable, LocMessage.noneNotIterable(), errorNode);
            }
            type = removeNoneFromUnion(type);
        }

        const iterableType = mapSubtypes(type, (subtype) => {
            if (isAnyOrUnknown(subtype)) {
                return subtype;
            }

            if (isClass(subtype)) {
                const iterReturnType = getTypeOfMagicMethodCall(subtype, iterMethodName, [], errorNode)?.type;

                if (iterReturnType) {
                    return makeTopLevelTypeVarsConcrete(iterReturnType);
                }
            }

            if (emitNotIterableError) {
                addDiagnostic(
                    DiagnosticRule.reportGeneralTypeIssues,
                    LocMessage.typeNotIterable().format({ type: printType(subtype) }),
                    errorNode
                );
            }

            isValidIterable = false;
            return undefined;
        });

        return isValidIterable ? { type: iterableType, isIncomplete: typeResult.isIncomplete } : undefined;
    }

    function isTypeHashable(type: Type): boolean {
        let isTypeHashable = true;

        doForEachSubtype(makeTopLevelTypeVarsConcrete(type), (subtype) => {
            if (isClassInstance(subtype)) {
                // Assume the class is hashable.
                let isObjectHashable = true;

                // Have we already computed and cached the hashability?
                if (subtype.shared.isInstanceHashable !== undefined) {
                    isObjectHashable = subtype.shared.isInstanceHashable;
                } else {
                    const hashMember = lookUpObjectMember(subtype, '__hash__', MemberAccessFlags.SkipObjectBaseClass);

                    if (hashMember && hashMember.isTypeDeclared) {
                        const decls = hashMember.symbol.getTypedDeclarations();
                        const synthesizedType = hashMember.symbol.getSynthesizedType();

                        // Handle the case where the type is synthesized (used for
                        // dataclasses).
                        if (synthesizedType) {
                            isObjectHashable = !isNoneInstance(synthesizedType.type);
                        } else {
                            // Assume that if '__hash__' is declared as a variable, it is
                            // not hashable. If it's declared as a function, it is. We'll
                            // skip evaluating its full type because that's not needed in
                            // this case.
                            if (decls.every((decl) => decl.type === DeclarationType.Variable)) {
                                isObjectHashable = false;
                            }
                        }
                    }

                    // Cache the hashability for next time.
                    subtype.shared.isInstanceHashable = isObjectHashable;
                }

                if (!isObjectHashable) {
                    isTypeHashable = false;
                }
            }
        });

        return isTypeHashable;
    }

    function getTypedDictClassType(): ClassType | undefined {
        return registry.typedDictPrivateClass && isInstantiableClass(registry.typedDictPrivateClass)
            ? registry.typedDictPrivateClass
            : undefined;
    }

    function getTupleClassType(): ClassType | undefined {
        return registry.tupleClass && isInstantiableClass(registry.tupleClass) ? registry.tupleClass : undefined;
    }

    function getDictClassType(): ClassType | undefined {
        return registry.dictClass && isInstantiableClass(registry.dictClass) ? registry.dictClass : undefined;
    }

    function getStrClassType(): ClassType | undefined {
        return registry.strClass && isInstantiableClass(registry.strClass) ? registry.strClass : undefined;
    }

    function getObjectType(): Type {
        return registry.objectClass ? convertToInstance(registry.objectClass) : UnknownType.create();
    }

    function getNoneType(): Type {
        return registry.noneTypeClass ? convertToInstance(registry.noneTypeClass) : UnknownType.create();
    }

    function getUnionClassType(): Type {
        return registry.unionTypeClass ?? UnknownType.create();
    }

    function getTypeClassType(): ClassType | undefined {
        if (registry.typeClass && isInstantiableClass(registry.typeClass)) {
            return registry.typeClass;
        }
        return undefined;
    }

    function getTypingType(node: ParseNode, symbolName: string): Type | undefined {
        return (
            getTypeOfModule(node, symbolName, ['typing']) ?? getTypeOfModule(node, symbolName, ['typing_extensions'])
        );
    }

    function getTypeCheckerInternalsType(node: ParseNode, symbolName: string): Type | undefined {
        return getTypeOfModule(node, symbolName, ['_typeshed', '_type_checker_internals']);
    }

    function getTypesType(node: ParseNode, symbolName: string): Type | undefined {
        return getTypeOfModule(node, symbolName, ['types']);
    }

    function getTypeOfModule(node: ParseNode, symbolName: string, nameParts: string[]) {
        const fileInfo = AnalyzerNodeInfo.getFileInfo(node);
        const lookupResult = importLookup({ nameParts, importingFileUri: fileInfo.fileUri });

        if (!lookupResult) {
            return undefined;
        }

        const symbol = lookupResult.symbolTable.get(symbolName);
        if (!symbol) {
            return undefined;
        }

        return getEffectiveTypeOfSymbol(symbol);
    }

    function checkCodeFlowTooComplex(node: ParseNode): boolean {
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
            addDiagnosticForTextRange(
                fileInfo,
                DiagnosticRule.reportGeneralTypeIssues,
                LocMessage.codeTooComplexToAnalyze(),
                errorRange
            );

            return true;
        }

        return false;
    }

    function isNodeReachable(node: ParseNode, sourceNode?: ParseNode): boolean {
        return getNodeReachability(node, sourceNode) === Reachability.Reachable;
    }

    function isAfterNodeReachable(node: ParseNode): boolean {
        return getAfterNodeReachability(node) === Reachability.Reachable;
    }

    function getNodeReachability(node: ParseNode, sourceNode?: ParseNode, ignoreNoReturn?: boolean): Reachability {
        if (checkCodeFlowTooComplex(node)) {
            return Reachability.Reachable;
        }

        const flowNode = AnalyzerNodeInfo.getFlowNode(node);
        if (!flowNode) {
            if (node.parent) {
                return getNodeReachability(node.parent, sourceNode, ignoreNoReturn);
            }
            return Reachability.UnreachableStructural;
        }

        const sourceFlowNode = sourceNode ? AnalyzerNodeInfo.getFlowNode(sourceNode) : undefined;

        return codeFlowEngine.getFlowNodeReachability(flowNode, sourceFlowNode, ignoreNoReturn);
    }

    function getAfterNodeReachability(node: ParseNode): Reachability {
        const returnFlowNode = AnalyzerNodeInfo.getAfterFlowNode(node);
        if (!returnFlowNode) {
            return Reachability.UnreachableStructural;
        }

        if (checkCodeFlowTooComplex(node)) {
            return Reachability.Reachable;
        }

        const reachability = codeFlowEngine.getFlowNodeReachability(returnFlowNode);
        if (reachability !== Reachability.Reachable) {
            return reachability;
        }

        const executionScopeNode = ParseTreeUtils.getExecutionScopeNode(node);
        if (!isFlowNodeReachableUsingNeverNarrowing(executionScopeNode, returnFlowNode)) {
            return Reachability.UnreachableByAnalysis;
        }

        return Reachability.Reachable;
    }

    // Although isFlowNodeReachable indicates that the node is reachable, it
    // may not be reachable if we apply "never narrowing".
    function isFlowNodeReachableUsingNeverNarrowing(node: ExecutionScopeNode, flowNode: FlowNode) {
        const analyzer = getCodeFlowAnalyzerForNode(node, /* typeAtStart */ undefined);

        if (checkCodeFlowTooComplex(node)) {
            return true;
        }

        const codeFlowResult = analyzer.getTypeFromCodeFlow(flowNode, /* reference */ undefined, {
            typeAtStart: { type: UnboundType.create() },
        });

        return codeFlowResult.type !== undefined && !isNever(codeFlowResult.type);
    }

    // Determines whether there is a code flow path from sourceNode to sinkNode.
    function isFlowPathBetweenNodes(sourceNode: ParseNode, sinkNode: ParseNode, allowSelf = true) {
        if (checkCodeFlowTooComplex(sourceNode)) {
            return true;
        }

        const sourceFlowNode = AnalyzerNodeInfo.getFlowNode(sourceNode);
        const sinkFlowNode = AnalyzerNodeInfo.getFlowNode(sinkNode);
        if (!sourceFlowNode || !sinkFlowNode) {
            return false;
        }
        if (sourceFlowNode === sinkFlowNode) {
            return allowSelf;
        }

        return (
            codeFlowEngine.getFlowNodeReachability(sinkFlowNode, sourceFlowNode, /* ignoreNoReturn */ true) ===
            Reachability.Reachable
        );
    }

    function addInformation(message: string, node: ParseNode, range?: TextRange) {
        return addDiagnosticWithSuppressionCheck('information', message, node, range);
    }

    function addUnreachableCode(node: ParseNode, reachability: Reachability, textRange: TextRange) {
        if (reachability === Reachability.Reachable) {
            return;
        }

        if (!isDiagnosticSuppressedForNode(node)) {
            const fileInfo = AnalyzerNodeInfo.getFileInfo(node);
            const reportTypeReachability = fileInfo.diagnosticRuleSet.enableReachabilityAnalysis;

            if (
                reachability === Reachability.UnreachableStructural ||
                reachability === Reachability.UnreachableStaticCondition ||
                reportTypeReachability
            ) {
                fileInfo.diagnosticSink.addUnreachableCodeWithTextRange(
                    reachability === Reachability.UnreachableStructural
                        ? LocMessage.unreachableCodeStructure()
                        : reachability === Reachability.UnreachableStaticCondition
                        ? LocMessage.unreachableCodeCondition()
                        : LocMessage.unreachableCodeType(),
                    textRange
                );
            }
        }
    }

    function addDeprecated(message: string, node: ParseNode) {
        if (!isDiagnosticSuppressedForNode(node)) {
            const fileInfo = AnalyzerNodeInfo.getFileInfo(node);
            fileInfo.diagnosticSink.addDeprecatedWithTextRange(message, node);
        }
    }

    function addDiagnosticWithSuppressionCheck(
        diagLevel: DiagnosticLevel,
        message: string,
        node: ParseNode,
        range?: TextRange
    ) {
        return state.addDiagnosticWithSuppressionCheck(diagLevel, message, node, range);
    }
    function isDiagnosticSuppressedForNode(node: ParseNode) {
        return state.isDiagnosticSuppressedForNode(node);
    }
    function canSkipDiagnosticForNode(node: ParseNode) {
        return state.canSkipDiagnosticForNode(node);
    }

    function addDiagnostic(rule: DiagnosticRule, message: string, node: ParseNode, range?: TextRange) {
        const fileInfo = AnalyzerNodeInfo.getFileInfo(node);
        const diagLevel = fileInfo.diagnosticRuleSet[rule] as DiagnosticLevel;

        if (diagLevel === 'none') {
            return undefined;
        }

        const containingFunction = ParseTreeUtils.getEnclosingFunction(node);

        if (containingFunction) {
            // Should we suppress this diagnostic because it's within an unannotated function?
            const fileInfo = AnalyzerNodeInfo.getFileInfo(node);
            if (!fileInfo.diagnosticRuleSet.analyzeUnannotatedFunctions) {
                // Is the target node within the body of the function? If so, suppress the diagnostic.
                if (
                    ParseTreeUtils.isUnannotatedFunction(containingFunction) &&
                    ParseTreeUtils.isNodeContainedWithin(node, containingFunction.d.suite)
                ) {
                    return undefined;
                }
            }

            // Should we suppress this diagnostic because it's within a no_type_check function?
            const containingClassNode = ParseTreeUtils.getEnclosingClass(containingFunction, /* stopAtFunction */ true);
            const functionInfo = getFunctionInfoFromDecorators(
                evaluatorInterface,
                containingFunction,
                !!containingClassNode
            );

            if ((functionInfo.flags & FunctionTypeFlags.NoTypeCheck) !== 0) {
                return undefined;
            }
        }

        const diagnostic = addDiagnosticWithSuppressionCheck(diagLevel, message, node, range);
        if (diagnostic) {
            diagnostic.setRule(rule);
        }

        return diagnostic;
    }

    function addDiagnosticForTextRange(
        fileInfo: AnalyzerFileInfo,
        rule: DiagnosticRule,
        message: string,
        range: TextRange
    ) {
        const diagLevel = fileInfo.diagnosticRuleSet[rule] as DiagnosticLevel;

        if (diagLevel === 'none') {
            return undefined;
        }

        const diagnostic = fileInfo.diagnosticSink.addDiagnosticWithTextRange(diagLevel, message, range);
        if (rule) {
            diagnostic.setRule(rule);
        }

        return diagnostic;
    }

    function assignTypeToNameNode(
        nameNode: NameNode,
        typeResult: TypeResult,
        ignoreEmptyContainers: boolean,
        srcExpression?: ParseNode,
        allowAssignmentToFinalVar = false,
        expectedTypeDiagAddendum?: DiagnosticAddendum
    ) {
        const nameValue = nameNode.d.value;

        const symbolWithScope = lookUpSymbolRecursive(nameNode, nameValue, /* honorCodeFlow */ false);
        if (!symbolWithScope) {
            // This can happen when we are evaluating a piece of code that was
            // determined to be unreachable by the binder.
            return;
        }

        const declarations = symbolWithScope.symbol.getDeclarations();
        let declaredType = getDeclaredTypeOfSymbol(symbolWithScope.symbol)?.type;
        const fileInfo = AnalyzerNodeInfo.getFileInfo(nameNode);

        // If this is a class scope and there is no type declared for this class variable,
        // see if a parent class has a type declared.
        if (declaredType === undefined && symbolWithScope.scope.type === ScopeType.Class) {
            const containingClass = ParseTreeUtils.getEnclosingClass(nameNode);
            if (containingClass) {
                const classType = getTypeOfClass(containingClass);
                if (classType) {
                    const memberInfo = lookUpClassMember(
                        classType.classType,
                        nameNode.d.value,
                        MemberAccessFlags.SkipOriginalClass
                    );
                    if (memberInfo?.isTypeDeclared) {
                        declaredType = getTypeOfMember(memberInfo);
                    }
                }
            }
        }

        // We found an existing declared type. Make sure the type is assignable.
        let destType = typeResult.type;
        const isTypeAlias =
            !!declaredType && isClassInstance(declaredType) && ClassType.isBuiltIn(declaredType, 'TypeAlias');

        if (declaredType && !isTypeAlias) {
            let diagAddendum = new DiagnosticAddendum();

            const liveScopeIds = ParseTreeUtils.getTypeVarScopesForNode(nameNode);
            const boundDeclaredType = makeTypeVarsBound(declaredType, liveScopeIds);
            const srcType = makeTypeVarsBound(typeResult.type, liveScopeIds);

            if (!assignType(boundDeclaredType, srcType, diagAddendum)) {
                // If there was an expected type mismatch, use that diagnostic
                // addendum because it will be more informative.
                if (expectedTypeDiagAddendum) {
                    diagAddendum = expectedTypeDiagAddendum;
                }

                if (!typeResult.isIncomplete) {
                    addDiagnostic(
                        DiagnosticRule.reportAssignmentType,
                        LocMessage.typeAssignmentMismatch().format(printSrcDestTypes(typeResult.type, declaredType)) +
                            diagAddendum.getString(),
                        srcExpression ?? nameNode,
                        diagAddendum.getEffectiveTextRange() ?? srcExpression ?? nameNode
                    );
                }

                // Replace the assigned type with the (unnarrowed) declared type.
                destType = declaredType;
            } else {
                // Constrain the resulting type to match the declared type.
                destType = narrowTypeBasedOnAssignment(declaredType, typeResult).type;
            }
        } else {
            // If this is a member name (within a class scope) and the member name
            // appears to be a constant, use the strict source type. If it's a member
            // variable that can be overridden by a child class, use the more general
            // version by stripping off the literal and TypeForm.
            const scope = ScopeUtils.getScopeForNode(nameNode);
            if (scope?.type === ScopeType.Class) {
                if (
                    TypeBase.isInstance(destType) &&
                    !isConstantName(nameValue) &&
                    !isFinalVariable(symbolWithScope.symbol)
                ) {
                    destType = stripTypeForm(stripLiteralValue(destType));
                }
            }
        }

        const varDeclIndex = declarations.findIndex((decl) => decl.type === DeclarationType.Variable);
        const varDecl = varDeclIndex >= 0 ? declarations[varDeclIndex] : undefined;

        // Are there any non-var decls before the var decl?
        const nonVarDecl = declarations.find(
            (decl, index) => varDeclIndex < index && decl.type !== DeclarationType.Variable
        );

        if (varDecl && varDecl.type === DeclarationType.Variable) {
            if (varDecl.isConstant) {
                // A constant variable can be assigned only once. If this
                // isn't the first assignment, generate an error.
                if (nameNode !== getNameNodeForDeclaration(declarations[0]) || !!nonVarDecl) {
                    addDiagnostic(
                        DiagnosticRule.reportConstantRedefinition,
                        LocMessage.constantRedefinition().format({ name: nameValue }),
                        nameNode
                    );
                }
            } else if (isFinalVariableDeclaration(varDecl) && !allowAssignmentToFinalVar) {
                addDiagnostic(
                    DiagnosticRule.reportGeneralTypeIssues,
                    LocMessage.finalReassigned().format({ name: nameValue }),
                    nameNode
                );
            }
        }

        if (!typeResult.isIncomplete) {
            reportPossibleUnknownAssignment(
                fileInfo.diagnosticRuleSet.reportUnknownVariableType,
                DiagnosticRule.reportUnknownVariableType,
                nameNode,
                typeResult.type,
                nameNode,
                ignoreEmptyContainers
            );
        }

        writeTypeCache(nameNode, { type: destType, isIncomplete: typeResult.isIncomplete }, EvalFlags.None);
    }

    function assignTypeToMemberAccessNode(
        target: MemberAccessNode,
        typeResult: TypeResult,
        srcExpr?: ExpressionNode,
        expectedTypeDiagAddendum?: DiagnosticAddendum
    ) {
        const baseTypeResult = getTypeOfExpression(target.d.leftExpr, EvalFlags.MemberAccessBaseDefaults);
        const baseType = makeTopLevelTypeVarsConcrete(baseTypeResult.type);
        let enclosingClass: ClassType | undefined;

        // Handle member accesses (e.g. self.x or cls.y).
        if (target.d.leftExpr.nodeType === ParseNodeType.Name) {
            // Determine whether we're writing to a class or instance member.
            const enclosingClassNode = ParseTreeUtils.getEnclosingClass(target);

            if (enclosingClassNode) {
                const classTypeResults = getTypeOfClass(enclosingClassNode);

                if (classTypeResults && isInstantiableClass(classTypeResults.classType)) {
                    enclosingClass = classTypeResults.classType;

                    if (isClassInstance(baseType)) {
                        if (
                            ClassType.isSameGenericClass(
                                ClassType.cloneAsInstantiable(baseType),
                                classTypeResults.classType
                            )
                        ) {
                            assignTypeToMemberVariable(target, typeResult, /* isInstanceMember */ true, srcExpr);
                        }
                    } else if (isInstantiableClass(baseType)) {
                        if (ClassType.isSameGenericClass(baseType, classTypeResults.classType)) {
                            assignTypeToMemberVariable(target, typeResult, /* isInstanceMember */ false, srcExpr);
                        }
                    }

                    // Assignments to instance or class variables through "self" or "cls" is not
                    // allowed for protocol classes unless it is also declared within the class.
                    if (ClassType.isProtocolClass(classTypeResults.classType)) {
                        const memberSymbol = ClassType.getSymbolTable(classTypeResults.classType).get(
                            target.d.member.d.value
                        );
                        if (memberSymbol) {
                            const classLevelDecls = memberSymbol.getDeclarations().filter((decl) => {
                                return !ParseTreeUtils.getEnclosingFunction(decl.node);
                            });
                            if (classLevelDecls.length === 0) {
                                addDiagnostic(
                                    DiagnosticRule.reportGeneralTypeIssues,
                                    LocMessage.assignmentInProtocol(),
                                    target.d.member
                                );
                            }
                        }
                    }
                }
            }
        }

        const setTypeResult = getTypeOfMemberAccessWithBaseType(
            target,
            baseTypeResult,
            {
                method: 'set',
                setType: typeResult,
                setErrorNode: srcExpr,
                setExpectedTypeDiag: expectedTypeDiagAddendum,
            },
            EvalFlags.None
        );

        if (setTypeResult.isAsymmetricAccessor) {
            setAsymmetricDescriptorAssignment(target);
        }

        const resultToCache: TypeResult = {
            type: setTypeResult.narrowedTypeForSet ?? typeResult.type,
            isIncomplete: typeResult.isIncomplete,
            memberAccessDeprecationInfo: setTypeResult.memberAccessDeprecationInfo,
        };
        writeTypeCache(target, resultToCache, EvalFlags.None);

        // If the target is an instance or class variable, update any class-scoped
        // type variables so the inferred type of the variable uses "external"
        // type variables.
        let memberResultToCache = resultToCache;
        if (enclosingClass?.shared.typeVarScopeId) {
            memberResultToCache = {
                ...resultToCache,
                type: makeTypeVarsFree(resultToCache.type, [enclosingClass.shared.typeVarScopeId]),
                memberAccessDeprecationInfo: setTypeResult.memberAccessDeprecationInfo,
            };
        }
        writeTypeCache(target.d.member, memberResultToCache, EvalFlags.None);
    }

    function assignTypeToMemberVariable(
        node: MemberAccessNode,
        typeResult: TypeResult,
        isInstanceMember: boolean,
        srcExprNode?: ExpressionNode
    ) {
        const memberName = node.d.member.d.value;
        const fileInfo = AnalyzerNodeInfo.getFileInfo(node);

        const classDef = ParseTreeUtils.getEnclosingClass(node);
        if (!classDef) {
            return;
        }

        const classTypeInfo = getTypeOfClass(classDef);
        if (classTypeInfo && isInstantiableClass(classTypeInfo.classType)) {
            let memberInfo = lookUpClassMember(
                classTypeInfo.classType,
                memberName,
                isInstanceMember ? MemberAccessFlags.Default : MemberAccessFlags.SkipInstanceMembers
            );

            const memberFields = ClassType.getSymbolTable(classTypeInfo.classType);
            if (memberInfo) {
                // Are we accessing an existing member on this class, or is
                // it a member on a parent class?
                const memberClass = isInstantiableClass(memberInfo.classType) ? memberInfo.classType : undefined;
                const isThisClass = memberClass && ClassType.isSameGenericClass(classTypeInfo.classType, memberClass);

                // Check for an attempt to write to an instance variable that is
                // not defined by __slots__.
                if (isThisClass && isInstanceMember && memberClass) {
                    const inheritedSlotsNames = ClassType.getInheritedSlotsNames(memberClass);

                    if (inheritedSlotsNames && memberClass.shared.localSlotsNames) {
                        // Skip this check if the local slots is specified but empty
                        // and the class isn't final. This pattern is used in a
                        // legitimate manner for mix-in classes.
                        if (
                            (memberClass.shared.localSlotsNames.length > 0 || ClassType.isFinal(memberClass)) &&
                            !inheritedSlotsNames.some((name) => name === memberName)
                        ) {
                            // Determine whether the assignment corresponds to a descriptor
                            // that was assigned as a class variable. If so, then slots will not
                            // apply in this case.
                            const classMemberDetails = lookUpClassMember(
                                memberClass,
                                memberName,
                                MemberAccessFlags.SkipInstanceMembers
                            );
                            let isPotentiallyDescriptor = false;

                            if (classMemberDetails) {
                                const classMemberSymbolType = getEffectiveTypeOfSymbol(classMemberDetails.symbol);
                                if (
                                    isAnyOrUnknown(classMemberSymbolType) ||
                                    isUnbound(classMemberSymbolType) ||
                                    isMaybeDescriptorInstance(classMemberSymbolType)
                                ) {
                                    isPotentiallyDescriptor = true;
                                }
                            }

                            if (!isPotentiallyDescriptor) {
                                addDiagnostic(
                                    DiagnosticRule.reportGeneralTypeIssues,
                                    LocMessage.slotsAttributeError().format({ name: memberName }),
                                    node.d.member
                                );
                            }
                        }
                    }
                }

                if (isThisClass && memberInfo.isInstanceMember === isInstanceMember) {
                    const symbol = memberFields.get(memberName)!;
                    assert(symbol !== undefined);

                    const typedDecls = symbol.getDeclarations();

                    // Check for an attempt to overwrite a constant member variable.
                    if (
                        typedDecls.length > 0 &&
                        typedDecls[0].type === DeclarationType.Variable &&
                        srcExprNode &&
                        node.d.member !== typedDecls[0].node
                    ) {
                        if (typedDecls[0].isConstant) {
                            addDiagnostic(
                                DiagnosticRule.reportConstantRedefinition,
                                LocMessage.constantRedefinition().format({ name: node.d.member.d.value }),
                                node.d.member
                            );
                        }
                    }
                } else {
                    // Is the target a property?
                    const declaredType = getDeclaredTypeOfSymbol(memberInfo.symbol)?.type;
                    if (declaredType && !isProperty(declaredType)) {
                        // Handle the case where there is a class variable defined with the same
                        // name, but there's also now an instance variable introduced. Combine the
                        // type of the class variable with that of the new instance variable.
                        if (!memberInfo.isInstanceMember && isInstanceMember) {
                            // The class variable is accessed in this case.
                            setSymbolAccessed(fileInfo, memberInfo.symbol, node.d.member);
                            const memberType = getTypeOfMember(memberInfo);
                            typeResult = { ...typeResult, type: combineTypes([typeResult.type, memberType]) };
                        }
                    }
                }
            }

            // Look up the member info again, now that we've potentially updated it.
            memberInfo = lookUpClassMember(classTypeInfo.classType, memberName, MemberAccessFlags.DeclaredTypesOnly);

            if (!memberInfo && srcExprNode && !typeResult.isIncomplete) {
                reportPossibleUnknownAssignment(
                    fileInfo.diagnosticRuleSet.reportUnknownMemberType,
                    DiagnosticRule.reportUnknownMemberType,
                    node.d.member,
                    typeResult.type,
                    node,
                    /* ignoreEmptyContainers */ true
                );
            }
        }
    }

    function assignTypeToTupleOrListNode(
        target: TupleNode | ListNode,
        typeResult: TypeResult,
        srcExpr: ExpressionNode
    ) {
        const targetExpressions = target.nodeType === ParseNodeType.List ? target.d.items : target.d.items;

        // Initialize the array of target types, one for each target.
        const targetTypes: Type[][] = new Array(targetExpressions.length);
        for (let i = 0; i < targetExpressions.length; i++) {
            targetTypes[i] = [];
        }
        const targetUnpackIndex = targetExpressions.findIndex((expr) => expr.nodeType === ParseNodeType.Unpack);

        // Do any of the targets use an unpack operator? If so, it will consume all of the
        // entries at that location.
        const unpackIndex = targetExpressions.findIndex((expr) => expr.nodeType === ParseNodeType.Unpack);

        typeResult = { ...typeResult, type: makeTopLevelTypeVarsConcrete(typeResult.type) };

        const diagAddendum = new DiagnosticAddendum();

        doForEachSubtype(typeResult.type, (subtype) => {
            // Is this subtype a tuple?
            const tupleType = getSpecializedTupleType(subtype);
            if (tupleType && tupleType.priv.tupleTypeArgs) {
                const sourceEntryTypes = tupleType.priv.tupleTypeArgs.map((t) =>
                    addConditionToType(t.type, getTypeCondition(subtype), { skipSelfCondition: true })
                );

                const unboundedIndex = tupleType.priv.tupleTypeArgs.findIndex((t) => t.isUnbounded);

                if (unboundedIndex >= 0) {
                    if (sourceEntryTypes.length < targetTypes.length) {
                        const typeToReplicate =
                            sourceEntryTypes.length > 0 ? sourceEntryTypes[unboundedIndex] : AnyType.create();

                        // Add elements to make the count match the target count.
                        while (sourceEntryTypes.length < targetTypes.length) {
                            sourceEntryTypes.splice(unboundedIndex, 0, typeToReplicate);
                        }
                    }

                    if (sourceEntryTypes.length > targetTypes.length) {
                        // Remove elements to make the count match the target count.
                        sourceEntryTypes.splice(unboundedIndex, 1);
                    }
                }

                // If there's an unpack operator in the target and we have too many source elements,
                // combine them to assign to the unpacked target.
                if (targetUnpackIndex >= 0) {
                    if (sourceEntryTypes.length > targetTypes.length) {
                        const removedEntries = sourceEntryTypes.splice(
                            targetUnpackIndex,
                            sourceEntryTypes.length - targetTypes.length + 1
                        );
                        let combinedTypes = combineTypes(removedEntries);
                        if (target.nodeType === ParseNodeType.List) {
                            combinedTypes = stripLiteralValue(combinedTypes);
                        }
                        sourceEntryTypes.splice(targetUnpackIndex, 0, combinedTypes);
                    } else if (sourceEntryTypes.length === targetTypes.length - 1) {
                        sourceEntryTypes.splice(targetUnpackIndex, 0, NeverType.createNever());
                    }
                }

                sourceEntryTypes.forEach((type, targetIndex) => {
                    if (targetIndex < targetTypes.length) {
                        targetTypes[targetIndex].push(type);
                    }
                });

                // Have we accounted for all of the targets and sources? If not, we have a size mismatch.
                if (sourceEntryTypes.length !== targetExpressions.length) {
                    const subDiag = diagAddendum.createAddendum();
                    subDiag.addMessage(
                        (target.nodeType === ParseNodeType.List
                            ? LocAddendum.listAssignmentMismatch()
                            : LocAddendum.tupleAssignmentMismatch()
                        ).format({
                            type: printType(subtype),
                        })
                    );

                    subDiag.createAddendum().addMessage(
                        (unpackIndex >= 0
                            ? LocAddendum.tupleSizeMismatchIndeterminateDest()
                            : LocAddendum.tupleSizeMismatch()
                        ).format({
                            expected: unpackIndex >= 0 ? targetExpressions.length - 1 : targetExpressions.length,
                            received: sourceEntryTypes.length,
                        })
                    );
                }
            } else {
                // The assigned expression isn't a tuple, so it had better
                // be some iterable type.
                const iterableType =
                    getTypeOfIterator(
                        { type: subtype, isIncomplete: typeResult.isIncomplete },
                        /* isAsync */ false,
                        srcExpr
                    )?.type ?? UnknownType.create();
                for (let index = 0; index < targetExpressions.length; index++) {
                    targetTypes[index].push(addConditionToType(iterableType, getTypeCondition(subtype)));
                }
            }
        });

        if (!diagAddendum.isEmpty()) {
            addDiagnostic(
                DiagnosticRule.reportAssignmentType,
                (target.nodeType === ParseNodeType.List
                    ? LocMessage.listAssignmentMismatch()
                    : LocMessage.tupleAssignmentMismatch()
                ).format({
                    type: printType(typeResult.type),
                }) + diagAddendum.getString(),
                target
            );
        }

        // Assign the resulting types to the individual names in the tuple
        // or list target expression.
        targetExpressions.forEach((expr, index) => {
            const typeList = targetTypes[index];
            const targetType = typeList.length === 0 ? UnknownType.create() : combineTypes(typeList);

            assignTypeToExpression(
                expr,
                { type: targetType, isIncomplete: typeResult.isIncomplete },
                srcExpr,
                /* ignoreEmptyContainers */ true
            );
        });

        writeTypeCache(target, typeResult, EvalFlags.None);
    }

    // If the type includes promotion types, expand these to their constituent types.
    function expandPromotionTypes(node: ParseNode, type: Type, excludeBytes = false): Type {
        return mapSubtypes(type, (subtype) => {
            if (!isClass(subtype) || !subtype.priv.includePromotions || subtype.priv.literalValue !== undefined) {
                return subtype;
            }

            if (excludeBytes && ClassType.isBuiltIn(subtype, 'bytes')) {
                return subtype;
            }

            const typesToCombine: Type[] = [ClassType.cloneRemoveTypePromotions(subtype)];

            const promotionTypeNames = typePromotions.get(subtype.shared.fullName);
            if (promotionTypeNames) {
                for (const promotionTypeName of promotionTypeNames) {
                    const nameSplit = promotionTypeName.split('.');
                    let promotionSubtype = getBuiltInType(node, nameSplit[nameSplit.length - 1]);

                    if (promotionSubtype && isInstantiableClass(promotionSubtype)) {
                        promotionSubtype = ClassType.cloneRemoveTypePromotions(promotionSubtype);

                        if (isClassInstance(subtype)) {
                            promotionSubtype = ClassType.cloneAsInstance(promotionSubtype);
                        }

                        promotionSubtype = addConditionToType(promotionSubtype, subtype.props?.condition);
                        typesToCombine.push(promotionSubtype);
                    }
                }
            }

            return combineTypes(typesToCombine);
        });
    }

    // Replaces all of the top-level TypeVars (as opposed to TypeVars
    // used as type arguments in other types) with their concrete form.
    // If conditionFilter is specified and the TypeVar is a constrained
    // TypeVar, only the conditions that match the filter will be included.
    function makeTopLevelTypeVarsConcrete(
        type: Type,
        makeParamSpecsConcrete = false,
        conditionFilter?: TypeCondition[]
    ): Type {
        type = transformPossibleRecursiveTypeAlias(type);

        return mapSubtypes(type, (subtype) => {
            if (isParamSpec(subtype)) {
                if (subtype.priv.paramSpecAccess === 'args') {
                    return makeTupleObject(evaluatorInterface, [{ type: getObjectType(), isUnbounded: true }]);
                } else if (subtype.priv.paramSpecAccess === 'kwargs') {
                    if (
                        registry.dictClass &&
                        isInstantiableClass(registry.dictClass) &&
                        registry.strClass &&
                        isInstantiableClass(registry.strClass)
                    ) {
                        return ClassType.cloneAsInstance(
                            ClassType.specialize(registry.dictClass, [
                                convertToInstance(registry.strClass),
                                getObjectType(),
                            ])
                        );
                    }

                    return UnknownType.create();
                }
            }

            // If this is a function that contains only a ParamSpec (no additional
            // parameters), convert it to a concrete type of (*args: Unknown, **kwargs: Unknown).
            if (makeParamSpecsConcrete && isFunction(subtype)) {
                const convertedType = simplifyFunctionToParamSpec(subtype);
                if (isParamSpec(convertedType)) {
                    return ParamSpecType.getUnknown();
                }
            }

            if (isTypeVarTuple(subtype)) {
                // If it's in a union, convert to type or object.
                if (subtype.priv.isInUnion) {
                    if (TypeBase.isInstantiable(subtype)) {
                        if (registry.typeClass && isInstantiableClass(registry.typeClass)) {
                            return registry.typeClass;
                        }
                    } else {
                        return getObjectType();
                    }

                    return AnyType.create();
                }

                // Fall back to "*tuple[object, ...]".
                return makeTupleObject(
                    evaluatorInterface,
                    [{ type: getObjectType(), isUnbounded: true }],
                    /* isUnpacked */ true
                );
            }

            if (isTypeVar(subtype)) {
                // If this is a recursive type alias placeholder
                // that hasn't yet been resolved, return it as is.
                if (subtype.shared.recursiveAlias) {
                    return subtype;
                }

                if (TypeVarType.hasConstraints(subtype)) {
                    const typesToCombine: Type[] = [];

                    // Expand the list of constrained subtypes, filtering out any that are
                    // disallowed by the conditionFilter.
                    subtype.shared.constraints.forEach((constraintType, constraintIndex) => {
                        if (conditionFilter) {
                            const typeVarName = TypeVarType.getNameWithScope(subtype);
                            const applicableConstraint = conditionFilter.find(
                                (filter) => filter.typeVar.priv.nameWithScope === typeVarName
                            );

                            // If this type variable is being constrained to a single index,
                            // don't include the other indices.
                            if (applicableConstraint && applicableConstraint.constraintIndex !== constraintIndex) {
                                return;
                            }
                        }

                        if (TypeBase.isInstantiable(subtype)) {
                            constraintType = convertToInstantiable(constraintType);
                        }

                        typesToCombine.push(
                            addConditionToType(constraintType, [{ typeVar: subtype, constraintIndex }])
                        );
                    });

                    return combineTypes(typesToCombine);
                }

                if (subtype.shared.isExemptFromBoundCheck) {
                    return AnyType.create();
                }

                // Fall back to a bound of "object" if no bound is provided.
                let boundType = subtype.shared.boundType ?? getObjectType();

                // If this is a synthesized self/cls type var, self-specialize its type arguments.
                if (TypeVarType.isSelf(subtype) && isClass(boundType) && !ClassType.isPseudoGenericClass(boundType)) {
                    boundType = selfSpecializeClass(boundType, {
                        useBoundTypeVars: TypeVarType.isBound(subtype),
                    });
                }

                if (subtype.priv.isUnpacked && isClass(boundType)) {
                    boundType = ClassType.cloneForUnpacked(boundType);
                }

                boundType = TypeBase.isInstantiable(subtype) ? convertToInstantiable(boundType) : boundType;

                return addConditionToType(boundType, [{ typeVar: subtype, constraintIndex: 0 }]);
            }

            return subtype;
        });
    }

    // Creates a new type by mapping an existing type (which could be a union)
    // to another type or types. The callback is called for each subtype.
    // Top-level TypeVars are expanded (e.g. a bound TypeVar is expanded to
    // its bound type and a constrained TypeVar is expanded to its individual
    // constrained types). If conditionFilter is specified, conditions that
    // do not match will be ignored.
    function mapSubtypesExpandTypeVars(
        type: Type,
        options: MapSubtypesOptions | undefined,
        callback: (expandedSubtype: Type, unexpandedSubtype: Type, isLastIteration: boolean) => Type | undefined,
        recursionCount = 0
    ): Type {
        const newSubtypes: Type[] = [];
        let typeChanged = false;

        function expandSubtype(unexpandedType: Type, isLastSubtype: boolean) {
            let expandedType = isUnion(unexpandedType) ? unexpandedType : makeTopLevelTypeVarsConcrete(unexpandedType);

            expandedType = transformPossibleRecursiveTypeAlias(expandedType);
            if (options?.expandCallback) {
                expandedType = options.expandCallback(expandedType);
            }

            doForEachSubtype(
                expandedType,
                (subtype, index, allSubtypes) => {
                    if (options?.conditionFilter) {
                        const filteredType = applyConditionFilterToType(
                            subtype,
                            options.conditionFilter,
                            recursionCount
                        );
                        if (!filteredType) {
                            return undefined;
                        }

                        subtype = filteredType;
                    }

                    let transformedType = callback(
                        subtype,
                        unexpandedType,
                        isLastSubtype && index === allSubtypes.length - 1
                    );

                    if (transformedType !== unexpandedType) {
                        typeChanged = true;
                    }

                    if (transformedType) {
                        // Apply the type condition if it's associated with a constrained TypeVar.
                        const typeCondition = getTypeCondition(subtype)?.filter((condition) =>
                            TypeVarType.hasConstraints(condition.typeVar)
                        );

                        if (typeCondition && typeCondition.length > 0) {
                            transformedType = addConditionToType(transformedType, typeCondition);
                        }

                        // This code path can often produce many duplicate subtypes. We can
                        // reduce the cost of the combineTypes call below by filtering out these
                        // duplicates proactively.
                        if (
                            newSubtypes.length === 0 ||
                            !isTypeSame(transformedType, newSubtypes[newSubtypes.length - 1])
                        ) {
                            newSubtypes.push(transformedType);
                        }
                    }
                    return undefined;
                },
                options?.sortSubtypes
            );
        }

        if (isUnion(type)) {
            const subtypes = options?.sortSubtypes ? sortTypes(type.priv.subtypes) : type.priv.subtypes;
            subtypes.forEach((subtype, index) => {
                expandSubtype(subtype, index === type.priv.subtypes.length - 1);
            });
        } else {
            expandSubtype(type, /* isLastSubtype */ true);
        }

        if (!typeChanged) {
            return type;
        }

        const newType = combineTypes(newSubtypes);

        // Do our best to retain type aliases.
        if (newType.category === TypeCategory.Union) {
            UnionType.addTypeAliasSource(newType, type);
        }
        return newType;
    }

    function applyConditionFilterToType(
        type: Type,
        conditionFilter: TypeCondition[],
        recursionCount: number
    ): Type | undefined {
        if (recursionCount > maxTypeRecursionCount) {
            return type;
        }
        recursionCount++;

        // If the type has a condition associated with it, make sure it's compatible.
        if (!TypeCondition.isCompatible(getTypeCondition(type), conditionFilter)) {
            return undefined;
        }

        // If the type is generic, see if any of its type arguments should be filtered.
        // This is possible only in cases where the type parameter is covariant.

        // TODO - handle functions and tuples
        if (isClass(type) && type.priv.typeArgs && !type.priv.tupleTypeArgs) {
            inferVarianceForClass(type);

            let typeWasTransformed = false;

            const filteredTypeArgs = type.priv.typeArgs.map((typeArg, index) => {
                if (index >= type.shared.typeParams.length) {
                    return typeArg;
                }

                const variance = TypeVarType.getVariance(type.shared.typeParams[index]);
                if (variance !== Variance.Covariant) {
                    return typeArg;
                }

                // Don't expand recursive type aliases because they can
                // cause infinite recursion.
                if (isTypeVar(typeArg) && typeArg.shared.recursiveAlias) {
                    return typeArg;
                }

                const filteredTypeArg = mapSubtypesExpandTypeVars(
                    typeArg,
                    { conditionFilter },
                    (expandedSubtype) => {
                        return expandedSubtype;
                    },
                    recursionCount
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

    function markNamesAccessed(node: ParseNode, names: string[]) {
        const fileInfo = AnalyzerNodeInfo.getFileInfo(node);
        const scope = ScopeUtils.getScopeForNode(node);

        if (scope) {
            names.forEach((symbolName) => {
                const symbolInScope = scope.lookUpSymbolRecursive(symbolName);
                if (symbolInScope) {
                    setSymbolAccessed(fileInfo, symbolInScope.symbol, node);
                }
            });
        }
    }

    function assignTypeToExpression(
        target: ExpressionNode,
        typeResult: TypeResult,
        srcExpr: ExpressionNode,
        ignoreEmptyContainers = false,
        allowAssignmentToFinalVar = false,
        expectedTypeDiagAddendum?: DiagnosticAddendum
    ) {
        // Is the source expression a TypeVar() call?
        if (isTypeVar(typeResult.type)) {
            if (srcExpr && srcExpr.nodeType === ParseNodeType.Call) {
                const callType = getTypeOfExpression(srcExpr.d.leftExpr, EvalFlags.CallBaseDefaults).type;
                if (
                    isInstantiableClass(callType) &&
                    (ClassType.isBuiltIn(callType, 'TypeVar') ||
                        ClassType.isBuiltIn(callType, 'TypeVarTuple') ||
                        ClassType.isBuiltIn(callType, 'ParamSpec'))
                ) {
                    const typeVarTarget =
                        target.nodeType === ParseNodeType.TypeAnnotation ? target.d.valueExpr : target;
                    if (
                        typeVarTarget.nodeType !== ParseNodeType.Name ||
                        typeVarTarget.d.value !== typeResult.type.shared.name
                    ) {
                        const name = TypeVarType.getReadableName(typeResult.type);
                        addDiagnostic(
                            DiagnosticRule.reportGeneralTypeIssues,
                            isParamSpec(typeResult.type)
                                ? LocMessage.paramSpecAssignedName().format({ name })
                                : LocMessage.typeVarAssignedName().format({ name }),
                            typeVarTarget
                        );
                    }
                }
            }
        }

        // If the type was partially unbound, an error will have already been logged.
        // Remove the unbound before assigning to the target expression so the unbound
        // error doesn't propagate.
        if (findSubtype(typeResult.type, (subtype) => isUnbound(subtype))) {
            typeResult = { ...typeResult, type: removeUnbound(typeResult.type) };
        }

        switch (target.nodeType) {
            case ParseNodeType.Name: {
                assignTypeToNameNode(
                    target,
                    typeResult,
                    ignoreEmptyContainers,
                    srcExpr,
                    allowAssignmentToFinalVar,
                    expectedTypeDiagAddendum
                );
                break;
            }

            case ParseNodeType.MemberAccess: {
                assignTypeToMemberAccessNode(target, typeResult, srcExpr, expectedTypeDiagAddendum);
                break;
            }

            case ParseNodeType.Index: {
                const baseTypeResult = getTypeOfExpression(target.d.leftExpr, EvalFlags.IndexBaseDefaults);

                getTypeOfIndexWithBaseType(
                    target,
                    baseTypeResult,
                    {
                        method: 'set',
                        setType: typeResult,
                        setErrorNode: srcExpr,
                        setExpectedTypeDiag: expectedTypeDiagAddendum,
                    },
                    EvalFlags.None
                );

                writeTypeCache(target, typeResult, EvalFlags.None);
                break;
            }

            case ParseNodeType.List:
            case ParseNodeType.Tuple: {
                assignTypeToTupleOrListNode(target, typeResult, srcExpr);
                break;
            }

            case ParseNodeType.TypeAnnotation: {
                getTypeOfAnnotation(target.d.annotation, {
                    varTypeAnnotation: true,
                    allowFinal: isFinalAllowedForAssignmentTarget(target.d.valueExpr),
                    allowClassVar: isClassVarAllowedForAssignmentTarget(target.d.valueExpr),
                });

                assignTypeToExpression(
                    target.d.valueExpr,
                    typeResult,
                    srcExpr,
                    ignoreEmptyContainers,
                    allowAssignmentToFinalVar,
                    expectedTypeDiagAddendum
                );
                break;
            }

            case ParseNodeType.Unpack: {
                assignTypeToExpression(
                    target.d.expr,
                    {
                        type: getBuiltInObject(target.d.expr, 'list', [typeResult.type]),
                        isIncomplete: typeResult.isIncomplete,
                    },
                    srcExpr,
                    ignoreEmptyContainers,
                    allowAssignmentToFinalVar,
                    expectedTypeDiagAddendum
                );
                break;
            }

            case ParseNodeType.Error: {
                // Evaluate the child expression as best we can so the
                // type information is cached for the completion handler.
                if (target.d.child) {
                    suppressDiagnostics(target.d.child, () => {
                        getTypeOfExpression(target.d.child!);
                    });
                }
                break;
            }

            default: {
                addDiagnostic(DiagnosticRule.reportGeneralTypeIssues, LocMessage.assignmentTargetExpr(), target);
                break;
            }
        }
    }

    function isClassVarAllowedForAssignmentTarget(targetNode: ExpressionNode): boolean {
        // ClassVar is allowed only in a class body.
        const classNode = ParseTreeUtils.getEnclosingClass(targetNode, /* stopAtFunction */ true);
        if (!classNode) {
            return false;
        }

        // ClassVar is not allowed in a TypedDict or a NamedTuple class.
        return !isInTypedDictOrNamedTuple(classNode);
    }

    function isFinalAllowedForAssignmentTarget(targetNode: ExpressionNode): boolean {
        const classNode = ParseTreeUtils.getEnclosingClass(targetNode, /* stopAtFunction */ true);

        // Final is not allowed in the body of a TypedDict or NamedTuple class.
        if (classNode && isInTypedDictOrNamedTuple(classNode)) {
            return false;
        }

        return ParseTreeUtils.isFinalAllowedForAssignmentTarget(targetNode);
    }

    function isInTypedDictOrNamedTuple(classNode: ClassNode): boolean {
        const classType = getTypeOfClass(classNode)?.classType;
        if (!classType) {
            return false;
        }

        return ClassType.isTypedDictClass(classType) || !!classType.shared.namedTupleEntries;
    }

    function verifyRaiseExceptionType(node: ExpressionNode, allowNone: boolean) {
        const baseExceptionType = getBuiltInType(node, 'BaseException');
        const exceptionType = getTypeOfExpression(node).type;

        // Validate that the argument of "raise" is an exception object or class.
        // If it is a class, validate that the class's constructor accepts zero
        // arguments.
        if (exceptionType && baseExceptionType && isInstantiableClass(baseExceptionType)) {
            const diag = new DiagnosticAddendum();

            doForEachSubtype(exceptionType, (subtype) => {
                const concreteSubtype = makeTopLevelTypeVarsConcrete(subtype);

                if (isAnyOrUnknown(concreteSubtype) || isNever(concreteSubtype)) {
                    return;
                }

                if (allowNone && isNoneInstance(concreteSubtype)) {
                    return;
                }

                if (isInstantiableClass(concreteSubtype) && concreteSubtype.priv.literalValue === undefined) {
                    if (!derivesFromClassRecursive(concreteSubtype, baseExceptionType, /* ignoreUnknown */ false)) {
                        diag.addMessage(
                            LocMessage.exceptionTypeIncorrect().format({
                                type: printType(subtype),
                            })
                        );
                    } else {
                        let callResult: CallResult | undefined;
                        suppressDiagnostics(node, () => {
                            callResult = validateConstructorArgs(
                                evaluatorInterface,
                                node,
                                [],
                                concreteSubtype,
                                /* skipUnknownArgCheck */ false,
                                /* inferenceContext */ undefined
                            );
                        });

                        if (callResult && callResult.argumentErrors) {
                            diag.addMessage(
                                LocMessage.exceptionTypeNotInstantiable().format({
                                    type: printType(subtype),
                                })
                            );
                        }
                    }
                } else if (isClassInstance(concreteSubtype)) {
                    if (
                        !derivesFromClassRecursive(
                            ClassType.cloneAsInstantiable(concreteSubtype),
                            baseExceptionType,
                            /* ignoreUnknown */ false
                        )
                    ) {
                        diag.addMessage(
                            LocMessage.exceptionTypeIncorrect().format({
                                type: printType(subtype),
                            })
                        );
                    }
                } else {
                    diag.addMessage(
                        LocMessage.exceptionTypeIncorrect().format({
                            type: printType(subtype),
                        })
                    );
                }
            });

            if (!diag.isEmpty()) {
                addDiagnostic(
                    DiagnosticRule.reportGeneralTypeIssues,
                    LocMessage.expectedExceptionClass() + diag.getString(),
                    node
                );
            }
        }
    }

    function verifyDeleteExpression(node: ExpressionNode) {
        switch (node.nodeType) {
            case ParseNodeType.Name: {
                // Get the type to evaluate whether it's bound
                // and to mark it accessed.
                getTypeOfExpression(node);
                break;
            }

            case ParseNodeType.MemberAccess: {
                const baseTypeResult = getTypeOfExpression(node.d.leftExpr, EvalFlags.MemberAccessBaseDefaults);
                const delAccessResult = getTypeOfMemberAccessWithBaseType(
                    node,
                    baseTypeResult,
                    { method: 'del' },
                    EvalFlags.None
                );
                const resultToCache: TypeResult = {
                    type: delAccessResult.type,
                    memberAccessDeprecationInfo: delAccessResult.memberAccessDeprecationInfo,
                };
                writeTypeCache(node.d.member, resultToCache, EvalFlags.None);
                writeTypeCache(node, resultToCache, EvalFlags.None);
                break;
            }

            case ParseNodeType.Index: {
                const baseTypeResult = getTypeOfExpression(node.d.leftExpr, EvalFlags.IndexBaseDefaults);
                getTypeOfIndexWithBaseType(node, baseTypeResult, { method: 'del' }, EvalFlags.None);
                writeTypeCache(node, { type: UnboundType.create() }, EvalFlags.None);
                break;
            }

            case ParseNodeType.Tuple: {
                node.d.items.forEach((expr) => {
                    verifyDeleteExpression(expr);
                });
                break;
            }

            case ParseNodeType.Error: {
                // Evaluate the child expression as best we can so the
                // type information is cached for the completion handler.
                if (node.d.child) {
                    suppressDiagnostics(node.d.child, () => {
                        getTypeOfExpression(node.d.child!);
                    });
                }
                break;
            }

            default: {
                addDiagnostic(DiagnosticRule.reportGeneralTypeIssues, LocMessage.delTargetExpr(), node);
                break;
            }
        }
    }

    function setSymbolAccessed(fileInfo: AnalyzerFileInfo, symbol: Symbol, node: ParseNode) {
        if (!isSpeculativeModeInUse(node)) {
            fileInfo.accessedSymbolSet.add(symbol.id);
        }
    }

    function getTypeOfName(node: NameNode, flags: EvalFlags): TypeResult {
        const fileInfo = AnalyzerNodeInfo.getFileInfo(node);
        const name = node.d.value;
        let symbol: Symbol | undefined;
        let type: Type | undefined;
        let isIncomplete = false;
        const allowForwardReferences = (flags & EvalFlags.ForwardRefs) !== 0 || fileInfo.isStubFile;

        // Look for the scope that contains the value definition and
        // see if it has a declared type.
        let symbolWithScope = lookUpSymbolRecursive(
            node,
            name,
            !allowForwardReferences,
            allowForwardReferences && (flags & EvalFlags.TypeExpression) !== 0
        );

        if (!symbolWithScope) {
            // If the node is part of a "from X import Y as Z" statement and the node
            // is the "Y" (non-aliased) name, we need to look up the alias symbol
            // since the non-aliased name is not in the symbol table.
            const alias = getAliasFromImport(node);
            if (alias) {
                symbolWithScope = lookUpSymbolRecursive(
                    alias,
                    alias.d.value,
                    !allowForwardReferences,
                    allowForwardReferences && (flags & EvalFlags.TypeExpression) !== 0
                );
            }
        }

        if (symbolWithScope) {
            let useCodeFlowAnalysis = !allowForwardReferences;

            // If the symbol is implicitly imported from the builtin
            // scope, there's no need to use code flow analysis.
            if (symbolWithScope.scope.type === ScopeType.Builtin) {
                useCodeFlowAnalysis = false;
            }

            symbol = symbolWithScope.symbol;
            setSymbolAccessed(fileInfo, symbol, node);

            // If we're not supposed to be analyzing this function, skip the remaining work
            // to determine the name's type. Simply evaluate its type as Any.
            if (!fileInfo.diagnosticRuleSet.analyzeUnannotatedFunctions) {
                const containingFunction = ParseTreeUtils.getEnclosingFunction(node);
                if (containingFunction && ParseTreeUtils.isUnannotatedFunction(containingFunction)) {
                    return {
                        type: AnyType.create(),
                        isIncomplete: false,
                    };
                }
            }

            // Get the effective type (either the declared type or the inferred type).
            // If we're using code flow analysis, pass the usage node so we consider
            // only the assignment nodes that are reachable from this usage.
            const effectiveTypeInfo = getEffectiveTypeOfSymbolForUsage(symbol, useCodeFlowAnalysis ? node : undefined);
            let effectiveType = transformPossibleRecursiveTypeAlias(effectiveTypeInfo.type);

            if (effectiveTypeInfo.isIncomplete) {
                if (isUnbound(effectiveType)) {
                    effectiveType = UnknownType.create(/* isIncomplete */ true);
                }
                isIncomplete = true;
            }

            if (effectiveTypeInfo.isRecursiveDefinition && isNodeReachable(node)) {
                addDiagnostic(
                    DiagnosticRule.reportGeneralTypeIssues,
                    LocMessage.recursiveDefinition().format({ name }),
                    node
                );
            }

            const isSpecialBuiltIn =
                !!effectiveType && isInstantiableClass(effectiveType) && ClassType.isSpecialBuiltIn(effectiveType);

            type = effectiveType;
            if (useCodeFlowAnalysis && !isSpecialBuiltIn) {
                // See if code flow analysis can tell us anything more about the type.
                // If the symbol is declared outside of our execution scope, use its effective
                // type. If it's declared inside our execution scope, it generally starts
                // as unbound at the start of the code flow.
                let typeAtStart = effectiveType;
                let isTypeAtStartIncomplete = false;

                if (!symbolWithScope.isBeyondExecutionScope && symbol.isInitiallyUnbound()) {
                    typeAtStart = UnboundType.create();

                    // Is this a module-level scope? If so, see if it's an alias of a builtin.
                    if (symbolWithScope.scope.type === ScopeType.Module) {
                        assert(symbolWithScope.scope.parent);
                        const builtInSymbol = symbolWithScope.scope.parent.lookUpSymbol(name);
                        if (builtInSymbol) {
                            const builtInEffectiveType = getEffectiveTypeOfSymbolForUsage(builtInSymbol);
                            typeAtStart = builtInEffectiveType.type;
                        }
                    }
                }

                if (symbolWithScope.isBeyondExecutionScope) {
                    const outerScopeTypeResult = getCodeFlowTypeForCapturedVariable(
                        node,
                        symbolWithScope,
                        effectiveType
                    );

                    if (outerScopeTypeResult?.type) {
                        type = outerScopeTypeResult.type;
                        typeAtStart = type;
                        isTypeAtStartIncomplete = !!outerScopeTypeResult.isIncomplete;
                    }
                }

                const codeFlowTypeResult = getFlowTypeOfReference(node, /* startNode */ undefined, {
                    targetSymbolId: symbol.id,
                    typeAtStart: { type: typeAtStart, isIncomplete: isTypeAtStartIncomplete },
                    skipConditionalNarrowing: (flags & EvalFlags.TypeExpression) !== 0,
                });

                if (codeFlowTypeResult.type) {
                    type = codeFlowTypeResult.type;
                }

                if (codeFlowTypeResult.isIncomplete) {
                    isIncomplete = true;
                }
            }

            // Detect, report, and fill in missing type arguments if appropriate.
            type = reportMissingTypeArgs(node, type, flags);

            // Report inappropriate use of variables in type expressions.
            if ((flags & EvalFlags.TypeExpression) !== 0) {
                type = validateSymbolIsTypeExpression(node, type, !!effectiveTypeInfo.includesVariableDecl);
            }

            if (isTypeVar(type) && !type.shared.isSynthesized) {
                type = validateTypeVarUsage(node, type, flags);
            }

            // Add TypeForm details if appropriate.
            type = addTypeFormForSymbol(node, type, flags, !!effectiveTypeInfo.includesVariableDecl);
        } else {
            // Handle the special case of "reveal_type" and "reveal_locals".
            if (name === 'reveal_type' || name === 'reveal_locals') {
                type = AnyType.create();
            } else {
                addDiagnostic(
                    DiagnosticRule.reportUndefinedVariable,
                    LocMessage.symbolIsUndefined().format({ name }),
                    node
                );

                type = UnknownType.create();
            }
        }

        if (isParamSpec(type) && type.priv.scopeId) {
            if (flags & EvalFlags.NoParamSpec) {
                addDiagnostic(DiagnosticRule.reportInvalidTypeForm, LocMessage.paramSpecContext(), node);
                type = UnknownType.create();
            }
        }

        // If we're expecting a type expression and got a sentinel literal instance,
        // treat it as its instantiable counterpart. This is similar to how None
        // is treated in a type expression context.
        if ((flags & EvalFlags.InstantiableType) !== 0 && isClassInstance(type) && isSentinelLiteral(type)) {
            type = ClassType.cloneAsInstantiable(type);
        }

        type = convertSpecialFormToRuntimeValue(type, flags);

        if ((flags & EvalFlags.TypeExpression) === 0) {
            reportUseOfTypeCheckOnly(type, node);
        }

        if ((flags & EvalFlags.InstantiableType) !== 0) {
            if ((flags & EvalFlags.AllowGeneric) === 0) {
                if (isInstantiableClass(type) && ClassType.isBuiltIn(type, 'Generic')) {
                    addDiagnostic(DiagnosticRule.reportGeneralTypeIssues, LocMessage.genericNotAllowed(), node);
                }
            }
        }

        return { type, isIncomplete };
    }

    function addTypeFormForSymbol(node: ExpressionNode, type: Type, flags: EvalFlags, includesVarDecl: boolean): Type {
        if (!isTypeFormSupported(node)) {
            return type;
        }

        const isValid = isSymbolValidTypeExpression(type, includesVarDecl);

        // If the type already has type information associated with it, don't replace.
        if (type.props?.typeForm) {
            // If the NoConvertSpecialForm flag is set, we are evaluating in
            // the interior of a type expression, so variables are not allowed.
            // Clear any existing type form type for this symbol in this case.
            if ((flags & EvalFlags.NoConvertSpecialForm) !== 0 && !isValid) {
                type = TypeBase.cloneWithTypeForm(type, undefined);
            }
            return type;
        }

        // If the symbol is not valid for a type expression (e.g. it's a variable),
        // don't add TypeForm info.
        if (!isValid) {
            return type;
        }

        if (isTypeVar(type) && type.priv.scopeId && !type.shared.isSynthesized) {
            if (!isTypeVarTuple(type) || !type.priv.isInUnion) {
                const liveScopeIds = ParseTreeUtils.getTypeVarScopesForNode(node);
                type = TypeBase.cloneWithTypeForm(type, convertToInstance(makeTypeVarsBound(type, liveScopeIds)));
            }
        } else if (isInstantiableClass(type) && !type.priv.includeSubclasses && !ClassType.isSpecialBuiltIn(type)) {
            if (ClassType.isBuiltIn(type, 'Any')) {
                type = TypeBase.cloneWithTypeForm(type, AnyType.create());
            } else {
                type = TypeBase.cloneWithTypeForm(type, ClassType.cloneAsInstance(specializeWithDefaultTypeArgs(type)));
            }
        }

        if (type.props?.typeAliasInfo && TypeBase.isInstantiable(type)) {
            let typeFormType = type;
            if ((flags & EvalFlags.NoSpecialize) === 0) {
                typeFormType = specializeTypeAliasWithDefaults(typeFormType, /* errorNode */ undefined);
            }

            type = TypeBase.cloneWithTypeForm(type, convertToInstance(typeFormType));
        }

        return type;
    }

    function isSymbolValidTypeExpression(type: Type, includesVarDecl: boolean): boolean {
        // Verify that the name does not refer to a (non type alias) variable.
        if (!includesVarDecl || type.props?.typeAliasInfo) {
            return true;
        }

        if (isTypeAliasPlaceholder(type)) {
            return true;
        }

        if (isTypeVar(type)) {
            if (type.props?.specialForm || type.props?.typeAliasInfo) {
                return true;
            }
        }

        // Exempts class types that are created by calling NewType, NamedTuple, etc.
        if (isClass(type) && !type.priv.includeSubclasses && ClassType.isValidTypeAliasClass(type)) {
            return true;
        }

        if (isSentinelLiteral(type)) {
            return true;
        }

        return false;
    }

    // Reports diagnostics if type isn't valid within a type expression.
    function validateSymbolIsTypeExpression(node: ExpressionNode, type: Type, includesVarDecl: boolean): Type {
        if (isSymbolValidTypeExpression(type, includesVarDecl)) {
            return type;
        }

        // Disable for assignments in the typings.pyi file, since it defines special forms.
        const fileInfo = AnalyzerNodeInfo.getFileInfo(node);
        if (fileInfo.isTypingStubFile) {
            return type;
        }

        addDiagnostic(DiagnosticRule.reportInvalidTypeForm, LocMessage.typeAnnotationVariable(), node);
        return UnknownType.create();
    }

    // If the value is a special form (like a TypeVar or `Any`) and is being
    // evaluated in a value expression context, convert it from its special
    // meaning to its runtime value. If convertModule is true, a module is
    // converted to an instance of types.ModuleType.
    function convertSpecialFormToRuntimeValue(type: Type, flags: EvalFlags, convertModule = false) {
        const exemptFlags = EvalFlags.TypeExpression | EvalFlags.InstantiableType | EvalFlags.NoConvertSpecialForm;

        if ((flags & exemptFlags) !== 0) {
            return type;
        }

        if (
            convertModule &&
            isModule(type) &&
            registry.moduleTypeClass &&
            isInstantiableClass(registry.moduleTypeClass)
        ) {
            return ClassType.cloneAsInstance(registry.moduleTypeClass);
        }

        // Isinstance treats traditional (non-PEP 695) type aliases that are unions
        // as tuples of classes rather than unions.
        if ((flags & EvalFlags.IsinstanceArg) !== 0) {
            if (isUnion(type) && type.props?.typeAliasInfo && !type.props.typeAliasInfo.shared.isTypeAliasType) {
                return type;
            }
        }

        if (!type.props?.specialForm) {
            return type;
        }

        // If this is a type alias and we are not supposed to specialize it, return it as is.
        if ((flags & EvalFlags.NoSpecialize) !== 0 && type.props?.typeAliasInfo) {
            // Special-case TypeAliasType which should be converted in this case.
            if (!ClassType.isBuiltIn(type.props.specialForm, 'TypeAliasType')) {
                return type;
            }
        }

        if (type.props?.typeForm) {
            return TypeBase.cloneWithTypeForm(type.props.specialForm, type.props.typeForm);
        }

        return type.props.specialForm;
    }

    // Handles the case where a variable or parameter is defined in an outer
    // scope and captured by an inner scope (a function, lambda, or comprehension).
    function getCodeFlowTypeForCapturedVariable(
        node: NameNode,
        symbolWithScope: SymbolWithScope,
        effectiveType: Type
    ): FlowNodeTypeResult | undefined {
        // This function applies only to captured variables, not those that
        // are accessed via an explicit nonlocal or global binding.
        if (symbolWithScope.usesGlobalBinding || symbolWithScope.usesNonlocalBinding) {
            return undefined;
        }

        // This function applies only to variables, parameters, and imports, not to other
        // types of symbols.
        const decls = symbolWithScope.symbol.getDeclarations();
        if (
            !decls.every(
                (decl) =>
                    decl.type === DeclarationType.Variable ||
                    decl.type === DeclarationType.Param ||
                    decl.type === DeclarationType.Alias
            )
        ) {
            return undefined;
        }

        // If the symbol is modified in scopes other than the one in which it is
        // declared (e.g. through a nonlocal or global binding), it is not eligible
        // for code flow analysis.
        if (
            !decls.every(
                (decl) =>
                    decl.type === DeclarationType.Param ||
                    ScopeUtils.getScopeForNode(decl.node) === symbolWithScope.scope
            )
        ) {
            return undefined;
        }

        // If the symbol is a non-final variable in the global scope, it is not
        // eligible because it could be modified by other modules.
        if (
            !decls.every(
                (decl) =>
                    decl.type !== DeclarationType.Variable ||
                    decl.isFinal ||
                    ScopeUtils.getScopeForNode(decl.node)?.type !== ScopeType.Module
            )
        ) {
            return undefined;
        }

        // If the symbol is a variable captured by an inner function
        // or lambda, see if we can infer the type from the outer scope.
        const scopeHierarchy = ScopeUtils.getScopeHierarchy(node, symbolWithScope.scope);

        if (scopeHierarchy && scopeHierarchy.length >= 2) {
            // Find the parse node associated with the scope that is just inside of the
            // scope that declares the captured variable.
            const innerScopeNode = ScopeUtils.findTopNodeInScope(node, scopeHierarchy[scopeHierarchy.length - 2]);
            if (
                innerScopeNode?.nodeType === ParseNodeType.Function ||
                innerScopeNode?.nodeType === ParseNodeType.Lambda ||
                innerScopeNode?.nodeType === ParseNodeType.Class
            ) {
                const innerScopeCodeFlowNode = AnalyzerNodeInfo.getFlowNode(innerScopeNode);
                if (innerScopeCodeFlowNode) {
                    // See if any of the assignments of the symbol are reachable
                    // from this node. If so, we cannot apply any narrowing because
                    // the type could change after the capture.
                    if (
                        symbolWithScope.symbol.getDeclarations().every((decl) => {
                            // Parameter declarations always start life at the beginning
                            // of the execution scope, so they are always safe to narrow.
                            if (decl.type === DeclarationType.Param) {
                                return true;
                            }

                            const declCodeFlowNode = AnalyzerNodeInfo.getFlowNode(decl.node);
                            if (!declCodeFlowNode) {
                                return false;
                            }

                            return (
                                codeFlowEngine.getFlowNodeReachability(
                                    declCodeFlowNode,
                                    innerScopeCodeFlowNode,
                                    /* ignoreNoReturn */ true
                                ) !== Reachability.Reachable
                            );
                        })
                    ) {
                        let typeAtStart = effectiveType;
                        if (symbolWithScope.symbol.isInitiallyUnbound()) {
                            typeAtStart = UnboundType.create();
                        }

                        return getFlowTypeOfReference(node, innerScopeNode, {
                            targetSymbolId: symbolWithScope.symbol.id,
                            typeAtStart: { type: typeAtStart },
                        });
                    }
                }
            }
        }

        return undefined;
    }

    // Validates that a TypeVar is valid in this context. If so, it clones it
    // and provides a scope ID defined by its containing scope (class, function
    // or type alias). If not, it emits errors indicating why the TypeVar
    // cannot be used in this location.
    function validateTypeVarUsage(node: ExpressionNode, type: TypeVarType, flags: EvalFlags) {
        if (!TypeBase.isInstantiable(type) || isTypeAliasPlaceholder(type)) {
            return type;
        }

        // If the TypeVar doesn't have a scope ID, try to assign one.
        if (!type.priv.scopeId) {
            type = assignTypeVarScopeId(node, type, flags);
        }

        // If this is a free type var, see if we need to make it into a bound type var.
        if (type.priv.scopeId && !TypeVarType.isBound(type)) {
            // If this is a reference to a TypeVar defined in an outer scope,
            // mark it as bound.
            const scopedNode = findScopedTypeVar(node, type)?.scopeNode;

            if (scopedNode) {
                const enclosingSuite = ParseTreeUtils.getEnclosingClassOrFunctionSuite(node);

                if (enclosingSuite && ParseTreeUtils.isNodeContainedWithin(enclosingSuite, scopedNode)) {
                    if (scopedNode.nodeType !== ParseNodeType.Class || scopedNode.d.suite !== enclosingSuite) {
                        type = TypeVarType.cloneAsBound(type);
                    }
                }
            }
        }

        // If this is a TypeVarTuple, the name refers to the packed form. It
        // must be unpacked in most contexts.
        if (isUnpackedTypeVarTuple(type)) {
            type = TypeVarType.cloneForPacked(type);
        }

        if ((flags & EvalFlags.EnforceClassTypeVarScope) !== 0 && !enforceClassTypeVarScope(node, type)) {
            return UnknownType.create();
        }

        return type;
    }

    function assignTypeVarScopeId(node: ExpressionNode, type: TypeVarType, flags: EvalFlags): TypeVarType {
        const scopedTypeVarInfo = findScopedTypeVar(node, type);
        type = scopedTypeVarInfo.type;

        if ((flags & EvalFlags.NoTypeVarWithScopeId) !== 0 && !!type.priv.scopeId) {
            if (type.shared.isSynthesized || isParamSpec(type)) {
                return type;
            }

            // This TypeVar already has a scope ID assigned to it. See if it
            // originates from type parameter syntax. If so, allow it.
            if (type.shared.isTypeParamSyntax) {
                return type;
            }

            // If this type variable expression is used within a generic class,
            // function, or type alias that uses type parameter syntax, there is
            // no need to report an error here.
            const typeVarScopeNode = ParseTreeUtils.getTypeVarScopeNode(node);
            if (
                typeVarScopeNode &&
                typeVarScopeNode.d.typeParams &&
                !typeVarScopeNode.d.typeParams.d.params.some((t) => t.d.name === node)
            ) {
                return type;
            }

            addDiagnostic(
                DiagnosticRule.reportGeneralTypeIssues,
                LocMessage.typeVarUsedByOuterScope().format({ name: type.shared.name }),
                node
            );

            return type;
        }

        if ((flags & EvalFlags.TypeVarGetsCurScope) !== 0) {
            if (type.priv.scopeId) {
                return type;
            }

            if (scopedTypeVarInfo.foundInterveningClass) {
                addDiagnostic(
                    DiagnosticRule.reportGeneralTypeIssues,
                    LocMessage.typeVarUsedByOuterScope().format({ name: type.shared.name }),
                    node
                );
                return type;
            }

            let enclosingScope = ParseTreeUtils.getEnclosingClassOrFunction(node);

            // Handle P.args and P.kwargs as a special case for inner functions.
            if (
                enclosingScope &&
                node.parent?.nodeType === ParseNodeType.MemberAccess &&
                node.parent.d.leftExpr === node
            ) {
                const memberName = node.parent.d.member.d.value;
                if (memberName === 'args' || memberName === 'kwargs') {
                    const outerFunctionScope = ParseTreeUtils.getEnclosingClassOrFunction(enclosingScope);

                    if (outerFunctionScope?.nodeType === ParseNodeType.Function) {
                        enclosingScope = outerFunctionScope;
                    } else if (!scopedTypeVarInfo.type.priv.scopeId) {
                        addDiagnostic(
                            DiagnosticRule.reportGeneralTypeIssues,
                            LocMessage.paramSpecNotUsedByOuterScope().format({
                                name: type.shared.name,
                            }),
                            node
                        );
                    }
                }
            }

            if (!enclosingScope) {
                fail('AssociateTypeVarsWithCurrentScope flag was set but enclosing scope not found');
            }

            // If the enclosing scope is using type parameter syntax, traditional
            // type variables can't be used in this context.
            if (
                enclosingScope.d.typeParams &&
                !enclosingScope.d.typeParams.d.params.some((param) => param.d.name.d.value === type.shared.name)
            ) {
                addDiagnostic(
                    DiagnosticRule.reportGeneralTypeIssues,
                    LocMessage.typeParameterNotDeclared().format({
                        name: type.shared.name,
                        container: enclosingScope.d.name.d.value,
                    }),
                    node
                );
            }

            const scopeIdToAssign = ParseTreeUtils.getScopeIdForNode(enclosingScope);

            return TypeVarType.cloneForScopeId(
                type,
                scopeIdToAssign,
                enclosingScope.d.name.d.value,
                enclosingScope.nodeType === ParseNodeType.Function ? TypeVarScopeType.Function : TypeVarScopeType.Class
            );
        }

        if ((flags & EvalFlags.AllowTypeVarWithoutScopeId) === 0) {
            if (type.priv.scopeId && !scopedTypeVarInfo.foundInterveningClass) {
                return type;
            }

            if (!type.shared.isSynthesized && (flags & EvalFlags.InstantiableType) !== 0) {
                const message = isParamSpec(type)
                    ? LocMessage.paramSpecNotUsedByOuterScope()
                    : LocMessage.typeVarNotUsedByOuterScope();
                addDiagnostic(DiagnosticRule.reportGeneralTypeIssues, message.format({ name: type.shared.name }), node);
            }
        }

        return type;
    }

    // Enforce that the type variable is scoped to the enclosing class or
    // an outer class that contains the class definition.
    function enforceClassTypeVarScope(node: ExpressionNode, type: TypeVarType): boolean {
        const scopeId = type.priv.freeTypeVar?.priv.scopeId ?? type.priv.scopeId;
        if (!scopeId) {
            return true;
        }

        const enclosingClass = ParseTreeUtils.getEnclosingClass(node);
        if (enclosingClass) {
            const liveTypeVarScopeIds = ParseTreeUtils.getTypeVarScopesForNode(enclosingClass);
            if (!liveTypeVarScopeIds.includes(scopeId)) {
                addDiagnostic(
                    DiagnosticRule.reportGeneralTypeIssues,
                    LocMessage.typeVarInvalidForMemberVariable().format({
                        name: TypeVarType.getReadableName(type),
                    }),
                    node
                );

                return false;
            }
        }

        return true;
    }

    // Determines if the type is a generic class or type alias with missing
    // type arguments. If so, it fills in these type arguments with Unknown
    // and optionally reports an error.
    function reportMissingTypeArgs(node: ExpressionNode, type: Type, flags: EvalFlags): Type {
        if ((flags & EvalFlags.NoSpecialize) !== 0) {
            return type;
        }

        // Is this a generic class that needs to be specialized?
        if (isInstantiableClass(type)) {
            if ((flags & EvalFlags.InstantiableType) !== 0 && (flags & EvalFlags.AllowMissingTypeArgs) === 0) {
                if (!type.props?.typeAliasInfo && requiresTypeArgs(type)) {
                    if (!type.priv.typeArgs || !type.priv.isTypeArgExplicit) {
                        addDiagnostic(
                            DiagnosticRule.reportMissingTypeArgument,
                            LocMessage.typeArgsMissingForClass().format({
                                name: type.priv.aliasName || type.shared.name,
                            }),
                            node
                        );
                    }
                }
            }

            if (!type.priv.typeArgs) {
                type = specialForms.createSpecializedClassType(
                    evaluatorInterface,
                    type,
                    /* typeArgs */ undefined,
                    flags,
                    node,
                    registry
                )?.type;
            }
        }

        // Is this a generic type alias that needs to be specialized?
        if ((flags & EvalFlags.InstantiableType) !== 0) {
            type = specializeTypeAliasWithDefaults(type, node);
        }

        return type;
    }

    // Walks up the parse tree to find a function, class, or type alias
    // declaration that provides the context for a type variable.
    function findScopedTypeVar(node: ExpressionNode, type: TypeVarType): ScopedTypeVarResult {
        let curNode: ParseNode | undefined = node;
        let nestedClassCount = 0;

        assert(TypeBase.isInstantiable(type));

        while (curNode) {
            const scopeNode = ParseTreeUtils.getTypeVarScopeNode(curNode);
            if (!scopeNode) {
                break;
            }
            curNode = scopeNode;

            let typeParamsForScope: TypeVarType[] | undefined;
            let scopeUsesTypeParamSyntax = false;

            if (curNode.nodeType === ParseNodeType.Class) {
                const classTypeInfo = getTypeOfClass(curNode);
                if (classTypeInfo && !ClassType.isPartiallyEvaluated(classTypeInfo.classType)) {
                    typeParamsForScope = classTypeInfo.classType.shared.typeParams;
                }

                scopeUsesTypeParamSyntax = !!curNode.d.typeParams;
                nestedClassCount++;
            } else if (curNode.nodeType === ParseNodeType.Function) {
                const functionType = getTypeOfFunctionPredecorated(curNode);
                if (functionType) {
                    const functionDetails = functionType.shared;
                    typeParamsForScope = functionDetails.typeParams;
                }

                scopeUsesTypeParamSyntax = !!curNode.d.typeParams;
            } else if (curNode.nodeType === ParseNodeType.TypeAlias) {
                scopeUsesTypeParamSyntax = !!curNode.d.typeParams;
            }

            if (typeParamsForScope) {
                const match = typeParamsForScope.find((typeVar) => typeVar.shared.name === type.shared.name);

                if (
                    match?.priv.scopeId !== undefined &&
                    match.priv.scopeName !== undefined &&
                    match.priv.scopeType !== undefined
                ) {
                    // Use the scoped version of the TypeVar rather than the (unscoped) original type.
                    type = TypeVarType.cloneForScopeId(
                        type,
                        match.priv.scopeId,
                        match.priv.scopeName,
                        match.priv.scopeType
                    );
                    type.shared.declaredVariance = match.shared.declaredVariance;
                    return {
                        type,
                        scopeNode,
                        foundInterveningClass: nestedClassCount > 1 && !scopeUsesTypeParamSyntax,
                    };
                }
            }

            curNode = curNode.parent;
        }

        // See if this is part of an assignment statement that is defining a type alias.
        curNode = node;
        while (curNode) {
            let leftType: Type | undefined;
            let typeAliasNode: TypeAliasNode | undefined;
            let scopeNode: TypeAliasNode | AssignmentNode | undefined;

            if (curNode.nodeType === ParseNodeType.TypeAlias) {
                leftType = readTypeCache(curNode.d.name, EvalFlags.None);
                typeAliasNode = curNode;
                scopeNode = curNode;
            } else if (curNode.nodeType === ParseNodeType.Assignment) {
                leftType = readTypeCache(curNode.d.leftExpr, EvalFlags.None);
                scopeNode = curNode;
            }

            if (leftType && scopeNode) {
                // Is this a placeholder that was temporarily written to the cache for
                // purposes of resolving type aliases?
                if (leftType && isTypeVar(leftType) && leftType.shared.recursiveAlias) {
                    // Type alias statements cannot be used with old-style type variables.
                    if (typeAliasNode && !type.shared.isTypeParamSyntax && !type.props?.typeAliasInfo) {
                        addDiagnostic(
                            DiagnosticRule.reportGeneralTypeIssues,
                            LocMessage.typeParameterNotDeclared().format({
                                name: type.shared.name,
                                container: typeAliasNode.d.name.d.value,
                            }),
                            node
                        );
                    } else {
                        // If this is a TypeAliasType call, the recursive type parameters will already
                        // be populated, and we need to verify that the type parameter is in the
                        // list of allowed type parameters.
                        const allowedTypeParams = leftType.shared.recursiveAlias?.typeParams;
                        if (allowedTypeParams) {
                            if (!allowedTypeParams.some((param) => param.shared.name === type.shared.name)) {
                                // Return the original type.
                                return { type, scopeNode, foundInterveningClass: false };
                            }
                        }
                    }

                    return {
                        type: TypeVarType.cloneForScopeId(
                            type,
                            leftType.shared.recursiveAlias.typeVarScopeId,
                            leftType.shared.recursiveAlias.name,
                            TypeVarScopeType.TypeAlias
                        ),
                        scopeNode,
                        foundInterveningClass: false,
                    };
                }
            }

            curNode = curNode.parent;
        }

        // Return the original type.
        return { type, scopeNode: undefined, foundInterveningClass: false };
    }

    function getTypeOfMemberAccess(node: MemberAccessNode, flags: EvalFlags): TypeResult {
        // Compute flags specifically for evaluating the left expression.
        let leftExprFlags = EvalFlags.MemberAccessBaseDefaults;
        leftExprFlags |=
            flags &
            (EvalFlags.TypeExpression |
                EvalFlags.VarTypeAnnotation |
                EvalFlags.ForwardRefs |
                EvalFlags.NotParsed |
                EvalFlags.NoTypeVarWithScopeId |
                EvalFlags.TypeVarGetsCurScope);

        // Handle special casing for ParamSpec "args" and "kwargs" accesses.
        if ((flags & EvalFlags.InstantiableType) !== 0) {
            const memberName = node.d.member.d.value;
            if (memberName === 'args' || memberName === 'kwargs') {
                leftExprFlags |= EvalFlags.NoConvertSpecialForm;
            }
        }
        const baseTypeResult = getTypeOfExpression(node.d.leftExpr, leftExprFlags);

        if (isTypeAliasPlaceholder(baseTypeResult.type)) {
            return {
                type: UnknownType.create(/* isIncomplete */ true),
                isIncomplete: true,
            };
        }

        const typeResult = getTypeOfMemberAccessWithBaseType(
            node,
            baseTypeResult,
            { method: 'get' },
            flags | EvalFlags.NoSpecialize
        );

        if (isCodeFlowSupportedForReference(node)) {
            // Before performing code flow analysis, update the cache to prevent recursion.
            writeTypeCache(node, { ...typeResult, isIncomplete: true }, flags);
            writeTypeCache(node.d.member, { ...typeResult, isIncomplete: true }, flags);

            // If the type is initially unbound, see if there's a parent class that
            // potentially initialized the value.
            let typeAtStart = typeResult.type;
            let isTypeAtStartIncomplete = !!typeResult.isIncomplete;
            if (isUnbound(typeAtStart)) {
                const baseType = makeTopLevelTypeVarsConcrete(baseTypeResult.type);

                let classMemberInfo: ClassMember | undefined;
                if (isInstantiableClass(baseType)) {
                    classMemberInfo = lookUpClassMember(
                        baseType,
                        node.d.member.d.value,
                        MemberAccessFlags.SkipOriginalClass
                    );
                } else if (isClassInstance(baseType)) {
                    classMemberInfo = lookUpObjectMember(
                        baseType,
                        node.d.member.d.value,
                        MemberAccessFlags.SkipOriginalClass
                    );
                }

                if (classMemberInfo) {
                    typeAtStart = getTypeOfMember(classMemberInfo);
                    isTypeAtStartIncomplete = false;
                }
            }

            // See if we can refine the type based on code flow analysis.
            const codeFlowTypeResult = getFlowTypeOfReference(node, /* startNode */ undefined, {
                targetSymbolId: indeterminateSymbolId,
                typeAtStart: { type: typeAtStart, isIncomplete: isTypeAtStartIncomplete },
                skipConditionalNarrowing: (flags & EvalFlags.TypeExpression) !== 0,
            });

            if (codeFlowTypeResult.type) {
                typeResult.type = codeFlowTypeResult.type;
            }

            if (codeFlowTypeResult.isIncomplete) {
                typeResult.isIncomplete = true;
            }

            // Detect, report, and fill in missing type arguments if appropriate.
            typeResult.type = reportMissingTypeArgs(node, typeResult.type, flags);

            // Add TypeForm details if appropriate.
            typeResult.type = addTypeFormForSymbol(node, typeResult.type, flags, /* includesVarDecl */ false);
        }

        if (baseTypeResult.isIncomplete) {
            typeResult.isIncomplete = true;
        }

        // See if we need to log an "unknown member access" diagnostic.
        let skipPartialUnknownCheck = typeResult.isIncomplete;

        // Don't report an error if the type is a partially-specialized
        // class being passed as an argument. This comes up frequently in
        // cases where a type is passed as an argument (e.g. "defaultdict(list)").
        // It can also come up in cases like "isinstance(x, (list, dict))".
        // We need to check for functions as well to handle Callable.
        if (
            (isInstantiableClass(typeResult.type) && !typeResult.type.priv.includeSubclasses) ||
            typeResult.type.props?.specialForm
        ) {
            const argNode = ParseTreeUtils.getParentNodeOfType(node, ParseNodeType.Argument);
            if (argNode && argNode?.parent?.nodeType === ParseNodeType.Call) {
                skipPartialUnknownCheck = true;
            }
        }

        if (!skipPartialUnknownCheck) {
            reportPossibleUnknownAssignment(
                AnalyzerNodeInfo.getFileInfo(node).diagnosticRuleSet.reportUnknownMemberType,
                DiagnosticRule.reportUnknownMemberType,
                node.d.member,
                typeResult.type,
                node,
                /* ignoreEmptyContainers */ false
            );
        }

        // Cache the type information in the member name node.
        writeTypeCache(node.d.member, typeResult, flags);

        return typeResult;
    }

    function getTypeOfMemberAccessWithBaseType(
        node: MemberAccessNode,
        baseTypeResult: TypeResult,
        usage: EvaluatorUsage,
        flags: EvalFlags
    ): TypeResult {
        let baseType = transformPossibleRecursiveTypeAlias(baseTypeResult.type);
        const memberName = node.d.member.d.value;
        let diag = new DiagnosticAddendum();
        const fileInfo = AnalyzerNodeInfo.getFileInfo(node);
        let type: Type | undefined;
        let narrowedTypeForSet: Type | undefined;
        let typeErrors = false;
        let isIncomplete = !!baseTypeResult.isIncomplete;
        let isAsymmetricAccessor: boolean | undefined;
        const isRequired = false;
        const isNotRequired = false;
        let memberAccessDeprecationInfo: MemberAccessDeprecationInfo | undefined;

        if (usage?.setType?.isIncomplete) {
            isIncomplete = true;
        }

        // If the base type was incomplete and unbound, don't proceed
        // because false positive errors will be generated.
        if (baseTypeResult.isIncomplete && isUnbound(baseType)) {
            return { type: UnknownType.create(/* isIncomplete */ true), isIncomplete: true };
        }

        if (baseType.props?.specialForm && (flags & EvalFlags.TypeExpression) === 0) {
            baseType = baseType.props.specialForm;
        }

        if (isParamSpec(baseType) && baseType.priv.paramSpecAccess) {
            baseType = makeTopLevelTypeVarsConcrete(baseType);
        }

        switch (baseType.category) {
            case TypeCategory.Any:
            case TypeCategory.Unknown:
            case TypeCategory.Never: {
                type = baseType;
                break;
            }

            case TypeCategory.Unbound: {
                break;
            }

            case TypeCategory.TypeVar: {
                if (isParamSpec(baseType)) {
                    // Handle special cases for "P.args" and "P.kwargs".
                    if (memberName === 'args' || memberName === 'kwargs') {
                        const isArgs = memberName === 'args';
                        const paramNode = ParseTreeUtils.getEnclosingParam(node);
                        const expectedCategory = isArgs ? ParamCategory.ArgsList : ParamCategory.KwargsDict;

                        if (!paramNode || paramNode.d.category !== expectedCategory) {
                            const errorMessage = isArgs
                                ? LocMessage.paramSpecArgsUsage()
                                : LocMessage.paramSpecKwargsUsage();
                            addDiagnostic(DiagnosticRule.reportInvalidTypeForm, errorMessage, node);
                            type = UnknownType.create(isIncomplete);
                            break;
                        }

                        type = TypeVarType.cloneForParamSpecAccess(baseType, memberName);
                        break;
                    }

                    if (!isIncomplete) {
                        addDiagnostic(
                            DiagnosticRule.reportGeneralTypeIssues,
                            LocMessage.paramSpecUnknownMember().format({ name: memberName }),
                            node
                        );
                    }

                    type = UnknownType.create(isIncomplete);
                    break;
                }

                // It's illegal to reference a member from a type variable.
                if ((flags & EvalFlags.TypeExpression) !== 0) {
                    if (!isIncomplete) {
                        addDiagnostic(
                            DiagnosticRule.reportGeneralTypeIssues,
                            LocMessage.typeVarNoMember().format({
                                type: printType(baseType),
                                name: memberName,
                            }),
                            node.d.leftExpr
                        );
                    }

                    type = UnknownType.create(isIncomplete);
                    break;
                }

                if (baseType.shared.recursiveAlias) {
                    type = UnknownType.create(/* isIncomplete */ true);
                    isIncomplete = true;
                    break;
                }

                if (isTypeVarTuple(baseType)) {
                    break;
                }

                return getTypeOfMemberAccessWithBaseType(
                    node,
                    {
                        type: makeTopLevelTypeVarsConcrete(baseType),
                        bindToSelfType: TypeBase.isInstantiable(baseType) ? convertToInstance(baseType) : baseType,
                        isIncomplete,
                    },
                    usage,
                    EvalFlags.None
                );
            }

            case TypeCategory.Class: {
                let typeResult: TypeResult | undefined;

                // If this is a class-like function created via NewType, treat
                // it like a function for purposes of member accesses.
                if (
                    ClassType.isNewTypeClass(baseType) &&
                    !baseType.priv.includeSubclasses &&
                    registry.functionClass &&
                    isClass(registry.functionClass)
                ) {
                    baseType = ClassType.cloneAsInstance(registry.functionClass);
                }

                const enumMemberResult = getTypeOfEnumMember(
                    evaluatorInterface,
                    node,
                    baseType,
                    memberName,
                    isIncomplete
                );

                if (enumMemberResult) {
                    if (usage.method === 'get') {
                        typeResult = enumMemberResult;
                    } else {
                        // Is this an attempt to delete or overwrite an enum member?
                        if (
                            isClassInstance(enumMemberResult.type) &&
                            ClassType.isSameGenericClass(enumMemberResult.type, ClassType.cloneAsInstance(baseType)) &&
                            enumMemberResult.type.priv.literalValue !== undefined
                        ) {
                            const diagMessage =
                                usage.method === 'set' ? LocMessage.enumMemberSet() : LocMessage.enumMemberDelete();
                            addDiagnostic(
                                DiagnosticRule.reportAttributeAccessIssue,
                                diagMessage.format({ name: memberName }) + diag.getString(),
                                node.d.member,
                                diag.getEffectiveTextRange() ?? node.d.member
                            );
                        }
                    }
                }

                if (!typeResult) {
                    typeResult = getTypeOfBoundMember(
                        node.d.member,
                        baseType,
                        memberName,
                        usage,
                        diag,
                        (flags & EvalFlags.TypeExpression) === 0 ? undefined : MemberAccessFlags.TypeExpression,
                        baseTypeResult.bindToSelfType
                    );
                }

                if (typeResult) {
                    if (!typeResult.typeErrors) {
                        type = addConditionToType(typeResult.type, getTypeCondition(baseType), {
                            skipSelfCondition: true,
                            skipBoundTypeVars: true,
                        });
                    } else {
                        typeErrors = true;
                    }

                    if (typeResult.isAsymmetricAccessor) {
                        isAsymmetricAccessor = true;
                    }

                    if (typeResult.isIncomplete) {
                        isIncomplete = true;
                    }

                    if (typeResult.narrowedTypeForSet) {
                        narrowedTypeForSet = addConditionToType(
                            typeResult.narrowedTypeForSet,
                            getTypeCondition(baseType),
                            { skipSelfCondition: true, skipBoundTypeVars: true }
                        );
                    }

                    if (typeResult.memberAccessDeprecationInfo) {
                        memberAccessDeprecationInfo = typeResult.memberAccessDeprecationInfo;
                    }
                }
                break;
            }

            case TypeCategory.Module: {
                let symbol = ModuleType.getField(baseType, memberName);

                // If the symbol isn't found in the module's symbol table,
                // see if it's defined in the `ModuleType` class. This is
                // needed for modules that are synthesized for namespace
                // packages.
                if (!symbol && registry.moduleTypeClass && isInstantiableClass(registry.moduleTypeClass)) {
                    symbol = ClassType.getSymbolTable(registry.moduleTypeClass).get(memberName);
                }

                if (symbol && !symbol.isExternallyHidden()) {
                    if (usage.method === 'get') {
                        setSymbolAccessed(fileInfo, symbol, node.d.member);
                    }

                    const typeResult = getEffectiveTypeOfSymbolForUsage(
                        symbol,
                        /* usageNode */ undefined,
                        /* useLastDecl */ true
                    );
                    type = typeResult.type;

                    if ((flags & EvalFlags.TypeExpression) !== 0) {
                        type = validateSymbolIsTypeExpression(node, type, !!typeResult.includesVariableDecl);
                    }

                    // Add TypeForm details if appropriate.
                    type = addTypeFormForSymbol(node, type, flags, !!typeResult.includesVariableDecl);

                    if (isTypeVar(type)) {
                        type = validateTypeVarUsage(node, type, flags);
                    }

                    // If the type resolved to "unbound", treat it as "unknown" in
                    // the case of a module reference because if it's truly unbound,
                    // that error will be reported within the module and should not
                    // leak into other modules that import it.
                    if (isUnbound(type)) {
                        type = UnknownType.create(/* isIncomplete */ true);
                    }

                    if (symbol.isPrivateMember()) {
                        addDiagnostic(
                            DiagnosticRule.reportPrivateUsage,
                            LocMessage.privateUsedOutsideOfModule().format({
                                name: memberName,
                            }),
                            node.d.member
                        );
                    }

                    if (symbol.isPrivatePyTypedImport()) {
                        addDiagnostic(
                            DiagnosticRule.reportPrivateImportUsage,
                            LocMessage.privateImportFromPyTypedModule().format({
                                name: memberName,
                                module: baseType.priv.moduleName,
                            }),
                            node.d.member
                        );
                    }
                } else {
                    // Does the module export a top-level __getattr__ function?
                    if (usage.method === 'get') {
                        const getAttrSymbol = ModuleType.getField(baseType, '__getattr__');
                        if (getAttrSymbol) {
                            const isModuleGetAttrSupported =
                                PythonVersion.isGreaterOrEqualTo(
                                    fileInfo.executionEnvironment.pythonVersion,
                                    pythonVersion3_7
                                ) || getAttrSymbol.getDeclarations().some((decl) => decl.uri.hasExtension('.pyi'));

                            if (isModuleGetAttrSupported) {
                                const getAttrTypeResult = getEffectiveTypeOfSymbolForUsage(getAttrSymbol);
                                if (isFunction(getAttrTypeResult.type)) {
                                    const returnTypeResult = getEffectiveReturnTypeResult(getAttrTypeResult.type);
                                    type = returnTypeResult.type;
                                    if (getAttrTypeResult.isIncomplete || returnTypeResult.isIncomplete) {
                                        isIncomplete = true;
                                    }
                                }
                            }
                        }
                    }

                    // If the field was not found and the module type is marked
                    // such that all fields should be Any/Unknown, return that type.
                    if (!type && baseType.priv.notPresentFieldType) {
                        type = baseType.priv.notPresentFieldType;
                    }

                    if (!type) {
                        if (!isIncomplete) {
                            addDiagnostic(
                                DiagnosticRule.reportAttributeAccessIssue,
                                LocMessage.moduleUnknownMember().format({
                                    memberName,
                                    moduleName: baseType.priv.moduleName,
                                }),
                                node.d.member
                            );
                        }
                        type = evaluatorOptions.evaluateUnknownImportsAsAny ? AnyType.create() : UnknownType.create();
                    }
                }
                break;
            }

            case TypeCategory.Union: {
                type = mapSubtypes(baseType, (subtype) => {
                    if (isUnbound(subtype)) {
                        // Don't do anything if it's unbound. The error will already
                        // be reported elsewhere.
                        return undefined;
                    }

                    if (isNoneInstance(subtype)) {
                        assert(isClassInstance(subtype));
                        const typeResult = getTypeOfBoundMember(node.d.member, subtype, memberName, usage, diag);

                        if (typeResult && !typeResult.typeErrors) {
                            type = addConditionToType(typeResult.type, getTypeCondition(baseType), {
                                skipBoundTypeVars: true,
                            });
                            if (typeResult.isIncomplete) {
                                isIncomplete = true;
                            }

                            return type;
                        }

                        if (!isIncomplete) {
                            addDiagnostic(
                                DiagnosticRule.reportOptionalMemberAccess,
                                LocMessage.noneUnknownMember().format({ name: memberName }),
                                node.d.member
                            );
                        }

                        return undefined;
                    }

                    const typeResult = getTypeOfMemberAccessWithBaseType(
                        node,
                        {
                            type: subtype,
                            isIncomplete: baseTypeResult.isIncomplete,
                        },
                        usage,
                        EvalFlags.None
                    );

                    if (typeResult.isIncomplete) {
                        isIncomplete = true;
                    }

                    if (typeResult.memberAccessDeprecationInfo) {
                        memberAccessDeprecationInfo = typeResult.memberAccessDeprecationInfo;
                    }

                    if (typeResult.typeErrors) {
                        typeErrors = true;
                    }

                    return typeResult.type;
                });
                break;
            }

            case TypeCategory.Function:
            case TypeCategory.Overloaded: {
                const hasSelf = isMethodType(baseType);

                if (memberName === '__self__' && hasSelf) {
                    // Handle "__self__" specially because MethodType defines
                    // it simply as "object". We can do better here.
                    let functionType: FunctionType | undefined;

                    if (isFunction(baseType)) {
                        functionType = baseType;
                    } else {
                        const overloads = OverloadedType.getOverloads(baseType);
                        if (overloads.length > 0) {
                            functionType = overloads[0];
                        }
                    }

                    type = functionType?.priv.boundToType;
                } else {
                    const altType = hasSelf ? registry.methodClass : registry.functionClass;
                    type = getTypeOfMemberAccessWithBaseType(
                        node,
                        { type: altType ? convertToInstance(altType) : UnknownType.create() },
                        usage,
                        flags
                    ).type;
                }
                break;
            }

            default:
                assertNever(baseType);
        }

        // If type is undefined, emit a general error message indicating that the
        // member could not be accessed.
        if (!type) {
            const isFunctionRule =
                isFunctionOrOverloaded(baseType) ||
                (isClassInstance(baseType) && ClassType.isBuiltIn(baseType, ['function', 'FunctionType']));

            if (!baseTypeResult.isIncomplete) {
                let diagMessage = LocMessage.memberAccess();
                if (usage.method === 'set') {
                    diagMessage = LocMessage.memberSet();
                } else if (usage.method === 'del') {
                    diagMessage = LocMessage.memberDelete();
                }

                // If there is an expected type diagnostic addendum (used for assignments),
                // use that rather than the local diagnostic addendum because it will be
                // more informative.
                if (usage.setExpectedTypeDiag && !usage.setExpectedTypeDiag.isEmpty()) {
                    diag = usage.setExpectedTypeDiag;
                }

                // If the class is a TypedDict, and there's a key with the same name,
                // suggest that they user want to use ["key"] name instead.
                if (isClass(baseType) && baseType.shared.typedDictEntries) {
                    const tdKey = baseType.shared.typedDictEntries.knownItems.get(memberName);
                    if (tdKey) {
                        const subDiag = new DiagnosticAddendum();
                        subDiag.addMessage(LocAddendum.typedDictKeyAccess().format({ name: memberName }));
                        diag.addAddendum(subDiag);
                    }
                }

                const rule = isFunctionRule
                    ? DiagnosticRule.reportFunctionMemberAccess
                    : DiagnosticRule.reportAttributeAccessIssue;

                addDiagnostic(
                    rule,
                    diagMessage.format({ name: memberName, type: printType(baseType) }) + diag.getString(),
                    node.d.member,
                    diag.getEffectiveTextRange() ?? node.d.member
                );
            }

            // If this is member access on a function, use "Any" so if the
            // reportFunctionMemberAccess rule is disabled, we don't trigger
            // additional reportUnknownMemberType diagnostics.
            type = isFunctionRule ? AnyType.create() : UnknownType.create();
        }

        if ((flags & EvalFlags.TypeExpression) === 0) {
            reportUseOfTypeCheckOnly(type, node.d.member);
        }

        type = convertSpecialFormToRuntimeValue(type, flags);

        return {
            type,
            isIncomplete,
            isAsymmetricAccessor,
            narrowedTypeForSet,
            isRequired,
            isNotRequired,
            memberAccessDeprecationInfo,
            typeErrors,
        };
    }

    function getTypeOfClassMemberName(
        errorNode: ExpressionNode | undefined,
        classType: ClassType,
        memberName: string,
        usage: EvaluatorUsage,
        diag: DiagnosticAddendum | undefined,
        flags: MemberAccessFlags,
        selfType?: ClassType | TypeVarType,
        recursionCount = 0
    ): ClassMemberLookup | undefined {
        const isAccessedThroughObject = TypeBase.isInstance(classType);

        // Always look for a member with a declared type first.
        let memberInfo = lookUpClassMember(classType, memberName, flags | MemberAccessFlags.DeclaredTypesOnly);

        // If we couldn't find a symbol with a declared type, use
        // a symbol with an inferred type.
        if (!memberInfo) {
            memberInfo = lookUpClassMember(classType, memberName, flags);
        }

        if (!memberInfo) {
            // No attribute of that name was found. If this is a member access
            // through an object, see if there's an attribute access override
            // method ("__getattr__", etc.).
            if ((flags & MemberAccessFlags.SkipAttributeAccessOverride) === 0 && errorNode) {
                const generalAttrType = applyAttributeAccessOverride(errorNode, classType, usage, memberName, selfType);
                if (generalAttrType) {
                    return {
                        symbol: undefined,
                        type: generalAttrType.type,
                        isTypeIncomplete: false,
                        isDescriptorError: false,
                        isClassMember: false,
                        isClassVar: false,
                        isAsymmetricAccessor: !!generalAttrType.isAsymmetricAccessor,
                    };
                }
            }

            // Report that the member could not be accessed.
            diag?.addMessage(LocAddendum.memberUnknown().format({ name: memberName }));
            return undefined;
        }

        let type: Type | undefined;
        let isTypeIncomplete = false;
        let narrowedTypeForSet: Type | undefined;

        if (memberInfo.symbol.isInitVar()) {
            diag?.addMessage(LocAddendum.memberIsInitVar().format({ name: memberName }));
            return undefined;
        }

        if (usage.method !== 'get' && errorNode) {
            // If the usage indicates a 'set' or 'delete' and the access is within the
            // class definition itself, use only the declared type to avoid circular
            // type evaluation.
            const containingClass = ParseTreeUtils.getEnclosingClass(errorNode);
            if (containingClass) {
                const containingClassType = getTypeOfClass(containingClass)?.classType;
                if (
                    containingClassType &&
                    isInstantiableClass(containingClassType) &&
                    ClassType.isSameGenericClass(
                        isAccessedThroughObject ? ClassType.cloneAsInstance(containingClassType) : containingClassType,
                        classType
                    )
                ) {
                    type = getDeclaredTypeOfSymbol(memberInfo.symbol)?.type;
                    if (type && isInstantiableClass(memberInfo.classType)) {
                        type = partiallySpecializeType(
                            type,
                            memberInfo.classType,
                            /* typeClassType */ undefined,
                            selfType
                        );
                    }

                    // If we're setting a class variable via a write through an object,
                    // this is normally considered a type violation. But it is allowed
                    // if the class variable is a descriptor object. In this case, we will
                    // clear the flag that causes an error to be generated.
                    if (
                        usage.method === 'set' &&
                        isEffectivelyClassVar(memberInfo.symbol, ClassType.isDataClass(containingClassType)) &&
                        isAccessedThroughObject
                    ) {
                        const selfClass = selfType ?? memberName === '__new__' ? undefined : classType;
                        const typeResult = getTypeOfMemberInternal(errorNode, memberInfo, selfClass, flags);

                        if (typeResult) {
                            if (isDescriptorInstance(typeResult.type, /* requireSetter */ true)) {
                                type = typeResult.type;
                                flags &= MemberAccessFlags.DisallowClassVarWrites;
                            }
                        }
                    }

                    if (!type) {
                        type = UnknownType.create();
                    }
                }
            }
        }

        if (!type) {
            let selfClass: ClassType | TypeVarType | undefined;

            if (selfType) {
                selfClass = convertToInstantiable(selfType) as TypeVarType | ClassType;
            } else {
                // Skip this for __new__ methods because they are not bound
                // to the class but rather assume the type of the cls argument.
                if (memberName !== '__new__') {
                    selfClass = classType;
                }
            }

            const typeResult = getTypeOfMemberInternal(errorNode, memberInfo, selfClass, flags);

            type = typeResult?.type ?? UnknownType.create();
            if (typeResult?.isIncomplete) {
                isTypeIncomplete = true;
            }
        }

        // Don't include variables within typed dict classes.
        if (isClass(memberInfo.classType) && ClassType.isTypedDictClass(memberInfo.classType)) {
            const typedDecls = memberInfo.symbol.getTypedDeclarations();
            if (typedDecls.length > 0 && typedDecls[0].type === DeclarationType.Variable) {
                diag?.addMessage(LocAddendum.memberUnknown().format({ name: memberName }));
                return undefined;
            }
        }

        if (usage.method === 'get') {
            // Mark the member accessed if it's not coming from a parent class.
            if (
                errorNode &&
                isInstantiableClass(memberInfo.classType) &&
                ClassType.isSameGenericClass(
                    memberInfo.classType,
                    isAccessedThroughObject ? ClassType.cloneAsInstantiable(classType) : classType
                )
            ) {
                setSymbolAccessed(AnalyzerNodeInfo.getFileInfo(errorNode), memberInfo.symbol, errorNode);
            }

            // Special-case `__init_subclass` and `__class_getitem__` because
            // these are always treated as class methods even if they're not
            // decorated as such.
            if (memberName === '__init_subclass__' || memberName === '__class_getitem__') {
                if (isFunction(type) && !FunctionType.isClassMethod(type)) {
                    type = FunctionType.cloneWithNewFlags(type, type.shared.flags | FunctionTypeFlags.ClassMethod);
                }
            }
        }

        // If the member is a descriptor object, apply the descriptor protocol
        // now. If the member is an instance or class method, bind the method.
        let isDescriptorError = false;
        let isAsymmetricAccessor = false;
        let isDescriptorApplied = false;
        let memberAccessDeprecationInfo: MemberAccessDeprecationInfo | undefined;

        type = mapSubtypes(
            type,
            (subtype) => {
                const concreteSubtype = makeTopLevelTypeVarsConcrete(subtype);
                const isClassMember = !memberInfo || (memberInfo.isClassMember && !memberInfo.isSlotsMember);
                let resultType: Type;

                if (isClass(concreteSubtype) && isClassMember && errorNode) {
                    const descResult = applyDescriptorAccessMethod(
                        subtype,
                        concreteSubtype,
                        memberInfo,
                        classType,
                        selfType,
                        flags,
                        errorNode,
                        memberName,
                        usage,
                        diag
                    );

                    if (descResult.isAsymmetricAccessor) {
                        isAsymmetricAccessor = true;
                    }

                    if (descResult.memberAccessDeprecationInfo) {
                        memberAccessDeprecationInfo = descResult.memberAccessDeprecationInfo;
                    }

                    if (descResult.typeErrors) {
                        isDescriptorError = true;
                    }

                    if (descResult.isDescriptorApplied) {
                        isDescriptorApplied = true;
                    }

                    resultType = descResult.type;
                } else if (isFunctionOrOverloaded(concreteSubtype) && TypeBase.isInstance(concreteSubtype)) {
                    const typeResult = bindMethodForMemberAccess(
                        subtype,
                        concreteSubtype,
                        memberInfo,
                        classType,
                        selfType,
                        flags,
                        memberName,
                        usage,
                        diag,
                        recursionCount
                    );

                    resultType = typeResult.type;
                    if (typeResult.typeErrors) {
                        isDescriptorError = true;
                    }
                } else {
                    resultType = subtype;
                }

                // If this is a "set" or "delete" operation, we have a bit more work to do.
                if (usage.method === 'get') {
                    return resultType;
                }

                // Check for an attempt to overwrite or delete a ClassVar member from an instance.
                if (
                    !isDescriptorApplied &&
                    memberInfo &&
                    isEffectivelyClassVar(memberInfo.symbol, ClassType.isDataClass(classType)) &&
                    (flags & MemberAccessFlags.DisallowClassVarWrites) !== 0
                ) {
                    diag?.addMessage(LocAddendum.memberSetClassVar().format({ name: memberName }));
                    isDescriptorError = true;
                }

                // Check for an attempt to overwrite or delete a final member variable.
                const finalVarTypeDecl = memberInfo?.symbol
                    .getDeclarations()
                    .find((decl) => isFinalVariableDeclaration(decl));

                if (
                    finalVarTypeDecl &&
                    errorNode &&
                    !ParseTreeUtils.isNodeContainedWithin(errorNode, finalVarTypeDecl.node)
                ) {
                    // If a Final instance variable is declared in the class body but is
                    // being assigned within an __init__ method, it's allowed.
                    const enclosingFunctionNode = ParseTreeUtils.getEnclosingFunction(errorNode);
                    if (
                        !enclosingFunctionNode ||
                        enclosingFunctionNode.d.name.d.value !== '__init__' ||
                        (finalVarTypeDecl as VariableDeclaration).inferredTypeSource !== undefined ||
                        isInstantiableClass(classType)
                    ) {
                        diag?.addMessage(LocMessage.finalReassigned().format({ name: memberName }));
                        isDescriptorError = true;
                    }
                }

                // Check for an attempt to overwrite or delete an instance variable that is
                // read-only (e.g. in a named tuple).
                if (memberInfo?.isInstanceMember && isClass(memberInfo.classType) && memberInfo.isReadOnly) {
                    diag?.addMessage(LocAddendum.readOnlyAttribute().format({ name: memberName }));
                    isDescriptorError = true;
                }

                return resultType;
            },
            { retainTypeAlias: true }
        );

        if (!isDescriptorError && usage.method === 'set' && usage.setType) {
            if (errorNode && memberInfo.symbol.hasTypedDeclarations()) {
                // This is an assignment to a member with a declared type. Apply
                // narrowing logic based on the assigned type. Skip this for
                // descriptor-based accesses.
                narrowedTypeForSet = isDescriptorApplied
                    ? usage.setType.type
                    : narrowTypeBasedOnAssignment(type, usage.setType).type;
            }

            // Verify that the assigned type is compatible.
            if (!assignType(type, usage.setType.type, diag?.createAddendum())) {
                if (!usage.setType.isIncomplete) {
                    diag?.addMessage(
                        LocAddendum.memberAssignment().format({
                            type: printType(usage.setType.type),
                            name: memberName,
                            classType: printObjectTypeForClass(classType),
                        })
                    );
                }

                // Do not narrow the type in this case. Assume the declared type.
                narrowedTypeForSet = type;
                isDescriptorError = true;
            }

            if (
                isInstantiableClass(memberInfo.classType) &&
                ClassType.isDataClassFrozen(memberInfo.classType) &&
                isAccessedThroughObject
            ) {
                diag?.addMessage(
                    LocAddendum.dataClassFrozen().format({
                        name: printType(ClassType.cloneAsInstance(memberInfo.classType)),
                    })
                );

                isDescriptorError = true;
            }
        }

        return {
            symbol: memberInfo.symbol,
            type,
            isTypeIncomplete,
            isDescriptorError,
            isClassMember: !memberInfo.isInstanceMember,
            isClassVar: memberInfo.isClassVar,
            classType: memberInfo.classType,
            isAsymmetricAccessor,
            narrowedTypeForSet,
            memberAccessDeprecationInfo,
        };
    }

    // Applies descriptor access methods "__get__", "__set__", or "__delete__"
    // if they apply.
    function applyDescriptorAccessMethod(
        memberType: Type,
        concreteMemberType: ClassType,
        memberInfo: ClassMember | undefined,
        classType: ClassType,
        selfType: ClassType | TypeVarType | undefined,
        flags: MemberAccessFlags,
        errorNode: ExpressionNode,
        memberName: string,
        usage: EvaluatorUsage,
        diag: DiagnosticAddendum | undefined
    ): MemberAccessTypeResult {
        const isAccessedThroughObject = TypeBase.isInstance(classType);

        let accessMethodName: string;
        if (usage.method === 'get') {
            accessMethodName = '__get__';
        } else if (usage.method === 'set') {
            accessMethodName = '__set__';
        } else {
            accessMethodName = '__delete__';
        }

        const subDiag = diag ? new DiagnosticAddendum() : undefined;

        const methodTypeResult = getTypeOfBoundMember(
            errorNode,
            concreteMemberType,
            accessMethodName,
            /* usage */ undefined,
            subDiag,
            MemberAccessFlags.SkipInstanceMembers | MemberAccessFlags.SkipAttributeAccessOverride
        );

        if (!methodTypeResult || methodTypeResult.typeErrors) {
            // Provide special error messages for properties.
            if (ClassType.isPropertyClass(concreteMemberType) && usage.method !== 'get') {
                const message =
                    usage.method === 'set' ? LocAddendum.propertyMissingSetter() : LocAddendum.propertyMissingDeleter();
                diag?.addMessage(message.format({ name: memberName }));
                return { type: AnyType.create(), typeErrors: true };
            }

            if (classType.shared.typeVarScopeId) {
                memberType = makeTypeVarsBound(memberType, [classType.shared.typeVarScopeId]);
            }

            return { type: memberType };
        }

        const methodClassType = methodTypeResult.classType;
        let methodType = methodTypeResult.type;

        if (methodTypeResult.typeErrors || !methodClassType) {
            if (diag && subDiag) {
                diag.addAddendum(subDiag);
            }
            return { type: UnknownType.create(), typeErrors: true };
        }

        if (!isFunctionOrOverloaded(methodType)) {
            if (isAnyOrUnknown(methodType)) {
                return { type: methodType };
            }

            // TODO - emit an error for this condition.
            return { type: memberType, typeErrors: true };
        }

        // Special-case logic for properties.
        if (
            ClassType.isPropertyClass(concreteMemberType) &&
            memberInfo &&
            isInstantiableClass(memberInfo.classType) &&
            methodType
        ) {
            // If the property is being accessed from a protocol class (not an instance),
            // flag this as an error because a property within a protocol is meant to be
            // interpreted as a read-only attribute rather than a protocol, so accessing
            // it directly from the class has an ambiguous meaning.
            if ((flags & MemberAccessFlags.SkipInstanceMembers) !== 0 && ClassType.isProtocolClass(classType)) {
                diag?.addMessage(LocAddendum.propertyAccessFromProtocolClass());
                return { type: memberType, typeErrors: true };
            }

            // Infer return types before specializing. Otherwise a generic inferred
            // return type won't be properly specialized.
            inferReturnTypeIfNecessary(methodType);

            // This specialization is required specifically for properties, which should be
            // generic but are not defined that way. Because of this, we use type variables
            // in the synthesized methods (e.g. __get__) for the property class that are
            // defined in the class that declares the fget method.
            let accessMethodClass: ClassType | undefined;
            if (usage.method === 'get') {
                accessMethodClass = concreteMemberType.priv.fgetInfo?.classType;
            } else if (usage.method === 'set') {
                accessMethodClass = concreteMemberType.priv.fsetInfo?.classType;
            } else {
                accessMethodClass = concreteMemberType.priv.fdelInfo?.classType;
            }

            if (accessMethodClass) {
                const constraints = new ConstraintTracker();
                accessMethodClass = selfSpecializeClass(accessMethodClass);
                assignType(
                    ClassType.cloneAsInstance(accessMethodClass),
                    ClassType.cloneAsInstance(memberInfo.classType),
                    /* diag */ undefined,
                    constraints
                );
                accessMethodClass = solveAndApplyConstraints(accessMethodClass, constraints) as ClassType;

                const specializedType = partiallySpecializeType(
                    methodType,
                    accessMethodClass,
                    getTypeClassType(),
                    selfType ? (convertToInstantiable(selfType) as ClassType | TypeVarType) : classType
                );

                if (isFunctionOrOverloaded(specializedType)) {
                    methodType = specializedType;
                }
            }
        }

        // Determine if we're calling __set__ on an asymmetric descriptor or property.
        let isAsymmetricAccessor = false;
        if (usage.method === 'set' && isClass(methodClassType)) {
            if (isAsymmetricDescriptorClass(methodClassType)) {
                isAsymmetricAccessor = true;
            }
        }

        if (!methodType) {
            diag?.addMessage(
                LocAddendum.descriptorAccessBindingFailed().format({
                    name: accessMethodName,
                    className: printType(convertToInstance(methodClassType)),
                })
            );

            return {
                type: UnknownType.create(),
                typeErrors: true,
                isDescriptorApplied: true,
                isAsymmetricAccessor,
            };
        }

        // Simulate a call to the access method.
        const argList: Arg[] = [];

        // Provide "obj" argument.
        let objArgType: Type;
        if (ClassType.isClassProperty(concreteMemberType)) {
            // Handle "class properties" as a special case. We need to pass
            // the class rather than the object instance in this case.
            objArgType = isAccessedThroughObject ? ClassType.cloneAsInstantiable(classType) : classType;
        } else if (isAccessedThroughObject) {
            objArgType = selfType ?? ClassType.cloneAsInstance(classType);
        } else {
            objArgType = getNoneType();
        }

        argList.push({
            argCategory: ArgCategory.Simple,
            typeResult: { type: objArgType },
        });

        if (usage.method === 'get') {
            let classArgType: Type;
            if (selfType) {
                classArgType = convertToInstantiable(selfType);
            } else {
                classArgType = isAccessedThroughObject ? ClassType.cloneAsInstantiable(classType) : classType;
            }

            // Provide "owner" argument.
            argList.push({
                argCategory: ArgCategory.Simple,
                typeResult: { type: classArgType },
            });
        } else if (usage.method === 'set') {
            // Provide "value" argument.
            argList.push({
                argCategory: ArgCategory.Simple,
                typeResult: {
                    type: usage.setType?.type ?? UnknownType.create(),
                    isIncomplete: !!usage.setType?.isIncomplete,
                },
            });
        }

        // Suppress diagnostics for these method calls because they would be redundant.
        const callResult = suppressDiagnostics(
            errorNode,
            () => {
                return validateCallArgs(
                    errorNode,
                    argList,
                    { type: methodType },
                    /* constraints */ undefined,
                    /* skipUnknownArgCheck */ true,
                    /* inferenceContext */ undefined
                );
            },
            (suppressedDiags) => {
                // If diagnostics were recorded when suppressed, add them to the
                // diagnostic as messages.
                if (diag) {
                    suppressedDiags.forEach((message) => {
                        diag?.addMessageMultiline(message);
                    });
                }
            }
        );

        // Collect deprecation information associated with the member access method.
        let deprecationInfo: MemberAccessDeprecationInfo | undefined;
        if (callResult.overloadsUsedForCall && callResult.overloadsUsedForCall.length >= 1) {
            const overloadUsed = callResult.overloadsUsedForCall[0];
            if (overloadUsed.shared.deprecatedMessage) {
                deprecationInfo = {
                    deprecatedMessage: overloadUsed.shared.deprecatedMessage,
                    accessType: ClassType.isPropertyClass(concreteMemberType) ? 'property' : 'descriptor',
                    accessMethod: usage.method,
                };
            }
        }

        if (!callResult.argumentErrors) {
            return {
                // For set or delete, always return Any.
                type: usage.method === 'get' ? callResult.returnType ?? UnknownType.create() : AnyType.create(),
                isDescriptorApplied: true,
                isAsymmetricAccessor,
                memberAccessDeprecationInfo: deprecationInfo,
            };
        }

        return {
            type: UnknownType.create(),
            typeErrors: true,
            isDescriptorApplied: true,
            isAsymmetricAccessor,
            memberAccessDeprecationInfo: deprecationInfo,
        };
    }

    function bindMethodForMemberAccess(
        type: Type,
        concreteType: FunctionType | OverloadedType,
        memberInfo: ClassMember | undefined,
        classType: ClassType,
        selfType: ClassType | TypeVarType | undefined,
        flags: MemberAccessFlags,
        memberName: string,
        usage: EvaluatorUsage,
        diag: DiagnosticAddendum | undefined,
        recursionCount = 0
    ): TypeResult {
        // Check for an attempt to overwrite a final method.
        if (usage.method === 'set') {
            const impl = isFunction(concreteType) ? concreteType : OverloadedType.getImplementation(concreteType);

            if (impl && isFunction(impl) && FunctionType.isFinal(impl) && memberInfo && isClass(memberInfo.classType)) {
                diag?.addMessage(
                    LocMessage.finalMethodOverride().format({
                        name: memberName,
                        className: memberInfo.classType.shared.name,
                    })
                );

                return { type: UnknownType.create(), typeErrors: true };
            }
        }

        // If this function is an instance member (e.g. a lambda that was
        // assigned to an instance variable), don't perform any binding.
        if (TypeBase.isInstance(classType)) {
            if (!memberInfo || memberInfo.isInstanceMember) {
                return { type: type };
            }
        }

        const boundType = bindFunctionToClassOrObject(
            classType,
            concreteType,
            memberInfo && isInstantiableClass(memberInfo.classType) ? memberInfo.classType : undefined,
            (flags & MemberAccessFlags.TreatConstructorAsClassMethod) !== 0,
            selfType && isClass(selfType) ? ClassType.cloneIncludeSubclasses(selfType) : selfType,
            diag,
            recursionCount
        );

        return { type: boundType ?? UnknownType.create(), typeErrors: !boundType };
    }

    function isAsymmetricDescriptorClass(classType: ClassType): boolean {
        // If the value has already been cached in this type, return the cached value.
        if (classType.priv.isAsymmetricDescriptor !== undefined) {
            return classType.priv.isAsymmetricDescriptor;
        }

        let isAsymmetric = false;

        const getterSymbolResult = lookUpClassMember(classType, '__get__', MemberAccessFlags.SkipBaseClasses);
        const setterSymbolResult = lookUpClassMember(classType, '__set__', MemberAccessFlags.SkipBaseClasses);

        if (!getterSymbolResult || !setterSymbolResult) {
            isAsymmetric = false;
        } else {
            let getterType = getTypeOfMember(getterSymbolResult);
            const setterType = getTypeOfMember(setterSymbolResult);

            // If this is an overload, find the appropriate overload.
            if (isOverloaded(getterType)) {
                const getOverloads = OverloadedType.getOverloads(getterType).filter((overload) => {
                    if (overload.shared.parameters.length < 2) {
                        return false;
                    }
                    const param1Type = FunctionType.getParamType(overload, 1);
                    return !isNoneInstance(param1Type);
                });

                if (getOverloads.length === 1) {
                    getterType = getOverloads[0];
                } else {
                    isAsymmetric = true;
                }
            }

            // If this is an overload, find the appropriate overload.
            if (isOverloaded(setterType)) {
                isAsymmetric = true;
            }

            // If either the setter or getter is an overload (or some other non-function type),
            // conservatively assume that it's not asymmetric.
            if (isFunction(getterType) && isFunction(setterType)) {
                // If there's no declared return type on the getter, assume it's symmetric.
                if (setterType.shared.parameters.length >= 3 && getterType.shared.declaredReturnType) {
                    const setterValueType = FunctionType.getParamType(setterType, 2);
                    const getterReturnType = FunctionType.getEffectiveReturnType(getterType) ?? UnknownType.create();

                    if (!isTypeSame(setterValueType, getterReturnType)) {
                        isAsymmetric = true;
                    }
                }
            }
        }

        // Cache the value for next time.
        classType.priv.isAsymmetricDescriptor = isAsymmetric;
        return isAsymmetric;
    }

    function isClassWithAsymmetricAttributeAccessor(classType: ClassType): boolean {
        // If the value has already been cached in this type, return the cached value.
        if (classType.priv.isAsymmetricAttributeAccessor !== undefined) {
            return classType.priv.isAsymmetricAttributeAccessor;
        }

        let isAsymmetric = false;

        const getterSymbolResult = lookUpClassMember(classType, '__getattr__', MemberAccessFlags.SkipBaseClasses);
        const setterSymbolResult = lookUpClassMember(classType, '__setattr__', MemberAccessFlags.SkipBaseClasses);

        if (!getterSymbolResult || !setterSymbolResult) {
            isAsymmetric = false;
        } else {
            const getterType = getEffectiveTypeOfSymbol(getterSymbolResult.symbol);
            const setterType = getEffectiveTypeOfSymbol(setterSymbolResult.symbol);

            // If either the setter or getter is an overload (or some other non-function type),
            // conservatively assume that it's not asymmetric.
            if (isFunction(getterType) && isFunction(setterType)) {
                // If there's no declared return type on the getter, assume it's symmetric.
                if (setterType.shared.parameters.length >= 3 && getterType.shared.declaredReturnType) {
                    const setterValueType = FunctionType.getParamType(setterType, 2);
                    const getterReturnType = FunctionType.getEffectiveReturnType(getterType) ?? UnknownType.create();

                    if (!isTypeSame(setterValueType, getterReturnType)) {
                        isAsymmetric = true;
                    }
                }
            }
        }

        // Cache the value for next time.
        classType.priv.isAsymmetricAttributeAccessor = isAsymmetric;
        return isAsymmetric;
    }

    // Applies the __getattr__, __setattr__ or __delattr__ method if present.
    // If it's not applicable, returns undefined.
    function applyAttributeAccessOverride(
        errorNode: ExpressionNode,
        classType: ClassType,
        usage: EvaluatorUsage,
        memberName: string,
        selfType?: ClassType | TypeVarType
    ): MemberAccessTypeResult | undefined {
        const getAttributeAccessMember = (name: string) => {
            return getTypeOfBoundMember(
                errorNode,
                classType,
                name,
                /* usage */ undefined,
                /* diag */ undefined,
                MemberAccessFlags.SkipInstanceMembers |
                    MemberAccessFlags.SkipObjectBaseClass |
                    MemberAccessFlags.SkipTypeBaseClass |
                    MemberAccessFlags.SkipAttributeAccessOverride,
                selfType
            )?.type;
        };

        let accessMemberType: Type | undefined;
        if (usage.method === 'get') {
            accessMemberType = getAttributeAccessMember('__getattribute__') ?? getAttributeAccessMember('__getattr__');
        } else if (usage.method === 'set') {
            accessMemberType = getAttributeAccessMember('__setattr__');
        } else {
            assert(usage.method === 'del');
            accessMemberType = getAttributeAccessMember('__delattr__');
        }

        if (!accessMemberType) {
            return undefined;
        }

        const argList: Arg[] = [];

        // Provide "name" argument.
        argList.push({
            argCategory: ArgCategory.Simple,
            typeResult: {
                type:
                    registry.strClass && isInstantiableClass(registry.strClass)
                        ? ClassType.cloneWithLiteral(ClassType.cloneAsInstance(registry.strClass), memberName)
                        : AnyType.create(),
            },
        });

        if (usage.method === 'set') {
            // Provide "value" argument.
            argList.push({
                argCategory: ArgCategory.Simple,
                typeResult: {
                    type: usage.setType?.type ?? UnknownType.create(),
                    isIncomplete: !!usage.setType?.isIncomplete,
                },
            });
        }

        if (!isFunctionOrOverloaded(accessMemberType)) {
            if (isAnyOrUnknown(accessMemberType)) {
                return { type: accessMemberType };
            }

            // TODO - emit an error for this condition.
            return undefined;
        }

        const callResult = validateCallArgs(
            errorNode,
            argList,
            { type: accessMemberType },
            /* constraints */ undefined,
            /* skipUnknownArgCheck */ true,
            /* inferenceContext */ undefined
        );

        let isAsymmetricAccessor = false;
        if (usage.method === 'set') {
            isAsymmetricAccessor = isClassWithAsymmetricAttributeAccessor(classType);
        }

        return {
            type: callResult.returnType ?? UnknownType.create(),
            typeErrors: callResult.argumentErrors,
            isAsymmetricAccessor,
        };
    }

    function getTypeOfIndex(node: IndexNode, flags = EvalFlags.None): TypeResult {
        const baseTypeResult = getTypeOfExpression(node.d.leftExpr, flags | EvalFlags.IndexBaseDefaults);

        // If this is meant to be a type and the base expression is a string expression,
        // emit an error because this is an illegal annotation form and will generate a
        // runtime exception.
        if (flags & EvalFlags.InstantiableType) {
            if (node.d.leftExpr.nodeType === ParseNodeType.StringList) {
                addDiagnostic(DiagnosticRule.reportIndexIssue, LocMessage.stringNotSubscriptable(), node.d.leftExpr);
            }
        }

        // Check for builtin classes that will generate runtime exceptions if subscripted.
        if ((flags & EvalFlags.ForwardRefs) === 0) {
            // We can skip this check if the class is used within a PEP 526 variable
            // type annotation within a class or function. For some undocumented reason,
            // they don't result in runtime exceptions when used in this manner.
            let skipSubscriptCheck = (flags & EvalFlags.VarTypeAnnotation) !== 0;
            if (skipSubscriptCheck) {
                const scopeNode = ParseTreeUtils.getExecutionScopeNode(node);
                if (scopeNode?.nodeType === ParseNodeType.Module) {
                    skipSubscriptCheck = false;
                }
            }

            if (!skipSubscriptCheck) {
                const fileInfo = AnalyzerNodeInfo.getFileInfo(node);
                if (
                    isInstantiableClass(baseTypeResult.type) &&
                    ClassType.isBuiltIn(baseTypeResult.type) &&
                    !baseTypeResult.type.priv.aliasName
                ) {
                    const minPythonVersion = nonSubscriptableBuiltinTypes.get(baseTypeResult.type.shared.fullName);
                    if (
                        minPythonVersion !== undefined &&
                        PythonVersion.isLessThan(fileInfo.executionEnvironment.pythonVersion, minPythonVersion) &&
                        !fileInfo.isStubFile
                    ) {
                        addDiagnostic(
                            DiagnosticRule.reportIndexIssue,
                            LocMessage.classNotRuntimeSubscriptable().format({
                                name: baseTypeResult.type.priv.aliasName || baseTypeResult.type.shared.name,
                            }),
                            node.d.leftExpr
                        );
                    }
                }
            }
        }

        const indexTypeResult = getTypeOfIndexWithBaseType(node, baseTypeResult, { method: 'get' }, flags);

        if (isCodeFlowSupportedForReference(node)) {
            // We limit type narrowing for index expressions to built-in types that are
            // known to have symmetric __getitem__ and __setitem__ methods (i.e. the value
            // passed to __setitem__ is the same type as the value returned by __getitem__).
            let baseTypeSupportsIndexNarrowing = !isAny(baseTypeResult.type);
            mapSubtypesExpandTypeVars(baseTypeResult.type, /* options */ undefined, (subtype) => {
                if (
                    !isClassInstance(subtype) ||
                    !(ClassType.isBuiltIn(subtype) || ClassType.isTypedDictClass(subtype))
                ) {
                    baseTypeSupportsIndexNarrowing = false;
                }

                return undefined;
            });

            if (baseTypeSupportsIndexNarrowing) {
                // Before performing code flow analysis, update the cache to prevent recursion.
                writeTypeCache(node, { ...indexTypeResult, isIncomplete: true }, flags);

                // See if we can refine the type based on code flow analysis.
                const codeFlowTypeResult = getFlowTypeOfReference(node, /* startNode */ undefined, {
                    targetSymbolId: indeterminateSymbolId,
                    typeAtStart: {
                        type: indexTypeResult.type,
                        isIncomplete: !!baseTypeResult.isIncomplete || !!indexTypeResult.isIncomplete,
                    },
                    skipConditionalNarrowing: (flags & EvalFlags.TypeExpression) !== 0,
                });

                if (codeFlowTypeResult.type) {
                    indexTypeResult.type = codeFlowTypeResult.type;
                }

                if (codeFlowTypeResult.isIncomplete) {
                    indexTypeResult.isIncomplete = true;
                }
            }
        }

        if (baseTypeResult.isIncomplete) {
            indexTypeResult.isIncomplete = true;
        }

        return indexTypeResult;
    }

    // If the list of type parameters includes a TypeVarTuple, we may need to adjust
    // the supplied type arguments to map to the type parameter list.
    function adjustTypeArgsForTypeVarTuple(
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
                addDiagnostic(
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
                        evaluatorInterface,
                        variadicTypeResults[0].type,
                        variadicTypeResults[0].node
                    );
                } else {
                    variadicTypeResults.forEach((arg, index) => {
                        validateTypeArg(arg, {
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

                    const tupleObject = makeTupleObject(evaluatorInterface, variadicTypes, /* isUnpacked */ true);

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
                    type: makeTupleObject(evaluatorInterface, [], /* isUnpacked */ true),
                });
            }
        }

        return typeArgs;
    }

    // If the type is a generic type alias that is not specialized, provides
    // default type arguments for the type alias. It optionally logs diagnostics
    // for missing type arguments.
    function specializeTypeAliasWithDefaults(type: Type, errorNode: ExpressionNode | undefined) {
        // Is this a type alias?
        const aliasInfo = type.props?.typeAliasInfo;
        if (!aliasInfo) {
            return type;
        }

        // Is this a generic type alias that needs specializing?
        if (!aliasInfo.shared.typeParams || aliasInfo.shared.typeParams.length === 0 || aliasInfo.typeArgs) {
            return type;
        }

        let reportDiag = false;
        const defaultTypeArgs: Type[] = [];
        const constraints = new ConstraintTracker();

        aliasInfo.shared.typeParams.forEach((param) => {
            if (!param.shared.isDefaultExplicit) {
                reportDiag = true;
            }

            let defaultType: Type;
            if (param.shared.isDefaultExplicit || isParamSpec(param)) {
                defaultType = solveAndApplyConstraints(param, constraints, {
                    replaceUnsolved: {
                        scopeIds: [aliasInfo.shared.typeVarScopeId],
                        tupleClassType: getTupleClassType(),
                    },
                });
            } else if (isTypeVarTuple(param) && registry.tupleClass && isInstantiableClass(registry.tupleClass)) {
                defaultType = makeTupleObject(
                    evaluatorInterface,
                    [{ type: UnknownType.create(), isUnbounded: true }],
                    /* isUnpacked */ true
                );
            } else {
                defaultType = UnknownType.create();
            }

            defaultTypeArgs.push(defaultType);
            constraints.setBounds(param, defaultType);
        });

        if (reportDiag && errorNode) {
            addDiagnostic(
                DiagnosticRule.reportMissingTypeArgument,
                LocMessage.typeArgsMissingForAlias().format({
                    name: aliasInfo.shared.name,
                }),
                errorNode
            );
        }

        type = TypeBase.cloneForTypeAlias(
            solveAndApplyConstraints(type, constraints, {
                replaceUnsolved: {
                    scopeIds: [aliasInfo.shared.typeVarScopeId],
                    tupleClassType: getTupleClassType(),
                },
            }),
            { ...aliasInfo, typeArgs: defaultTypeArgs }
        );

        return type;
    }

    function getTypeOfIndexWithBaseType(
        node: IndexNode,
        baseTypeResult: TypeResult,
        usage: EvaluatorUsage,
        flags: EvalFlags
    ): TypeResult {
        // Handle the case where we're specializing a generic type alias.
        const typeAliasResult = specialForms.createSpecializedTypeAlias(
            evaluatorInterface,
            node,
            baseTypeResult.type,
            flags
        );
        if (typeAliasResult) {
            return typeAliasResult;
        }

        // Handle the case where Never or NoReturn are being specialized.
        if (isNever(baseTypeResult.type) && baseTypeResult.type.props?.specialForm) {
            // Swap in the special form type, which is the Never or NoReturn class.
            baseTypeResult = { ...baseTypeResult, type: baseTypeResult.type.props.specialForm };
        }

        // Handle the case where a TypeAliasType symbol is being specialized
        // in a value expression.
        if (
            isClassInstance(baseTypeResult.type) &&
            ClassType.isBuiltIn(baseTypeResult.type, 'TypeAliasType') &&
            baseTypeResult.type.props?.typeForm
        ) {
            const typeAliasInfo = baseTypeResult.type.props.typeForm.props?.typeAliasInfo;
            if (typeAliasInfo && typeAliasInfo.shared.typeParams) {
                const origTypeAlias = TypeBase.cloneForTypeAlias(
                    convertToInstantiable(baseTypeResult.type.props.typeForm),
                    { ...typeAliasInfo, typeArgs: undefined }
                );
                const typeFormType = specialForms.createSpecializedTypeAlias(
                    evaluatorInterface,
                    node,
                    origTypeAlias,
                    flags
                );
                if (typeFormType) {
                    return {
                        type: TypeBase.cloneWithTypeForm(baseTypeResult.type, convertToInstance(typeFormType.type)),
                    };
                }
            }
        }

        if (isTypeVar(baseTypeResult.type) && isTypeAliasPlaceholder(baseTypeResult.type)) {
            const typeArgTypes = getTypeArgs(node, flags).map((t) => convertToInstance(t.type));
            const type = TypeBase.cloneForTypeAlias(baseTypeResult.type, {
                shared: baseTypeResult.type.shared.recursiveAlias!,
                typeArgs: typeArgTypes,
            });
            return { type };
        }

        let isIncomplete = baseTypeResult.isIncomplete;
        let isRequired = false;
        let isNotRequired = false;
        let isReadOnly = false;

        const type = mapSubtypesExpandTypeVars(
            baseTypeResult.type,
            /* options */ undefined,
            (concreteSubtype, unexpandedSubtype) => {
                const selfType = isTypeVar(unexpandedSubtype) ? unexpandedSubtype : undefined;

                if (isAnyOrUnknown(concreteSubtype)) {
                    if ((flags & EvalFlags.TypeExpression) !== 0) {
                        // If we are expecting a type annotation here, assume that
                        // the subscripts are type arguments and evaluate them
                        // accordingly.
                        getTypeArgs(node, flags);
                    }

                    return concreteSubtype;
                }

                if (flags & EvalFlags.InstantiableType) {
                    if (isTypeVar(unexpandedSubtype)) {
                        addDiagnostic(
                            DiagnosticRule.reportGeneralTypeIssues,
                            LocMessage.typeVarNotSubscriptable().format({
                                type: printType(unexpandedSubtype),
                            }),
                            node.d.leftExpr
                        );

                        // Evaluate the index expressions as though they are type arguments for error-reporting.
                        getTypeArgs(node, flags);

                        return UnknownType.create();
                    }
                }

                if (isInstantiableClass(concreteSubtype)) {
                    // See if the class has a custom metaclass that supports __getitem__, etc.
                    if (
                        concreteSubtype.shared.effectiveMetaclass &&
                        isInstantiableClass(concreteSubtype.shared.effectiveMetaclass) &&
                        !ClassType.isBuiltIn(concreteSubtype.shared.effectiveMetaclass, ['type', '_InitVarMeta']) &&
                        (flags & EvalFlags.InstantiableType) === 0
                    ) {
                        const itemMethodType = getBoundMagicMethod(
                            concreteSubtype,
                            getIndexAccessMagicMethodName(usage),
                            /* selfType */ undefined,
                            node.d.leftExpr
                        );

                        if ((flags & EvalFlags.TypeExpression) !== 0) {
                            // If the class doesn't derive from Generic, a type argument should not be allowed.
                            addDiagnostic(
                                DiagnosticRule.reportInvalidTypeArguments,
                                LocMessage.typeArgsExpectingNone().format({
                                    name: printType(ClassType.cloneAsInstance(concreteSubtype)),
                                }),
                                node
                            );
                        }

                        if (itemMethodType) {
                            return getTypeOfIndexedObjectOrClass(node, concreteSubtype, selfType, usage).type;
                        }
                    }

                    // Setting the value of an indexed class will always result
                    // in an exception.
                    if (usage.method === 'set') {
                        addDiagnostic(
                            DiagnosticRule.reportGeneralTypeIssues,
                            LocMessage.genericClassAssigned(),
                            node.d.leftExpr
                        );
                    } else if (usage.method === 'del') {
                        addDiagnostic(
                            DiagnosticRule.reportGeneralTypeIssues,
                            LocMessage.genericClassDeleted(),
                            node.d.leftExpr
                        );
                    }

                    if (ClassType.isSpecialBuiltIn(concreteSubtype, 'Literal')) {
                        // Special-case Literal types.
                        return specialForms.createLiteralType(
                            evaluatorInterface,
                            concreteSubtype,
                            node,
                            flags,
                            registry
                        );
                    }

                    if (ClassType.isBuiltIn(concreteSubtype, 'InitVar')) {
                        // Special-case InitVar, used in dataclasses.
                        const typeArgs = getTypeArgs(node, flags);

                        if ((flags & EvalFlags.TypeExpression) !== 0) {
                            if ((flags & EvalFlags.VarTypeAnnotation) === 0) {
                                addDiagnostic(
                                    DiagnosticRule.reportInvalidTypeForm,
                                    LocMessage.initVarNotAllowed(),
                                    node.d.leftExpr
                                );
                            }
                        }

                        if (typeArgs.length === 1) {
                            return typeArgs[0].type;
                        } else {
                            addDiagnostic(
                                DiagnosticRule.reportInvalidTypeForm,
                                LocMessage.typeArgsMismatchOne().format({ received: typeArgs.length }),
                                node.d.leftExpr
                            );

                            return UnknownType.create();
                        }
                    }

                    if (ClassType.isEnumClass(concreteSubtype)) {
                        // Special-case Enum types.
                        // TODO - validate that there's only one index entry
                        // that is a str type.
                        // TODO - validate that literal strings are referencing
                        // a known enum member.
                        return ClassType.cloneAsInstance(concreteSubtype);
                    }

                    const isAnnotatedClass =
                        isInstantiableClass(concreteSubtype) && ClassType.isBuiltIn(concreteSubtype, 'Annotated');
                    const hasCustomClassGetItem =
                        isInstantiableClass(concreteSubtype) && ClassType.hasCustomClassGetItem(concreteSubtype);
                    const isGenericClass =
                        concreteSubtype.shared.typeParams?.length > 0 ||
                        ClassType.isSpecialBuiltIn(concreteSubtype) ||
                        ClassType.isBuiltIn(concreteSubtype, 'type') ||
                        ClassType.isPartiallyEvaluated(concreteSubtype);
                    const isFinalAnnotation =
                        isInstantiableClass(concreteSubtype) && ClassType.isBuiltIn(concreteSubtype, 'Final');
                    const isClassVarAnnotation =
                        isInstantiableClass(concreteSubtype) && ClassType.isBuiltIn(concreteSubtype, 'ClassVar');

                    // This feature is currently experimental.
                    const supportsTypedDictTypeArg =
                        AnalyzerNodeInfo.getFileInfo(node).diagnosticRuleSet.enableExperimentalFeatures &&
                        ClassType.isBuiltIn(concreteSubtype, 'TypedDict');

                    let typeArgs = getTypeArgs(node, flags, {
                        isAnnotatedClass,
                        hasCustomClassGetItem: hasCustomClassGetItem || !isGenericClass,
                        isFinalAnnotation,
                        isClassVarAnnotation,
                        supportsTypedDictTypeArg,
                    });

                    if (!isAnnotatedClass) {
                        typeArgs = adjustTypeArgsForTypeVarTuple(typeArgs, concreteSubtype.shared.typeParams, node);
                    }

                    // If this is a custom __class_getitem__, there's no need to specialize the class.
                    // Just return it as is.
                    if (hasCustomClassGetItem) {
                        return concreteSubtype;
                    }

                    if (concreteSubtype.priv.typeArgs) {
                        addDiagnostic(
                            DiagnosticRule.reportInvalidTypeArguments,
                            LocMessage.classAlreadySpecialized().format({
                                type: printType(convertToInstance(concreteSubtype), { expandTypeAlias: true }),
                            }),
                            node.d.leftExpr
                        );
                        return concreteSubtype;
                    }

                    const result = specialForms.createSpecializedClassType(
                        evaluatorInterface,
                        concreteSubtype,
                        typeArgs,
                        flags,
                        node,
                        registry
                    );
                    if (result.isRequired) {
                        isRequired = true;
                    } else if (result.isNotRequired) {
                        isNotRequired = true;
                    }

                    if (result.isReadOnly) {
                        isReadOnly = true;
                    }

                    return result.type;
                }

                if (isNoneInstance(concreteSubtype)) {
                    if (!isIncomplete) {
                        addDiagnostic(
                            DiagnosticRule.reportOptionalSubscript,
                            LocMessage.noneNotSubscriptable(),
                            node.d.leftExpr
                        );
                    }

                    return UnknownType.create();
                }

                if (isClassInstance(concreteSubtype)) {
                    const typeResult = getTypeOfIndexedObjectOrClass(node, concreteSubtype, selfType, usage);
                    if (typeResult.isIncomplete) {
                        isIncomplete = true;
                    }
                    return typeResult.type;
                }

                if (isNever(concreteSubtype)) {
                    return NeverType.createNever();
                }

                if (isUnbound(concreteSubtype)) {
                    return UnknownType.create();
                }

                if (!isIncomplete) {
                    addDiagnostic(
                        DiagnosticRule.reportIndexIssue,
                        LocMessage.typeNotSubscriptable().format({ type: printType(concreteSubtype) }),
                        node.d.leftExpr
                    );
                }

                return UnknownType.create();
            }
        );

        // In case we didn't walk the list items above, do so now.
        // If we have, this information will be cached.
        if (!baseTypeResult.isIncomplete) {
            node.d.items.forEach((item) => {
                if (!isTypeCached(item.d.valueExpr)) {
                    getTypeOfExpression(item.d.valueExpr, flags & EvalFlags.ForwardRefs);
                }
            });
        }

        return { type, isIncomplete, isReadOnly, isRequired, isNotRequired };
    }

    // Determines the effective variance of the type parameters for a generic
    // type alias. Normally, variance is not important for type aliases, but
    // it can be important in cases where the type alias is used to specify
    // a base class in a class definition.
    function inferVarianceForTypeAlias(type: Type): Variance[] | undefined {
        const aliasInfo = type.props?.typeAliasInfo;

        // If this isn't a generic type alias, there's nothing to do.
        if (!aliasInfo || !aliasInfo.shared.typeParams) {
            return undefined;
        }

        // Is the computed variance info already cached?
        if (aliasInfo.shared.computedVariance) {
            return aliasInfo.shared.computedVariance;
        }

        const typeParams = aliasInfo.shared.typeParams;

        // Start with all of the usage variances unknown.
        const usageVariances: Variance[] = typeParams.map(() => Variance.Unknown);

        // Prepopulate the cached value for the type alias to handle
        // recursive type aliases.
        aliasInfo.shared.computedVariance = usageVariances;

        // Traverse the type alias type definition and adjust the usage
        // variances accordingly.
        updateUsageVariancesRecursive(type, typeParams, usageVariances, Variance.Covariant);

        return usageVariances;
    }

    // Looks at uses of the type parameters within the type and adjusts the
    // variances accordingly. For example, if the type is `Mapping[T1, T2]`,
    // then T1 will be set to invariant and T2 will be set to covariant.
    function updateUsageVariancesRecursive(
        type: Type,
        typeAliasTypeParams: TypeVarType[],
        usageVariances: Variance[],
        varianceContext: Variance,
        pendingTypes: Type[] = [],
        recursionCount = 0
    ) {
        if (recursionCount > maxTypeRecursionCount) {
            return;
        }

        const transformedType = transformPossibleRecursiveTypeAlias(type);
        const isRecursiveTypeAlias = transformedType !== type;

        // If this is a recursive type alias, see if we've already recursed
        // seen it once before in the recursion stack. If so, don't recurse
        // further.
        if (isRecursiveTypeAlias) {
            const pendingOverlaps = pendingTypes.filter((pendingType) => isTypeSame(pendingType, type));
            if (pendingOverlaps.length > 1) {
                return;
            }

            pendingTypes.push(type);
        }

        recursionCount++;

        // Define a helper function that performs the actual usage variant update.
        function updateUsageVarianceForType(type: Type, variance: Variance) {
            doForEachSubtype(type, (subtype) => {
                const typeParamIndex = typeAliasTypeParams.findIndex((param) => isTypeSame(param, subtype));
                if (typeParamIndex >= 0) {
                    usageVariances[typeParamIndex] = combineVariances(usageVariances[typeParamIndex], variance);
                } else {
                    updateUsageVariancesRecursive(
                        subtype,
                        typeAliasTypeParams,
                        usageVariances,
                        variance,
                        pendingTypes,
                        recursionCount
                    );
                }
            });
        }

        doForEachSubtype(transformedType, (subtype) => {
            if (subtype.category === TypeCategory.Function) {
                subtype.shared.parameters.forEach((_param, index) => {
                    const paramType = FunctionType.getParamType(subtype, index);
                    updateUsageVarianceForType(paramType, invertVariance(varianceContext));
                });

                const returnType = FunctionType.getEffectiveReturnType(subtype);
                if (returnType) {
                    updateUsageVarianceForType(returnType, varianceContext);
                }
            } else if (subtype.category === TypeCategory.Class) {
                if (subtype.priv.typeArgs) {
                    // If the class includes type parameters that uses auto variance,
                    // compute the calculated variance.
                    inferVarianceForClass(subtype);

                    // Is the class specialized using any type arguments that correspond to
                    // the type alias' type parameters?
                    subtype.priv.typeArgs.forEach((typeArg, classParamIndex) => {
                        if (isTupleClass(subtype)) {
                            updateUsageVarianceForType(typeArg, varianceContext);
                        } else if (classParamIndex < subtype.shared.typeParams.length) {
                            const classTypeParam = subtype.shared.typeParams[classParamIndex];
                            if (isUnpackedClass(typeArg) && typeArg.priv.tupleTypeArgs) {
                                typeArg.priv.tupleTypeArgs.forEach((tupleTypeArg) => {
                                    updateUsageVarianceForType(tupleTypeArg.type, Variance.Invariant);
                                });
                            } else {
                                const effectiveVariance =
                                    classTypeParam.priv.computedVariance ?? classTypeParam.shared.declaredVariance;
                                updateUsageVarianceForType(
                                    typeArg,
                                    varianceContext === Variance.Contravariant
                                        ? invertVariance(effectiveVariance)
                                        : effectiveVariance
                                );
                            }
                        }
                    });
                }
            }
        });

        if (isRecursiveTypeAlias) {
            pendingTypes.pop();
        }
    }

    function getIndexAccessMagicMethodName(usage: EvaluatorUsage): string {
        if (usage.method === 'get') {
            return '__getitem__';
        } else if (usage.method === 'set') {
            return '__setitem__';
        } else {
            assert(usage.method === 'del');
            return '__delitem__';
        }
    }

    function getTypeOfIndexedObjectOrClass(
        node: IndexNode,
        baseType: ClassType,
        selfType: ClassType | TypeVarType | undefined,
        usage: EvaluatorUsage
    ): TypeResult {
        // Handle index operations for TypedDict classes specially.
        if (isClassInstance(baseType) && ClassType.isTypedDictClass(baseType)) {
            const typeFromTypedDict = getTypeOfIndexedTypedDict(evaluatorInterface, node, baseType, usage);
            if (typeFromTypedDict) {
                return typeFromTypedDict;
            }
        }

        const magicMethodName = getIndexAccessMagicMethodName(usage);
        const itemMethodType = getBoundMagicMethod(baseType, magicMethodName, selfType, node.d.leftExpr);

        if (!itemMethodType) {
            addDiagnostic(
                DiagnosticRule.reportIndexIssue,
                LocMessage.methodNotDefinedOnType().format({
                    name: magicMethodName,
                    type: printType(baseType),
                }),
                node.d.leftExpr
            );
            return { type: UnknownType.create() };
        }

        // Handle the special case where the object is a tuple and
        // the index is a constant number (integer) or a slice with integer
        // start and end values. In these cases, we can determine
        // the exact type by indexing into the tuple type array.
        if (
            node.d.items.length === 1 &&
            !node.d.trailingComma &&
            !node.d.items[0].d.name &&
            node.d.items[0].d.argCategory === ArgCategory.Simple &&
            isClassInstance(baseType)
        ) {
            const index0Expr = node.d.items[0].d.valueExpr;
            const valueType = getTypeOfExpression(index0Expr).type;

            if (
                isClassInstance(valueType) &&
                ClassType.isBuiltIn(valueType, 'int') &&
                isLiteralType(valueType) &&
                typeof valueType.priv.literalValue === 'number'
            ) {
                const indexValue = valueType.priv.literalValue;
                const tupleType = getSpecializedTupleType(baseType);

                if (tupleType && tupleType.priv.tupleTypeArgs) {
                    if (isTupleIndexUnambiguous(tupleType, indexValue)) {
                        if (indexValue >= 0 && indexValue < tupleType.priv.tupleTypeArgs.length) {
                            return { type: tupleType.priv.tupleTypeArgs[indexValue].type };
                        } else if (indexValue < 0 && tupleType.priv.tupleTypeArgs.length + indexValue >= 0) {
                            return {
                                type: tupleType.priv.tupleTypeArgs[tupleType.priv.tupleTypeArgs.length + indexValue]
                                    .type,
                            };
                        }
                    }
                }
            } else if (isClassInstance(valueType) && ClassType.isBuiltIn(valueType, 'slice')) {
                const tupleType = getSpecializedTupleType(baseType);

                if (tupleType && index0Expr.nodeType === ParseNodeType.Slice) {
                    const slicedTupleType = getSlicedTupleType(evaluatorInterface, tupleType, index0Expr);
                    if (slicedTupleType) {
                        return { type: slicedTupleType };
                    }
                }
            }
        }

        const positionalArgs = node.d.items.filter((item) => item.d.argCategory === ArgCategory.Simple);
        const unpackedListArgs = node.d.items.filter((item) => item.d.argCategory === ArgCategory.UnpackedList);

        let positionalIndexType: Type;
        let isPositionalIndexTypeIncomplete = false;

        if (positionalArgs.length === 1 && unpackedListArgs.length === 0 && !node.d.trailingComma) {
            // Handle the common case where there is a single positional argument.
            const typeResult = getTypeOfExpression(positionalArgs[0].d.valueExpr);
            positionalIndexType = typeResult.type;
            if (typeResult.isIncomplete) {
                isPositionalIndexTypeIncomplete = true;
            }
        } else {
            // Package up all of the positionals into a tuple.
            const tupleTypeArgs: TupleTypeArg[] = [];

            const getDeterministicTupleEntries = (type: Type): TupleTypeArg[] | undefined => {
                let aggregatedArgs: TupleTypeArg[] | undefined;
                let isDeterministic = true;

                doForEachSubtype(type, (subtype) => {
                    if (!isDeterministic) {
                        return;
                    }

                    const tupleType = getSpecializedTupleType(subtype);
                    const tupleTypeArgs = tupleType?.priv.tupleTypeArgs;

                    if (
                        !tupleTypeArgs ||
                        tupleTypeArgs.some((entry) => entry.isUnbounded || isTypeVarTuple(entry.type))
                    ) {
                        isDeterministic = false;
                        return;
                    }

                    if (!aggregatedArgs) {
                        aggregatedArgs = tupleTypeArgs.map((entry) => ({ type: entry.type, isUnbounded: false }));
                        return;
                    }

                    if (aggregatedArgs.length !== tupleTypeArgs.length) {
                        isDeterministic = false;
                        return;
                    }

                    for (let i = 0; i < aggregatedArgs.length; i++) {
                        aggregatedArgs[i] = {
                            type: combineTypes([aggregatedArgs[i].type, tupleTypeArgs[i].type]),
                            isUnbounded: false,
                        };
                    }
                });

                if (!isDeterministic || !aggregatedArgs) {
                    return undefined;
                }

                return aggregatedArgs;
            };

            node.d.items.forEach((arg) => {
                if (arg.d.argCategory === ArgCategory.Simple) {
                    const typeResult = getTypeOfExpression(arg.d.valueExpr);
                    tupleTypeArgs.push({ type: typeResult.type, isUnbounded: false });
                    if (typeResult.isIncomplete) {
                        isPositionalIndexTypeIncomplete = true;
                    }
                    return;
                }

                if (arg.d.argCategory === ArgCategory.UnpackedList) {
                    const typeResult = getTypeOfExpression(arg.d.valueExpr);
                    if (typeResult.isIncomplete) {
                        isPositionalIndexTypeIncomplete = true;
                    }

                    const deterministicEntries = getDeterministicTupleEntries(typeResult.type);
                    if (deterministicEntries) {
                        appendArray(tupleTypeArgs, deterministicEntries);
                        return;
                    }

                    const iterableType =
                        getTypeOfIterator(typeResult, /* isAsync */ false, arg.d.valueExpr)?.type ??
                        UnknownType.create();
                    tupleTypeArgs.push({ type: iterableType, isUnbounded: true });
                }
            });

            const unboundedCount = tupleTypeArgs.filter((typeArg) => typeArg.isUnbounded).length;
            if (unboundedCount > 1) {
                const firstUnboundedIndex = tupleTypeArgs.findIndex((typeArg) => typeArg.isUnbounded);
                const removedEntries = tupleTypeArgs.splice(firstUnboundedIndex);
                tupleTypeArgs.push({
                    type: combineTypes(removedEntries.map((entry) => entry.type)),
                    isUnbounded: true,
                });
            }

            positionalIndexType = makeTupleObject(evaluatorInterface, tupleTypeArgs);
        }

        const argList: Arg[] = [
            {
                argCategory: ArgCategory.Simple,
                typeResult: { type: positionalIndexType, isIncomplete: isPositionalIndexTypeIncomplete },
            },
        ];

        if (usage.method === 'set') {
            let setType = usage.setType?.type ?? AnyType.create();

            // Expand constrained type variables.
            if (isTypeVar(setType) && TypeVarType.hasConstraints(setType)) {
                const conditionFilter = isClassInstance(baseType) ? baseType.props?.condition : undefined;
                setType = makeTopLevelTypeVarsConcrete(
                    setType,
                    /* makeParamSpecsConcrete */ undefined,
                    conditionFilter
                );
            }

            argList.push({
                argCategory: ArgCategory.Simple,
                typeResult: {
                    type: setType,
                    isIncomplete: !!usage.setType?.isIncomplete,
                },
            });
        }

        const callResult = validateCallArgs(
            node,
            argList,
            { type: itemMethodType },
            /* constraints */ undefined,
            /* skipUnknownArgCheck */ true,
            /* inferenceContext */ undefined
        );

        return {
            type: callResult.returnType ?? UnknownType.create(),
            isIncomplete: !!callResult.isTypeIncomplete,
        };
    }

    function getTypeArgs(node: IndexNode, flags: EvalFlags, options?: GetTypeArgsOptions): TypeResultWithNode[] {
        const typeArgs: TypeResultWithNode[] = [];
        let adjFlags = flags | EvalFlags.NoConvertSpecialForm;
        adjFlags &= ~EvalFlags.TypeFormArg;

        const allowFinalClassVar = () => {
            // If the annotation is a variable within the body of a dataclass, a
            // Final is allowed with a ClassVar annotation. In all other cases,
            // it's disallowed.
            const enclosingClassNode = ParseTreeUtils.getEnclosingClass(node, /* stopeAtFunction */ true);
            if (enclosingClassNode) {
                const classTypeInfo = getTypeOfClass(enclosingClassNode);
                if (classTypeInfo && ClassType.isDataClass(classTypeInfo.classType)) {
                    return true;
                }
            }
            return false;
        };

        if (options?.isFinalAnnotation) {
            adjFlags |= EvalFlags.NoFinal;

            if (!allowFinalClassVar()) {
                adjFlags |= EvalFlags.NoClassVar;
            }
        } else if (options?.isClassVarAnnotation) {
            adjFlags |= EvalFlags.NoClassVar;

            if (!allowFinalClassVar()) {
                adjFlags |= EvalFlags.NoFinal;
            }
        } else {
            adjFlags &= ~(
                EvalFlags.NoSpecialize |
                EvalFlags.NoParamSpec |
                EvalFlags.NoTypeVarTuple |
                EvalFlags.AllowRequired |
                EvalFlags.EnforceVarianceConsistency
            );

            if (!options?.isAnnotatedClass) {
                adjFlags |= EvalFlags.NoClassVar | EvalFlags.NoFinal;
            }

            adjFlags |= EvalFlags.AllowUnpackedTuple | EvalFlags.AllowConcatenate;
        }

        // Create a local function that validates a single type argument.
        const getTypeArgTypeResult = (expr: ExpressionNode, argIndex: number) => {
            let typeResult: TypeResultWithNode;

            // If it's a custom __class_getitem__, none of the arguments should be
            // treated as types.
            if (options?.hasCustomClassGetItem) {
                adjFlags =
                    EvalFlags.NoParamSpec | EvalFlags.NoTypeVarTuple | EvalFlags.NoSpecialize | EvalFlags.NoClassVar;
                typeResult = {
                    ...getTypeOfExpression(expr, adjFlags),
                    node: expr,
                };
            } else if (options?.isAnnotatedClass && argIndex > 0) {
                // If it's an Annotated[a, b, c], only the first index should be
                // treated as a type. The others can be regular (non-type) objects.
                adjFlags =
                    EvalFlags.NoParamSpec | EvalFlags.NoTypeVarTuple | EvalFlags.NoSpecialize | EvalFlags.NoClassVar;
                if (isAnnotationEvaluationPostponed(AnalyzerNodeInfo.getFileInfo(node))) {
                    adjFlags |= EvalFlags.ForwardRefs;
                }

                typeResult = {
                    ...getTypeOfExpression(expr, adjFlags),
                    node: expr,
                };
            } else {
                typeResult = getTypeArg(expr, adjFlags, !!options?.supportsTypedDictTypeArg && argIndex === 0);
            }

            return typeResult;
        };

        // A tuple is treated the same as a list of items in the index.
        if (
            node.d.items.length === 1 &&
            !node.d.trailingComma &&
            !node.d.items[0].d.name &&
            node.d.items[0].d.valueExpr.nodeType === ParseNodeType.Tuple
        ) {
            node.d.items[0].d.valueExpr.d.items.forEach((item, index) => {
                typeArgs.push(getTypeArgTypeResult(item, index));
            });

            // Set the node's type so it isn't reevaluated later.
            setTypeResultForNode(node.d.items[0].d.valueExpr, { type: UnknownType.create() });

            return typeArgs;
        }

        node.d.items.forEach((arg, index) => {
            const typeResult = getTypeArgTypeResult(arg.d.valueExpr, index);

            if (arg.d.argCategory !== ArgCategory.Simple) {
                if (arg.d.argCategory === ArgCategory.UnpackedList) {
                    if (!options?.isAnnotatedClass || index === 0) {
                        const unpackedType = applyUnpackToTupleLike(typeResult.type);

                        if (unpackedType) {
                            typeResult.type = unpackedType;
                        } else {
                            if ((flags & EvalFlags.TypeExpression) !== 0) {
                                addDiagnostic(
                                    DiagnosticRule.reportInvalidTypeForm,
                                    LocMessage.unpackNotAllowed(),
                                    arg.d.valueExpr
                                );
                                typeResult.typeErrors = true;
                            } else {
                                typeResult.type = UnknownType.create();
                            }
                        }
                    }
                }
            }

            if (arg.d.name) {
                if ((flags & EvalFlags.TypeExpression) !== 0) {
                    addDiagnostic(
                        DiagnosticRule.reportInvalidTypeForm,
                        LocMessage.keywordArgInTypeArgument(),
                        arg.d.valueExpr
                    );
                    typeResult.typeErrors = true;
                } else {
                    typeResult.type = UnknownType.create();
                }
            }

            if (
                arg.d.valueExpr.nodeType !== ParseNodeType.Error ||
                arg.d.valueExpr.d.category !== ErrorExpressionCategory.MissingIndexOrSlice
            ) {
                typeArgs.push(typeResult);
            }
        });

        return typeArgs;
    }

    function getTypeArg(node: ExpressionNode, flags: EvalFlags, supportsDictExpression: boolean): TypeResultWithNode {
        let typeResult: TypeResultWithNode;

        let adjustedFlags =
            flags | EvalFlags.InstantiableType | EvalFlags.ConvertEllipsisToAny | EvalFlags.StrLiteralAsType;

        const fileInfo = AnalyzerNodeInfo.getFileInfo(node);
        if (fileInfo.isStubFile) {
            adjustedFlags |= EvalFlags.ForwardRefs;
        }

        if (node.nodeType === ParseNodeType.List) {
            typeResult = {
                type: UnknownType.create(),
                typeList: node.d.items.map((entry) => {
                    return { ...getTypeOfExpression(entry, adjustedFlags), node: entry };
                }),
                node,
            };

            // Set the node's type so it isn't reevaluated later.
            setTypeResultForNode(node, { type: UnknownType.create() });
        } else if (node.nodeType === ParseNodeType.Dictionary && supportsDictExpression) {
            const inlinedTypeDict =
                registry.typedDictClass && isInstantiableClass(registry.typedDictClass)
                    ? createTypedDictTypeInlined(evaluatorInterface, node, registry.typedDictClass)
                    : undefined;
            const keyTypeFallback =
                registry.strClass && isInstantiableClass(registry.strClass) ? registry.strClass : UnknownType.create();

            typeResult = {
                type: keyTypeFallback,
                inlinedTypeDict,
                node,
            };
        } else {
            typeResult = { ...getTypeOfExpression(node, adjustedFlags), node };

            if (node.nodeType === ParseNodeType.Dictionary) {
                addDiagnostic(DiagnosticRule.reportInvalidTypeForm, LocMessage.dictInAnnotation(), node);
            }

            if ((flags & EvalFlags.NoClassVar) !== 0) {
                // "ClassVar" is not allowed as a type argument.
                if (isClass(typeResult.type) && ClassType.isBuiltIn(typeResult.type, 'ClassVar')) {
                    addDiagnostic(DiagnosticRule.reportInvalidTypeForm, LocMessage.classVarNotAllowed(), node);
                }
            }
        }

        return typeResult;
    }

    function buildTupleTypesList(
        entryTypeResults: TypeResult[],
        stripLiterals: boolean,
        convertModule: boolean
    ): TupleTypeArg[] {
        const entryTypes: TupleTypeArg[] = [];

        for (const typeResult of entryTypeResults) {
            let possibleUnpackedTuple: Type | undefined;
            if (typeResult.unpackedType) {
                possibleUnpackedTuple = typeResult.unpackedType;
            } else if (isUnpacked(typeResult.type)) {
                possibleUnpackedTuple = typeResult.type;
            }

            // Is this an unpacked tuple? If so, we can append the individual
            // unpacked entries onto the new tuple. If it's not an upacked tuple
            // but some other iterator (e.g. a List), we won't know the number of
            // items, so we'll need to leave the Tuple open-ended.
            if (
                possibleUnpackedTuple &&
                isClassInstance(possibleUnpackedTuple) &&
                possibleUnpackedTuple.priv.tupleTypeArgs
            ) {
                const typeArgs = possibleUnpackedTuple.priv.tupleTypeArgs;

                if (!typeArgs) {
                    entryTypes.push({ type: UnknownType.create(), isUnbounded: true });
                } else {
                    appendArray(entryTypes, typeArgs);
                }
            } else if (isNever(typeResult.type) && typeResult.isIncomplete && !typeResult.unpackedType) {
                entryTypes.push({ type: UnknownType.create(/* isIncomplete */ true), isUnbounded: false });
            } else {
                let entryType = convertSpecialFormToRuntimeValue(typeResult.type, EvalFlags.None, convertModule);
                entryType = stripLiterals ? stripTypeForm(stripLiteralValue(entryType)) : entryType;
                entryTypes.push({ type: entryType, isUnbounded: !!typeResult.unpackedType });
            }
        }

        // If there are multiple unbounded entries, combine all of them into a single
        // unbounded entry to avoid violating the invariant that there can be at most
        // one unbounded entry in a tuple.
        if (entryTypes.filter((t) => t.isUnbounded).length > 1) {
            const firstUnboundedEntryIndex = entryTypes.findIndex((t) => t.isUnbounded);
            const removedEntries = entryTypes.splice(firstUnboundedEntryIndex);
            entryTypes.push({ type: combineTypes(removedEntries.map((t) => t.type)), isUnbounded: true });
        }

        return entryTypes;
    }

    function getTypeOfCall(
        node: CallNode,
        flags: EvalFlags,
        inferenceContext: InferenceContext | undefined
    ): TypeResult {
        let baseTypeResult: TypeResult | undefined;

        // Check for the use of `type(x)` within a type annotation. This isn't
        // allowed, and it's a common mistake, so we want to emit a diagnostic
        // that guides the user to the right solution.
        if (
            (flags & EvalFlags.TypeExpression) !== 0 &&
            node.d.leftExpr.nodeType === ParseNodeType.Name &&
            node.d.leftExpr.d.value === 'type'
        ) {
            const diag = new DiagnosticAddendum();
            diag.addMessage(LocAddendum.useTypeInstead());
            addDiagnostic(
                DiagnosticRule.reportInvalidTypeForm,
                LocMessage.typeCallNotAllowed() + diag.getString(),
                node
            );
        }

        // Handle immediate calls of lambdas specially.
        if (node.d.leftExpr.nodeType === ParseNodeType.Lambda) {
            baseTypeResult = getTypeOfLambdaForCall(node, inferenceContext);
        } else {
            baseTypeResult = getTypeOfExpression(
                node.d.leftExpr,
                EvalFlags.CallBaseDefaults | (flags & EvalFlags.ForwardRefs)
            );
        }

        const argList = ParseTreeUtils.getArgsByRuntimeOrder(node).map((arg) => {
            const functionArg: Arg = {
                valueExpression: arg.d.valueExpr,
                argCategory: arg.d.argCategory,
                node: arg,
                name: arg.d.name,
            };
            return functionArg;
        });

        let typeResult: TypeResult = { type: UnknownType.create() };

        baseTypeResult.type = ensureSignatureIsUnique(baseTypeResult.type, node);

        if (!isTypeAliasPlaceholder(baseTypeResult.type)) {
            if (node.d.leftExpr.nodeType === ParseNodeType.Name && node.d.leftExpr.d.value === 'super') {
                // Handle the built-in "super" call specially.
                typeResult = getTypeOfSuperCall(node);
            } else if (
                isAnyOrUnknown(baseTypeResult.type) &&
                node.d.leftExpr.nodeType === ParseNodeType.Name &&
                node.d.leftExpr.d.value === 'reveal_type'
            ) {
                // Handle the implicit "reveal_type" call.
                typeResult = getTypeOfRevealType(node, inferenceContext);
            } else if (isFunction(baseTypeResult.type) && FunctionType.isBuiltIn(baseTypeResult.type, 'reveal_type')) {
                // Handle the "typing.reveal_type" call.
                typeResult = getTypeOfRevealType(node, inferenceContext);
            } else if (isFunction(baseTypeResult.type) && FunctionType.isBuiltIn(baseTypeResult.type, 'assert_type')) {
                // Handle the "typing.assert_type" call.
                typeResult = getTypeOfAssertType(node, inferenceContext);
            } else if (isClass(baseTypeResult.type) && ClassType.isBuiltIn(baseTypeResult.type, 'TypeForm')) {
                // Handle the "typing.TypeForm" call.
                typeResult = getTypeOfTypeForm(node, baseTypeResult.type);
            } else if (
                isAnyOrUnknown(baseTypeResult.type) &&
                node.d.leftExpr.nodeType === ParseNodeType.Name &&
                node.d.leftExpr.d.value === 'reveal_locals'
            ) {
                if (node.d.args.length === 0) {
                    // Handle the special-case "reveal_locals" call.
                    typeResult.type = getTypeOfRevealLocals(node);
                } else {
                    addDiagnostic(DiagnosticRule.reportCallIssue, LocMessage.revealLocalsArgs(), node);
                }
            } else {
                const callResult = validateCallArgs(
                    node,
                    argList,
                    baseTypeResult,
                    /* constraints */ undefined,
                    /* skipUnknownArgCheck */ false,
                    inferenceContext
                );

                typeResult.type = callResult.returnType ?? UnknownType.create();

                if (callResult.argumentErrors) {
                    typeResult.typeErrors = true;
                } else {
                    typeResult.overloadsUsedForCall = callResult.overloadsUsedForCall;
                }

                if (callResult.isTypeIncomplete) {
                    typeResult.isIncomplete = true;
                }
            }

            if (baseTypeResult.isIncomplete) {
                typeResult.isIncomplete = true;
            }
        } else {
            typeResult.isIncomplete = true;
        }

        // Don't bother evaluating the arguments if we're speculatively evaluating the call
        // or the base type is incomplete.
        if (!isSpeculativeModeInUse(node) && !baseTypeResult.isIncomplete) {
            // Touch all of the args so they're marked accessed even if there were errors.
            // We skip this if it's a TypeVar() call in the typing.pyi module because
            // this results in a cyclical type resolution problem whereby we try to
            // retrieve the str class, which inherits from Sequence, which inherits from
            // Iterable, which uses a TypeVar. Without this, Iterable and Sequence classes
            // have invalid type parameters.
            const isCyclicalTypeVarCall =
                isInstantiableClass(baseTypeResult.type) &&
                ClassType.isBuiltIn(baseTypeResult.type, 'TypeVar') &&
                AnalyzerNodeInfo.getFileInfo(node).isTypingStubFile;

            if (!isCyclicalTypeVarCall) {
                argList.forEach((arg) => {
                    if (
                        arg.valueExpression &&
                        arg.valueExpression.nodeType !== ParseNodeType.StringList &&
                        !isTypeCached(arg.valueExpression)
                    ) {
                        getTypeOfExpression(arg.valueExpression);
                    }
                });
            }
        }

        if ((flags & EvalFlags.TypeExpression) !== 0) {
            addDiagnostic(DiagnosticRule.reportInvalidTypeForm, LocMessage.typeAnnotationCall(), node);

            typeResult = { type: UnknownType.create() };
        }

        return typeResult;
    }

    // This function is used in cases where a lambda is defined and immediately
    // called. In this case, we can't use normal bidirectional type inference
    // to determine the lambda's type. It needs to be inferred from the argument
    // types instead.
    function getTypeOfLambdaForCall(node: CallNode, inferenceContext: InferenceContext | undefined): TypeResult {
        assert(node.d.leftExpr.nodeType === ParseNodeType.Lambda);

        const expectedType = FunctionType.createSynthesizedInstance('');
        expectedType.shared.declaredReturnType = inferenceContext
            ? inferenceContext.expectedType
            : UnknownType.create();

        let isArgTypeIncomplete = false;
        node.d.args.forEach((arg, index) => {
            const argTypeResult = getTypeOfExpression(arg.d.valueExpr);
            if (argTypeResult.isIncomplete) {
                isArgTypeIncomplete = true;
            }

            FunctionType.addParam(
                expectedType,
                FunctionParam.create(
                    ParamCategory.Simple,
                    argTypeResult.type,
                    FunctionParamFlags.NameSynthesized | FunctionParamFlags.TypeDeclared,
                    `p${index.toString()}`
                )
            );
        });

        // If the lambda's param list ends with a "/" positional parameter separator,
        // add a corresponding separator to the expected type.
        const lambdaParams = node.d.leftExpr.d.params;
        if (lambdaParams.length > 0) {
            const lastParam = lambdaParams[lambdaParams.length - 1];
            if (lastParam.d.category === ParamCategory.Simple && !lastParam.d.name) {
                FunctionType.addPositionOnlyParamSeparator(expectedType);
            }
        }

        function getLambdaType() {
            return getTypeOfExpression(node.d.leftExpr, EvalFlags.CallBaseDefaults, makeInferenceContext(expectedType));
        }

        // If one or more of the arguments are incomplete, use speculative mode
        // for the lambda evaluation because it may need to be reevaluated once
        // the arg types are complete.
        let typeResult =
            isArgTypeIncomplete || isSpeculativeModeInUse(node) || inferenceContext?.isTypeIncomplete
                ? useSpeculativeMode(node.d.leftExpr, getLambdaType)
                : getLambdaType();

        // If bidirectional type inference failed, use normal type inference instead.
        if (typeResult.typeErrors) {
            typeResult = getTypeOfExpression(node.d.leftExpr, EvalFlags.CallBaseDefaults);
        }

        return typeResult;
    }

    function getTypeOfTypeForm(node: CallNode, typeFormClass: ClassType): TypeResult {
        if (
            node.d.args.length !== 1 ||
            node.d.args[0].d.argCategory !== ArgCategory.Simple ||
            node.d.args[0].d.name !== undefined
        ) {
            addDiagnostic(DiagnosticRule.reportCallIssue, LocMessage.typeFormArgs(), node);
            return { type: UnknownType.create() };
        }

        const typeFormResult = getTypeOfArgExpectingType(convertNodeToArg(node.d.args[0]), {
            typeFormArg: isTypeFormSupported(node),
            noNonTypeSpecialForms: true,
            typeExpression: true,
        });

        if (!typeFormResult.typeErrors && typeFormResult.type.props?.typeForm) {
            typeFormResult.type = convertToInstance(
                ClassType.specialize(typeFormClass, [convertToInstance(typeFormResult.type.props.typeForm)])
            );
        }

        return typeFormResult;
    }

    function getTypeOfAssertType(node: CallNode, inferenceContext: InferenceContext | undefined): TypeResult {
        if (
            node.d.args.length !== 2 ||
            node.d.args[0].d.argCategory !== ArgCategory.Simple ||
            node.d.args[0].d.name !== undefined ||
            node.d.args[0].d.argCategory !== ArgCategory.Simple ||
            node.d.args[1].d.name !== undefined
        ) {
            addDiagnostic(DiagnosticRule.reportCallIssue, LocMessage.assertTypeArgs(), node);
            return { type: UnknownType.create() };
        }

        const arg0TypeResult = getTypeOfExpression(node.d.args[0].d.valueExpr, /* flags */ undefined, inferenceContext);
        if (arg0TypeResult.isIncomplete) {
            return { type: UnknownType.create(/* isIncomplete */ true), isIncomplete: true };
        }

        const assertedType = convertToInstance(
            getTypeOfArgExpectingType(convertNodeToArg(node.d.args[1]), {
                typeExpression: true,
            }).type
        );

        // We'll replace TypeGuard and TypeIs with bool for purposes of assert_type testing.
        // The spec is unclear on whether this is the correct behavior, but it seems to be
        // what mypy does -- and what various library authors expect.
        const arg0Type = stripTypeGuard(arg0TypeResult.type);

        if (
            !isTypeSame(assertedType, arg0Type, {
                treatAnySameAsUnknown: true,
                ignorePseudoGeneric: true,
                ignoreConditions: true,
            })
        ) {
            const srcDestTypes = printSrcDestTypes(arg0TypeResult.type, assertedType, { expandTypeAlias: true });

            addDiagnostic(
                DiagnosticRule.reportAssertTypeFailure,
                LocMessage.assertTypeTypeMismatch().format({
                    expected: srcDestTypes.destType,
                    received: srcDestTypes.sourceType,
                }),
                node.d.args[0].d.valueExpr
            );
        }

        return { type: arg0TypeResult.type };
    }

    function convertNodeToArg(node: ArgumentNode): ArgWithExpression {
        return {
            argCategory: node.d.argCategory,
            name: node.d.name,
            valueExpression: node.d.valueExpr,
        };
    }

    function getTypeOfRevealType(node: CallNode, inferenceContext: InferenceContext | undefined): TypeResult {
        let arg0Value: ExpressionNode | undefined;
        let expectedRevealTypeNode: ExpressionNode | undefined;
        let expectedRevealType: Type | undefined;
        let expectedTextNode: ExpressionNode | undefined;
        let expectedText: string | undefined;

        // Make sure there is only one positional argument passed as arg 0.
        node.d.args.forEach((arg, index) => {
            if (index === 0) {
                if (arg.d.argCategory === ArgCategory.Simple && !arg.d.name) {
                    arg0Value = arg.d.valueExpr;
                }
            } else if (arg.d.argCategory !== ArgCategory.Simple || !arg.d.name) {
                arg0Value = undefined;
            } else if (arg.d.name.d.value === 'expected_text') {
                expectedTextNode = arg.d.valueExpr;
                const expectedTextType = getTypeOfExpression(arg.d.valueExpr).type;

                if (
                    !isClassInstance(expectedTextType) ||
                    !ClassType.isBuiltIn(expectedTextType, 'str') ||
                    typeof expectedTextType.priv.literalValue !== 'string'
                ) {
                    addDiagnostic(
                        DiagnosticRule.reportCallIssue,
                        LocMessage.revealTypeExpectedTextArg(),
                        arg.d.valueExpr
                    );
                } else {
                    expectedText = expectedTextType.priv.literalValue;
                }
            } else if (arg.d.name.d.value === 'expected_type') {
                expectedRevealTypeNode = arg.d.valueExpr;
                expectedRevealType = convertToInstance(
                    getTypeOfArgExpectingType(convertNodeToArg(arg), {
                        typeExpression: true,
                    }).type
                );
            }
        });

        if (!arg0Value) {
            addDiagnostic(DiagnosticRule.reportCallIssue, LocMessage.revealTypeArgs(), node);
            return { type: UnknownType.create() };
        }

        const typeResult = getTypeOfExpression(arg0Value, /* flags */ undefined, inferenceContext);
        const type = typeResult.type;

        const exprString = ParseTreeUtils.printExpression(arg0Value);
        const typeString = printType(type, { expandTypeAlias: true });

        if (!typeResult.isIncomplete) {
            if (expectedText !== undefined) {
                if (expectedText !== typeString) {
                    addDiagnostic(
                        DiagnosticRule.reportGeneralTypeIssues,
                        LocMessage.revealTypeExpectedTextMismatch().format({
                            expected: expectedText,
                            received: typeString,
                        }),
                        expectedTextNode ?? arg0Value
                    );
                }
            }

            if (expectedRevealType) {
                if (!isTypeSame(expectedRevealType, type, { ignorePseudoGeneric: true })) {
                    const expectedRevealTypeText = printType(expectedRevealType);
                    addDiagnostic(
                        DiagnosticRule.reportGeneralTypeIssues,
                        LocMessage.revealTypeExpectedTypeMismatch().format({
                            expected: expectedRevealTypeText,
                            received: typeString,
                        }),
                        expectedRevealTypeNode ?? arg0Value
                    );
                }
            }

            addInformation(LocAddendum.typeOfSymbol().format({ name: exprString, type: typeString }), node.d.args[0]);
        }

        return { type, isIncomplete: typeResult.isIncomplete };
    }

    function getTypeOfRevealLocals(node: CallNode) {
        let curNode: ParseNode | undefined = node;
        let scope: Scope | undefined;

        while (curNode) {
            scope = ScopeUtils.getScopeForNode(curNode);

            // Stop when we get a valid scope that's not a list comprehension
            // scope. That includes lambdas, functions, classes, and modules.
            if (scope && scope.type !== ScopeType.Comprehension) {
                break;
            }

            curNode = curNode.parent;
        }

        const infoMessages: string[] = [];

        if (scope) {
            scope.symbolTable.forEach((symbol, name) => {
                if (!symbol.isIgnoredForProtocolMatch()) {
                    const typeOfSymbol = getEffectiveTypeOfSymbol(symbol);
                    infoMessages.push(
                        LocAddendum.typeOfSymbol().format({
                            name,
                            type: printType(typeOfSymbol, { expandTypeAlias: true }),
                        })
                    );
                }
            });
        }

        if (infoMessages.length > 0) {
            addInformation(infoMessages.join('\n'), node);
        } else {
            addInformation(LocMessage.revealLocalsNone(), node);
        }

        return getNoneType();
    }

    function getTypeOfSuperCall(node: CallNode): TypeResult {
        if (node.d.args.length > 2) {
            addDiagnostic(DiagnosticRule.reportCallIssue, LocMessage.superCallArgCount(), node.d.args[2]);
        }

        const enclosingFunction = ParseTreeUtils.getEnclosingFunctionEvaluationScope(node);
        const enclosingClass = enclosingFunction ? ParseTreeUtils.getEnclosingClass(enclosingFunction) : undefined;
        const enclosingClassType = enclosingClass ? getTypeOfClass(enclosingClass)?.classType : undefined;

        // Determine which class the "super" call is applied to. If
        // there is no first argument, then the class is implicit.
        let targetClassType: Type;
        if (node.d.args.length > 0) {
            targetClassType = getTypeOfExpression(node.d.args[0].d.valueExpr).type;
            const concreteTargetClassType = makeTopLevelTypeVarsConcrete(targetClassType);

            if (
                !isAnyOrUnknown(concreteTargetClassType) &&
                !isInstantiableClass(concreteTargetClassType) &&
                !isMetaclassInstance(concreteTargetClassType)
            ) {
                addDiagnostic(
                    DiagnosticRule.reportArgumentType,
                    LocMessage.superCallFirstArg().format({ type: printType(targetClassType) }),
                    node.d.args[0].d.valueExpr
                );
            }
        } else {
            if (enclosingClassType) {
                targetClassType = enclosingClassType ?? UnknownType.create();

                // Zero-argument forms of super are not allowed within static methods.
                // This results in a runtime exception.
                if (enclosingFunction) {
                    const functionInfo = getFunctionInfoFromDecorators(
                        evaluatorInterface,
                        enclosingFunction,
                        /* isInClass */ true
                    );

                    if ((functionInfo?.flags & FunctionTypeFlags.StaticMethod) !== 0) {
                        addDiagnostic(
                            DiagnosticRule.reportGeneralTypeIssues,
                            LocMessage.superCallZeroArgFormStaticMethod(),
                            node.d.leftExpr
                        );
                    }
                }
            } else {
                addDiagnostic(
                    DiagnosticRule.reportGeneralTypeIssues,
                    LocMessage.superCallZeroArgForm(),
                    node.d.leftExpr
                );
                targetClassType = UnknownType.create();
            }
        }

        const concreteTargetClassType = makeTopLevelTypeVarsConcrete(targetClassType);

        // Determine whether to further narrow the type.
        let secondArgType: Type | undefined;
        let bindToType: ClassType | undefined;

        if (node.d.args.length > 1) {
            secondArgType = getTypeOfExpression(node.d.args[1].d.valueExpr).type;
            const secondArgConcreteType = makeTopLevelTypeVarsConcrete(secondArgType);

            let reportError = false;

            doForEachSubtype(secondArgConcreteType, (secondArgSubtype) => {
                if (isAnyOrUnknown(secondArgSubtype)) {
                    // Ignore unknown or any types.
                } else if (isClassInstance(secondArgSubtype)) {
                    if (isInstantiableClass(concreteTargetClassType)) {
                        if (
                            !derivesFromClassRecursive(
                                ClassType.cloneAsInstantiable(secondArgSubtype),
                                concreteTargetClassType,
                                /* ignoreUnknown */ true
                            )
                        ) {
                            reportError = true;
                        }
                    }
                    bindToType = secondArgSubtype;
                } else if (isInstantiableClass(secondArgSubtype)) {
                    if (isInstantiableClass(concreteTargetClassType)) {
                        if (
                            !ClassType.isBuiltIn(concreteTargetClassType, 'type') &&
                            !derivesFromClassRecursive(
                                secondArgSubtype,
                                concreteTargetClassType,
                                /* ignoreUnknown */ true
                            )
                        ) {
                            reportError = true;
                        }
                    }
                    bindToType = secondArgSubtype;
                } else {
                    reportError = true;
                }
            });

            if (reportError) {
                addDiagnostic(
                    DiagnosticRule.reportArgumentType,
                    LocMessage.superCallSecondArg().format({ type: printType(targetClassType) }),
                    node.d.args[1].d.valueExpr
                );

                return { type: UnknownType.create() };
            }
        } else if (enclosingClassType) {
            bindToType = ClassType.cloneAsInstance(enclosingClassType);

            // Get the type from the self or cls parameter if it is explicitly annotated.
            // If it's a TypeVar, change the bindToType into a conditional type.
            const enclosingMethod = ParseTreeUtils.getEnclosingFunction(node);
            let implicitBindToType: Type | undefined;

            if (enclosingMethod) {
                const methodTypeInfo = getTypeOfFunction(enclosingMethod);
                if (methodTypeInfo) {
                    const methodType = methodTypeInfo.functionType;
                    if (
                        FunctionType.isClassMethod(methodType) ||
                        FunctionType.isConstructorMethod(methodType) ||
                        FunctionType.isInstanceMethod(methodType)
                    ) {
                        if (
                            methodType.shared.parameters.length > 0 &&
                            FunctionParam.isTypeDeclared(methodType.shared.parameters[0])
                        ) {
                            let paramType = FunctionType.getParamType(methodType, 0);
                            const liveScopeIds = ParseTreeUtils.getTypeVarScopesForNode(node);
                            paramType = makeTypeVarsBound(paramType, liveScopeIds);
                            implicitBindToType = makeTopLevelTypeVarsConcrete(paramType);
                        }
                    }
                }
            }

            if (bindToType && implicitBindToType) {
                const typeCondition = getTypeCondition(implicitBindToType);
                if (typeCondition) {
                    bindToType = addConditionToType(bindToType, typeCondition);
                } else if (isClass(implicitBindToType)) {
                    bindToType = implicitBindToType;
                }
            }
        }

        // Determine whether super() should return an instance of the class or
        // the class itself. It depends on whether the super() call is located
        // within an instance method or not.
        let resultIsInstance = true;
        if (node.d.args.length <= 1) {
            const enclosingMethod = ParseTreeUtils.getEnclosingFunction(node);
            if (enclosingMethod) {
                const methodType = getTypeOfFunction(enclosingMethod);
                if (methodType) {
                    if (
                        FunctionType.isStaticMethod(methodType.functionType) ||
                        FunctionType.isConstructorMethod(methodType.functionType) ||
                        FunctionType.isClassMethod(methodType.functionType)
                    ) {
                        resultIsInstance = false;
                    }
                }
            }
        }

        // Python docs indicate that super() isn't valid for
        // operations other than member accesses or attribute lookups.
        const parentNode = node.parent;
        if (parentNode?.nodeType === ParseNodeType.MemberAccess) {
            const memberName = parentNode.d.member.d.value;
            let effectiveTargetClass = isClass(concreteTargetClassType) ? concreteTargetClassType : undefined;

            // If the bind-to type is a protocol, don't use the effective target class.
            // This pattern is used for mixins, where the mixin type is a protocol class
            // that is used to decorate the "self" or "cls" parameter.
            let isProtocolClass = false;
            if (
                bindToType &&
                ClassType.isProtocolClass(bindToType) &&
                effectiveTargetClass &&
                !ClassType.isSameGenericClass(
                    TypeBase.isInstance(bindToType) ? ClassType.cloneAsInstantiable(bindToType) : bindToType,
                    effectiveTargetClass
                )
            ) {
                isProtocolClass = true;
                effectiveTargetClass = undefined;
            }

            if (bindToType) {
                bindToType = selfSpecializeClass(bindToType, { useBoundTypeVars: true });
            }

            const lookupResults = bindToType
                ? lookUpClassMember(bindToType, memberName, MemberAccessFlags.Default, effectiveTargetClass)
                : undefined;

            let resultType: Type;
            if (lookupResults && isInstantiableClass(lookupResults.classType)) {
                resultType = lookupResults.classType;

                if (isProtocolClass) {
                    // If the bindToType is a protocol class, set the "include subclasses" flag
                    // so we don't enforce that called methods are implemented within the protocol.
                    resultType = ClassType.cloneIncludeSubclasses(resultType);
                }
            } else if (
                effectiveTargetClass &&
                !isAnyOrUnknown(effectiveTargetClass) &&
                !derivesFromAnyOrUnknown(effectiveTargetClass)
            ) {
                resultType = registry.objectClass ?? UnknownType.create();
            } else {
                resultType = UnknownType.create();
            }

            let bindToSelfType: ClassType | TypeVarType | undefined;
            if (bindToType) {
                if (secondArgType) {
                    // If a TypeVar was passed as the second argument, use it
                    // to derive the the self type.
                    if (isTypeVar(secondArgType)) {
                        bindToSelfType = convertToInstance(secondArgType);
                    }
                } else {
                    // If this is a zero-argument form of super(), synthesize
                    // a Self type to bind to.
                    bindToSelfType = TypeBase.cloneForCondition(
                        TypeVarType.cloneAsBound(
                            synthesizeTypeVarForSelfCls(
                                ClassType.cloneIncludeSubclasses(bindToType, /* includeSubclasses */ false),
                                /* isClsParam */ false
                            )
                        ),
                        bindToType.props?.condition
                    );
                }
            }

            const type = resultIsInstance ? convertToInstance(resultType, /* includeSubclasses */ false) : resultType;

            return { type, bindToSelfType };
        }

        // Handle the super() call when used outside of a member access expression.
        if (isInstantiableClass(concreteTargetClassType)) {
            // We don't know which member is going to be accessed, so we cannot
            // deterministically determine the correct type in this case. We'll
            // use a heuristic that produces the "correct" (desired) behavior in
            // most cases. If there's a bindToType and the targetClassType is one
            // of the base classes of the bindToType, we'll return the next base
            // class.
            if (bindToType) {
                let nextBaseClassType: Type | undefined;

                if (
                    ClassType.isSameGenericClass(
                        TypeBase.isInstance(bindToType) ? ClassType.cloneAsInstantiable(bindToType) : bindToType,
                        concreteTargetClassType
                    )
                ) {
                    if (bindToType.shared.baseClasses.length > 0) {
                        nextBaseClassType = bindToType.shared.baseClasses[0];
                    }
                } else {
                    const baseClassIndex = bindToType.shared.baseClasses.findIndex(
                        (baseClass) =>
                            isClass(baseClass) &&
                            ClassType.isSameGenericClass(baseClass, concreteTargetClassType as ClassType)
                    );

                    if (baseClassIndex >= 0 && baseClassIndex < bindToType.shared.baseClasses.length - 1) {
                        nextBaseClassType = bindToType.shared.baseClasses[baseClassIndex + 1];
                    }
                }

                if (nextBaseClassType) {
                    if (isInstantiableClass(nextBaseClassType)) {
                        nextBaseClassType = specializeForBaseClass(bindToType, nextBaseClassType);
                    }
                    return { type: resultIsInstance ? convertToInstance(nextBaseClassType) : nextBaseClassType };
                }

                // There's not much we can say about the type. Simply return object or type.
                if (registry.typeClass && isInstantiableClass(registry.typeClass)) {
                    return {
                        type: resultIsInstance ? getObjectType() : convertToInstance(registry.typeClass),
                    };
                }
            } else {
                // If the class derives from one or more unknown classes,
                // return unknown here to prevent spurious errors.
                if (concreteTargetClassType.shared.mro.some((mroBase) => isAnyOrUnknown(mroBase))) {
                    return { type: UnknownType.create() };
                }

                const baseClasses = concreteTargetClassType.shared.baseClasses;
                if (baseClasses.length > 0) {
                    const baseClassType = baseClasses[0];
                    if (isInstantiableClass(baseClassType)) {
                        return {
                            type: resultIsInstance ? ClassType.cloneAsInstance(baseClassType) : baseClassType,
                        };
                    }
                }
            }
        }

        return { type: UnknownType.create() };
    }

    // When evaluating a call, the errorNode is typically the call node, which
    // encompasses all of the argument expressions. This means we can normally
    // use the errorNode as the root for speculative evaluation. However, there
    // are some cases where we don't have a call node (e.g. in the case of an
    // __init_subclass__ validation). Here we need to find some other parent
    // node of the error node that encompasses all of the arguments.
    function getSpeculativeNodeForCall(errorNode: ExpressionNode): ParseNode {
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

    // Attempts to find an overloaded function for each set of argument
    // types in the expandedArgTypes list. If an argument type is undefined,
    // its type is evaluated from the argument's expression using the
    // corresponding parameter's expected type. The first time this is called,
    // there will be only one argument list in expandedArgTypes, and all entries
    // (one for each argument) will be undefined. On subsequent calls, this
    // list will grow to include union expansions.
    function validateOverloadsWithExpandedTypes(
        errorNode: ExpressionNode,
        expandedArgTypes: (Type | undefined)[][],
        argParamMatches: MatchArgsToParamsResult[],
        constraints: ConstraintTracker | undefined,
        skipUnknownArgCheck: boolean | undefined,
        inferenceContext: InferenceContext | undefined
    ): CallResult {
        const returnTypes: Type[] = [];
        let matchedOverloads: MatchedOverloadInfo[] = [];
        let isTypeIncomplete = false;
        let overloadsUsedForCall: FunctionType[] = [];
        let isDefinitiveMatchFound = false;
        const speculativeNode = getSpeculativeNodeForCall(errorNode);

        for (let expandedTypesIndex = 0; expandedTypesIndex < expandedArgTypes.length; expandedTypesIndex++) {
            let matchedOverload: FunctionType | undefined;
            const argTypeOverride = expandedArgTypes[expandedTypesIndex];
            const hasArgTypeOverride = argTypeOverride.some((a) => a !== undefined);
            let possibleMatchResults: MatchedOverloadInfo[] = [];
            let possibleMatchInvolvesIncompleteUnknown = false;
            isDefinitiveMatchFound = false;

            for (let overloadIndex = 0; overloadIndex < argParamMatches.length; overloadIndex++) {
                const overload = argParamMatches[overloadIndex].overload;

                let matchResults = argParamMatches[overloadIndex];
                if (hasArgTypeOverride) {
                    matchResults = { ...argParamMatches[overloadIndex] };
                    matchResults.argParams = matchResults.argParams.map((argParam, argIndex) => {
                        if (!argTypeOverride[argIndex]) {
                            return argParam;
                        }
                        const argParamCopy = { ...argParam };
                        argParamCopy.argType = argTypeOverride[argIndex];
                        return argParamCopy;
                    });
                }

                // Clone the constraints so we don't modify the original.
                const effectiveConstraints = constraints?.clone() ?? new ConstraintTracker();

                // Use speculative mode so we don't output any diagnostics or
                // record any final types in the type cache.
                const callResult = useSpeculativeMode(speculativeNode, () => {
                    return validateArgTypesWithContext(
                        errorNode,
                        matchResults,
                        effectiveConstraints,
                        /* skipUnknownArgCheck */ true,
                        inferenceContext
                    );
                });

                if (callResult.isTypeIncomplete) {
                    isTypeIncomplete = true;
                }

                if (!callResult.argumentErrors && callResult.returnType) {
                    overloadsUsedForCall.push(overload);

                    matchedOverload = overload;
                    const matchedOverloadInfo: MatchedOverloadInfo = {
                        overload: matchedOverload,
                        matchResults,
                        constraints: effectiveConstraints,
                        returnType: callResult.returnType,
                        argResults: callResult.argResults ?? [],
                    };
                    matchedOverloads.push(matchedOverloadInfo);

                    if (callResult.anyOrUnknownArg || matchResults.unpackedArgOfUnknownLength) {
                        possibleMatchResults.push(matchedOverloadInfo);

                        if (callResult.anyOrUnknownArg) {
                            if (isIncompleteUnknown(callResult.anyOrUnknownArg)) {
                                possibleMatchInvolvesIncompleteUnknown = true;
                            }
                        }
                    } else {
                        returnTypes.push(callResult.returnType);
                        isDefinitiveMatchFound = true;
                        break;
                    }
                }
            }

            // If we didn't find a definitive match that doesn't depend on
            // an Any or Unknown argument, fall back on the possible match.
            // If there were multiple possible matches, evaluate the type as
            // Unknown, but include the "possible types" to allow for completion
            // suggestions.
            if (!isDefinitiveMatchFound && possibleMatchResults.length > 0) {
                possibleMatchResults = filterOverloadMatchesForUnpackedArgs(possibleMatchResults);
                possibleMatchResults = filterOverloadMatchesForAnyArgs(possibleMatchResults);

                // Did the filtering produce a single result? If so, we're done.
                if (possibleMatchResults.length === 1) {
                    overloadsUsedForCall = [possibleMatchResults[0].overload];
                    returnTypes.push(possibleMatchResults[0].returnType);
                    matchedOverloads = [possibleMatchResults[0]];
                } else {
                    // Eliminate any return types that are subsumed by other return types.
                    let dedupedMatchResults: Type[] = [];
                    let dedupedResultsIncludeAny = false;

                    possibleMatchResults.forEach((result) => {
                        let isSubtypeSubsumed = false;

                        for (let dedupedIndex = 0; dedupedIndex < dedupedMatchResults.length; dedupedIndex++) {
                            if (assignType(dedupedMatchResults[dedupedIndex], result.returnType)) {
                                const anyOrUnknown = containsAnyOrUnknown(
                                    dedupedMatchResults[dedupedIndex],
                                    /* recurse */ false
                                );
                                if (!anyOrUnknown) {
                                    isSubtypeSubsumed = true;
                                } else if (isAny(anyOrUnknown)) {
                                    dedupedResultsIncludeAny = true;
                                }
                                break;
                            } else if (assignType(result.returnType, dedupedMatchResults[dedupedIndex])) {
                                const anyOrUnknown = containsAnyOrUnknown(result.returnType, /* recurse */ false);
                                if (!anyOrUnknown) {
                                    dedupedMatchResults[dedupedIndex] = NeverType.createNever();
                                } else if (isAny(anyOrUnknown)) {
                                    dedupedResultsIncludeAny = true;
                                }
                                break;
                            }
                        }

                        if (!isSubtypeSubsumed) {
                            dedupedMatchResults.push(result.returnType);
                        }
                    });

                    dedupedMatchResults = dedupedMatchResults.filter((t) => !isNever(t));
                    const combinedTypes = combineTypes(dedupedMatchResults);

                    let returnType = combinedTypes;
                    if (dedupedMatchResults.length > 1) {
                        // If one or more of the deduped types is Any or contains Any,
                        // we will assume that the person who defined the overload really
                        // wanted Any rather than Unknown. In cases where the deduped types
                        // simply contains conflicting results without an Any, we'll use
                        // an UnknownType.
                        if (dedupedResultsIncludeAny) {
                            returnType = AnyType.create();
                        } else {
                            returnType = UnknownType.createPossibleType(
                                combinedTypes,
                                possibleMatchInvolvesIncompleteUnknown
                            );
                        }
                    }

                    returnTypes.push(returnType);
                }
            }

            if (!matchedOverload) {
                return { argumentErrors: true, isTypeIncomplete, overloadsUsedForCall };
            }
        }

        // We found a match for all of the expanded argument lists. Copy the
        // resulting type var context back into the caller's type var context.
        // Use the type var context from the last matched overload because it
        // includes the type var solutions for all earlier matched overloads.
        if (constraints && isDefinitiveMatchFound) {
            constraints.copyFromClone(matchedOverloads[matchedOverloads.length - 1].constraints);
        }

        // And run through the first expanded argument list one more time to
        // populate the type cache.
        const finalConstraints = constraints ?? matchedOverloads[0].constraints;
        const finalCallResult = validateArgTypesWithContext(
            errorNode,
            matchedOverloads[0].matchResults,
            finalConstraints,
            skipUnknownArgCheck,
            inferenceContext
        );

        if (finalCallResult.isTypeIncomplete) {
            isTypeIncomplete = true;
        }

        return {
            argumentErrors: finalCallResult.argumentErrors,
            anyOrUnknownArg: finalCallResult.anyOrUnknownArg,
            returnType: combineTypes(returnTypes),
            isTypeIncomplete,
            specializedInitSelfType: finalCallResult.specializedInitSelfType,
            overloadsUsedForCall,
        };
    }

    // Determines whether one or more overloads can be eliminated because they
    // rely on an unpacked argument of unknown length when there is at least
    // one overload that doesn't because it maps to an *args parameter.
    function filterOverloadMatchesForUnpackedArgs(matches: MatchedOverloadInfo[]): MatchedOverloadInfo[] {
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
    function filterOverloadMatchesForAnyArgs(matches: MatchedOverloadInfo[]): MatchedOverloadInfo[] {
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

    function getBestOverloadForArgs(
        errorNode: ExpressionNode,
        typeResult: TypeResult<OverloadedType>,
        argList: Arg[]
    ): FunctionType | undefined {
        let overloadIndex = 0;
        const matches: MatchArgsToParamsResult[] = [];
        const speculativeNode = getSpeculativeNodeForCall(errorNode);

        useSignatureTracker(errorNode, () => {
            // Create a list of potential overload matches based on arguments.
            OverloadedType.getOverloads(typeResult.type).forEach((overload) => {
                useSpeculativeMode(speculativeNode, () => {
                    const matchResults = matchArgsToParams(
                        errorNode,
                        argList,
                        { type: overload, isIncomplete: typeResult.isIncomplete },
                        overloadIndex
                    );

                    if (!matchResults.argumentErrors) {
                        matches.push(matchResults);
                    }

                    overloadIndex++;
                });
            });
        });

        let winningOverloadIndex: number | undefined;

        matches.forEach((match, matchIndex) => {
            if (winningOverloadIndex === undefined) {
                useSpeculativeMode(speculativeNode, () => {
                    const callResult = validateArgTypes(
                        errorNode,
                        match,
                        new ConstraintTracker(),
                        /* skipUnknownArgCheck */ true
                    );

                    if (callResult && !callResult.argumentErrors) {
                        winningOverloadIndex = matchIndex;
                    }
                });
            }
        });

        return winningOverloadIndex === undefined ? undefined : matches[winningOverloadIndex].overload;
    }

    function validateOverloadedArgTypes(
        errorNode: ExpressionNode,
        argList: Arg[],
        typeResult: TypeResult<OverloadedType>,
        constraints: ConstraintTracker | undefined,
        skipUnknownArgCheck: boolean | undefined,
        inferenceContext: InferenceContext | undefined
    ): CallResult {
        const filteredMatchResults: MatchArgsToParamsResult[] = [];
        let contextFreeArgTypes: Type[] | undefined;
        let isTypeIncomplete = !!typeResult.isIncomplete;
        const type = typeResult.type;
        const speculativeNode = getSpeculativeNodeForCall(errorNode);

        // Start by evaluating the types of the arguments without any expected
        // type. Also, filter the list of overloads based on the number of
        // positional and keyword arguments that are present. We do all of this
        // speculatively because we don't want to record any types in the type
        // cache or record any diagnostics at this stage.
        useSpeculativeMode(speculativeNode, () => {
            let overloadIndex = 0;
            OverloadedType.getOverloads(type).forEach((overload) => {
                // Consider only the functions that have the @overload decorator,
                // not the final function that omits the overload. This is the
                // intended behavior according to PEP 484.
                const matchResults = matchArgsToParams(
                    errorNode,
                    argList,
                    { type: overload, isIncomplete: typeResult.isIncomplete },
                    overloadIndex
                );

                if (!matchResults.argumentErrors) {
                    filteredMatchResults.push(matchResults);
                }

                overloadIndex++;
            });
        });

        // If there are no possible arg/param matches among the overloads,
        // emit an error that includes the argument types.
        if (filteredMatchResults.length === 0) {
            // Skip the error message if we're in speculative mode because it's very
            // expensive, and we're going to suppress the diagnostic anyway.
            if (!canSkipDiagnosticForNode(errorNode)) {
                const overloads = OverloadedType.getOverloads(type);
                const functionName =
                    overloads.length > 0 && overloads[0].shared.name
                        ? overloads[0].shared.name
                        : '<anonymous function>';
                const diagAddendum = new DiagnosticAddendum();
                const argTypes = argList.map((t) => {
                    const typeString = printType(getTypeOfArg(t, /* inferenceContext */ undefined).type);

                    if (t.argCategory === ArgCategory.UnpackedList) {
                        return `*${typeString}`;
                    }

                    if (t.argCategory === ArgCategory.UnpackedDictionary) {
                        return `**${typeString}`;
                    }

                    return typeString;
                });

                diagAddendum.addMessage(LocAddendum.argumentTypes().format({ types: argTypes.join(', ') }));
                addDiagnostic(
                    DiagnosticRule.reportCallIssue,
                    LocMessage.noOverload().format({ name: functionName }) + diagAddendum.getString(),
                    errorNode
                );
            }

            return { argumentErrors: true, isTypeIncomplete, overloadsUsedForCall: [] };
        }

        // Create a helper function that evaluates the overload that best
        // matches the arg/param lists.
        function evaluateUsingBestMatchingOverload(skipUnknownArgCheck: boolean, emitNoOverloadFoundError: boolean) {
            // Find the match with the smallest argument match score. If there
            // are more than one with the same score, use the one with the
            // largest index. Later overloads tend to be more general.
            const bestMatch = filteredMatchResults.reduce((previous, current) => {
                if (current.argumentMatchScore === previous.argumentMatchScore) {
                    return current.overloadIndex > previous.overloadIndex ? current : previous;
                }
                return current.argumentMatchScore < previous.argumentMatchScore ? current : previous;
            });

            // If there is more than one filtered match, report that no match
            // was possible and emit a diagnostic that provides the most likely.
            if (emitNoOverloadFoundError) {
                const functionName = bestMatch.overload.shared.name || '<anonymous function>';
                const diagnostic = addDiagnostic(
                    DiagnosticRule.reportCallIssue,
                    LocMessage.noOverload().format({ name: functionName }),
                    errorNode
                );

                const overrideDecl = bestMatch.overload.shared.declaration;
                if (diagnostic && overrideDecl) {
                    diagnostic.addRelatedInfo(
                        LocAddendum.overloadIndex().format({ index: bestMatch.overloadIndex + 1 }),
                        overrideDecl.uri,
                        overrideDecl.range
                    );
                }
            }

            const effectiveConstraints = constraints ?? new ConstraintTracker();

            return validateArgTypesWithContext(
                errorNode,
                bestMatch,
                effectiveConstraints,
                skipUnknownArgCheck,
                inferenceContext
            );
        }

        // If there is only one possible arg/param match among the overloads,
        // use the normal type matching mechanism because it is faster and
        // will provide a clearer error message.
        if (filteredMatchResults.length === 1) {
            return evaluateUsingBestMatchingOverload(
                /* skipUnknownArgCheck */ false,
                /* emitNoOverloadFoundError */ false
            );
        }

        let expandedArgTypes: (Type | undefined)[][] | undefined = [argList.map(() => undefined)];

        while (true) {
            const callResult = validateOverloadsWithExpandedTypes(
                errorNode,
                expandedArgTypes,
                filteredMatchResults,
                constraints,
                skipUnknownArgCheck,
                inferenceContext
            );

            if (callResult.isTypeIncomplete) {
                isTypeIncomplete = true;
            }

            if (!callResult.argumentErrors) {
                return callResult;
            }

            // We didn't find an overload match. Try to expand the next union
            // argument type into individual types and retry with the expanded types.
            if (!contextFreeArgTypes) {
                useSpeculativeMode(getSpeculativeNodeForCall(errorNode), () => {
                    // Evaluate the types of each argument expression without regard to
                    // the context. We'll use this to determine whether we need to do
                    // union expansion.
                    contextFreeArgTypes = argList.map((arg) => {
                        if (arg.typeResult) {
                            return arg.typeResult.type;
                        }

                        if (arg.valueExpression) {
                            const valueExpressionNode = arg.valueExpression;
                            return useSpeculativeMode(valueExpressionNode, () => {
                                return getTypeOfExpression(valueExpressionNode).type;
                            });
                        }

                        return AnyType.create();
                    });
                });
            }

            expandedArgTypes = expandArgTypes(contextFreeArgTypes!, expandedArgTypes);

            // Check for combinatoric explosion and break out of loop.
            if (!expandedArgTypes || expandedArgTypes.length > maxTotalOverloadArgTypeExpansionCount) {
                break;
            }
        }

        // We couldn't find any valid overloads. Skip the error message if we're
        // in speculative mode because it's very expensive, and we're going to
        // suppress the diagnostic anyway.
        if (!canSkipDiagnosticForNode(errorNode) && !isTypeIncomplete) {
            const result = evaluateUsingBestMatchingOverload(
                /* skipUnknownArgCheck */ true,
                /* emitNoOverloadFoundError */ true
            );

            // Replace the result with an unknown type since we don't know
            // what overload should have been used.
            result.returnType = UnknownType.create();
            return { ...result, argumentErrors: true };
        }

        return { argumentErrors: true, isTypeIncomplete, overloadsUsedForCall: [] };
    }

    // Replaces each item in the expandedArgTypes with n items where n is
    // the number of subtypes in a union or other expandable type.
    // The contextFreeArgTypes parameter represents the types of the arguments
    // evaluated with no bidirectional type inference (i.e. without the help of
    // the corresponding parameter's expected type). If the function returns
    // undefined, that indicates that all types have been expanded, and no
    // more expansion is possible.
    function expandArgTypes(
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

            expandedTypes = expandArgType(argType);
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

    function expandArgType(type: Type): Type[] | undefined {
        const expandedTypes: Type[] = [];

        // Expand any top-level type variables with constraints.
        type = makeTopLevelTypeVarsConcrete(type);

        doForEachSubtype(type, (subtype) => {
            if (isClassInstance(subtype)) {
                // Expand any bool or Enum literals.
                const expandedLiteralTypes = enumerateLiteralsForType(evaluatorInterface, subtype);
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

    // Validates that the arguments can be assigned to the call's parameter
    // list, specializes the call based on arg types, and returns the
    // specialized type of the return value. If it detects an error along
    // the way, it emits a diagnostic and sets argumentErrors to true.
    function validateCallArgs(
        errorNode: ExpressionNode,
        argList: Arg[],
        callTypeResult: TypeResult,
        constraints: ConstraintTracker | undefined,
        skipUnknownArgCheck: boolean | undefined,
        inferenceContext: InferenceContext | undefined,
        recursionCount = 0
    ): CallResult {
        let argumentErrors = false;
        let isTypeIncomplete = false;
        let specializedInitSelfType: Type | undefined;
        const overloadsUsedForCall: FunctionType[] = [];

        if (recursionCount > maxTypeRecursionCount) {
            return { returnType: UnknownType.create(), argumentErrors: true, overloadsUsedForCall };
        }
        recursionCount++;

        // Special forms are not callable.
        if (callTypeResult.type.props?.specialForm) {
            const exprNode = errorNode.nodeType === ParseNodeType.Call ? errorNode.d.leftExpr : errorNode;
            addDiagnostic(
                DiagnosticRule.reportCallIssue,
                LocMessage.objectNotCallable().format({
                    type: printType(callTypeResult.type.props.specialForm, { expandTypeAlias: true }),
                }),
                exprNode
            );
            return { returnType: UnknownType.create(), argumentErrors: true, overloadsUsedForCall };
        }

        let returnType = mapSubtypesExpandTypeVars(
            callTypeResult.type,
            { sortSubtypes: true },
            (expandedSubtype, unexpandedSubtype, isLastIteration) => {
                return useSpeculativeMode(
                    isLastIteration ? undefined : getSpeculativeNodeForCall(errorNode),
                    () => {
                        const callResult = validateCallArgsForSubtype(
                            errorNode,
                            argList,
                            expandedSubtype,
                            unexpandedSubtype,
                            !!callTypeResult.isIncomplete,
                            constraints,
                            skipUnknownArgCheck,
                            inferenceContext,
                            recursionCount
                        );

                        if (callResult.argumentErrors) {
                            argumentErrors = true;
                        }

                        if (callResult.isTypeIncomplete) {
                            isTypeIncomplete = true;
                        }

                        if (callResult.overloadsUsedForCall) {
                            appendArray(overloadsUsedForCall, callResult.overloadsUsedForCall);
                        }

                        specializedInitSelfType = callResult.specializedInitSelfType;

                        return callResult.returnType;
                    },
                    {
                        allowDiagnostics: true,
                    }
                );
            }
        );

        // If we ended up with a "Never" type because all code paths returned
        // undefined due to argument errors, transform the result into an Unknown
        // to avoid subsequent false positives.
        if (argumentErrors && isNever(returnType) && !returnType.priv.isNoReturn) {
            returnType = UnknownType.create();
        }

        return {
            argumentErrors,
            returnType,
            isTypeIncomplete,
            specializedInitSelfType,
            overloadsUsedForCall,
        };
    }

    function validateCallArgsForSubtype(
        errorNode: ExpressionNode,
        argList: Arg[],
        expandedCallType: Type,
        unexpandedCallType: Type,
        isCallTypeIncomplete: boolean,
        constraints: ConstraintTracker | undefined,
        skipUnknownArgCheck: boolean | undefined,
        inferenceContext: InferenceContext | undefined,
        recursionCount: number
    ): CallResult {
        function touchArgTypes() {
            if (!isCallTypeIncomplete) {
                argList.forEach((arg) => {
                    if (arg.valueExpression && !isSpeculativeModeInUse(arg.valueExpression)) {
                        getTypeOfArg(arg, /* inferenceContext */ undefined);
                    }
                });
            }
        }

        switch (expandedCallType.category) {
            case TypeCategory.Never:
            case TypeCategory.Unknown:
            case TypeCategory.Any: {
                // Create a dummy callable that accepts all arguments and validate
                // that the argument expressions are valid.
                const dummyFunctionType = FunctionType.createInstance('', '', '', FunctionTypeFlags.None);
                FunctionType.addDefaultParams(dummyFunctionType);

                const dummyCallResult = validateCallForFunction(
                    errorNode,
                    argList,
                    dummyFunctionType,
                    isCallTypeIncomplete,
                    constraints,
                    skipUnknownArgCheck,
                    inferenceContext
                );

                return { ...dummyCallResult, returnType: expandedCallType };
            }

            case TypeCategory.Function: {
                return validateCallForFunction(
                    errorNode,
                    argList,
                    expandedCallType,
                    isCallTypeIncomplete,
                    constraints,
                    skipUnknownArgCheck,
                    inferenceContext
                );
            }

            case TypeCategory.Overloaded: {
                return validateCallForOverloaded(
                    errorNode,
                    argList,
                    expandedCallType,
                    isCallTypeIncomplete,
                    constraints,
                    skipUnknownArgCheck,
                    inferenceContext
                );
            }

            case TypeCategory.Class: {
                if (isNoneInstance(expandedCallType)) {
                    addDiagnostic(DiagnosticRule.reportOptionalCall, LocMessage.noneNotCallable(), errorNode);

                    touchArgTypes();
                    return { argumentErrors: true };
                }

                if (TypeBase.isInstantiable(expandedCallType)) {
                    return validateCallForInstantiableClass(
                        errorNode,
                        argList,
                        expandedCallType,
                        unexpandedCallType,
                        skipUnknownArgCheck,
                        inferenceContext
                    );
                }

                return validateCallForClassInstance(
                    errorNode,
                    argList,
                    expandedCallType,
                    unexpandedCallType,
                    constraints,
                    skipUnknownArgCheck,
                    inferenceContext,
                    recursionCount
                );
            }

            // TypeVars should have been expanded in most cases,
            // but we still need to handle the case of Type[T] where
            // T is a constrained type that contains a union. We also
            // need to handle recursive type aliases.
            case TypeCategory.TypeVar: {
                return validateCallArgs(
                    errorNode,
                    argList,
                    { type: transformPossibleRecursiveTypeAlias(expandedCallType), isIncomplete: isCallTypeIncomplete },
                    constraints,
                    skipUnknownArgCheck,
                    inferenceContext,
                    recursionCount
                );
            }

            case TypeCategory.Module: {
                addDiagnostic(DiagnosticRule.reportCallIssue, LocMessage.moduleNotCallable(), errorNode);

                touchArgTypes();
                return { argumentErrors: true };
            }
        }

        touchArgTypes();
        return { argumentErrors: true };
    }

    function validateCallForFunction(
        errorNode: ExpressionNode,
        argList: Arg[],
        type: FunctionType,
        isCallTypeIncomplete: boolean,
        constraints: ConstraintTracker | undefined,
        skipUnknownArgCheck: boolean | undefined,
        inferenceContext: InferenceContext | undefined
    ): CallResult {
        if (TypeBase.isInstantiable(type)) {
            addDiagnostic(
                DiagnosticRule.reportCallIssue,
                LocMessage.callableNotInstantiable().format({
                    type: printType(type),
                }),
                errorNode
            );
            return { returnType: undefined, argumentErrors: true };
        }

        // The stdlib collections/__init__.pyi stub file defines namedtuple
        // as a function rather than a class, so we need to check for it here.
        if (FunctionType.isBuiltIn(type, 'namedtuple')) {
            addDiagnostic(DiagnosticRule.reportUntypedNamedTuple, LocMessage.namedTupleNoTypes(), errorNode);

            const result: CallResult = {
                returnType: createNamedTupleType(evaluatorInterface, errorNode, argList, /* includesTypes */ false),
            };

            validateArgs(errorNode, argList, { type: type }, constraints, skipUnknownArgCheck, inferenceContext);

            return result;
        }

        // Handle the NewType specially, replacing the normal return type.
        if (FunctionType.isBuiltIn(type, 'NewType')) {
            return { returnType: specialForms.createNewType(evaluatorInterface, errorNode, argList, registry) };
        }

        const functionResult = validateArgs(
            errorNode,
            argList,
            { type, isIncomplete: isCallTypeIncomplete },
            constraints,
            skipUnknownArgCheck,
            inferenceContext
        );

        let isTypeIncomplete = !!functionResult.isTypeIncomplete;
        let returnType = functionResult.returnType;

        let argumentErrors = !!functionResult.argumentErrors;
        if (!argumentErrors) {
            // Call the function transform logic to handle special-cased functions.
            const transformed = applyFunctionTransform(evaluatorInterface, errorNode, argList, type, {
                argumentErrors: !!functionResult.argumentErrors,
                returnType: functionResult.returnType ?? UnknownType.create(isTypeIncomplete),
                isTypeIncomplete,
            });

            returnType = transformed.returnType;
            if (transformed.isTypeIncomplete) {
                isTypeIncomplete = true;
            }
            if (transformed.argumentErrors) {
                argumentErrors = true;
            }
        }

        if (FunctionType.isBuiltIn(type, '__import__')) {
            // For the special __import__ type, we'll override the return type to be "Any".
            // This is required because we don't know what module was imported, and we don't
            // want to fail type checks when accessing members of the resulting module type.
            returnType = AnyType.create();
        }

        return {
            returnType,
            isTypeIncomplete,
            argumentErrors,
            overloadsUsedForCall: functionResult.overloadsUsedForCall,
            specializedInitSelfType: functionResult.specializedInitSelfType,
        };
    }

    function getAbstractSymbolInfo(classType: ClassType, symbolName: string): AbstractSymbol | undefined {
        return symbolResolution.getAbstractSymbolInfo(evaluatorInterface, classType, symbolName);
    }

    function validateCallForOverloaded(
        errorNode: ExpressionNode,
        argList: Arg[],
        expandedCallType: OverloadedType,
        isCallTypeIncomplete: boolean,
        constraints: ConstraintTracker | undefined,
        skipUnknownArgCheck: boolean | undefined,
        inferenceContext: InferenceContext | undefined
    ): CallResult {
        const overloads = OverloadedType.getOverloads(expandedCallType);
        // Handle the 'cast' call as a special case.
        if (
            overloads.length > 0 &&
            FunctionType.isBuiltIn(overloads[0], ['typing.cast', 'typing_extensions.cast']) &&
            argList.length === 2
        ) {
            return { returnType: evaluateCastCall(argList, errorNode) };
        }

        const callResult = validateOverloadedArgTypes(
            errorNode,
            argList,
            { type: expandedCallType, isIncomplete: isCallTypeIncomplete },
            constraints,
            skipUnknownArgCheck,
            inferenceContext
        );

        let returnType = callResult.returnType ?? UnknownType.create();
        let isTypeIncomplete = !!callResult.isTypeIncomplete;
        let argumentErrors = !!callResult.argumentErrors;

        if (!argumentErrors) {
            // Call the function transform logic to handle special-cased functions.
            const transformed = applyFunctionTransform(evaluatorInterface, errorNode, argList, expandedCallType, {
                argumentErrors: !!callResult.argumentErrors,
                returnType: callResult.returnType ?? UnknownType.create(isTypeIncomplete),
                isTypeIncomplete,
            });

            returnType = transformed.returnType;
            if (transformed.isTypeIncomplete) {
                isTypeIncomplete = true;
            }

            if (transformed.argumentErrors) {
                argumentErrors = true;
            }
        }

        return {
            returnType,
            isTypeIncomplete,
            argumentErrors,
            overloadsUsedForCall: callResult.overloadsUsedForCall,
            specializedInitSelfType: callResult.specializedInitSelfType,
        };
    }

    function validateCallForInstantiableClass(
        errorNode: ExpressionNode,
        argList: Arg[],
        expandedCallType: ClassType,
        unexpandedCallType: Type,
        skipUnknownArgCheck: boolean | undefined,
        inferenceContext: InferenceContext | undefined
    ): CallResult {
        if (expandedCallType.priv.literalValue !== undefined) {
            addDiagnostic(DiagnosticRule.reportCallIssue, LocMessage.literalNotCallable(), errorNode);

            return { returnType: UnknownType.create(), argumentErrors: true };
        }

        if (ClassType.isBuiltIn(expandedCallType)) {
            const className = expandedCallType.priv.aliasName ?? expandedCallType.shared.name;

            // Handle a call to a metaclass explicitly.
            if (isInstantiableMetaclass(expandedCallType)) {
                if (expandedCallType.priv.typeArgs && expandedCallType.priv.isTypeArgExplicit) {
                    addDiagnostic(
                        DiagnosticRule.reportCallIssue,
                        LocMessage.objectNotCallable().format({
                            type: printType(expandedCallType),
                        }),
                        errorNode
                    );
                    return { returnType: UnknownType.create(), argumentErrors: true };
                }

                // Validate the constructor arguments.
                validateConstructorArgs(
                    evaluatorInterface,
                    errorNode,
                    argList,
                    expandedCallType,
                    skipUnknownArgCheck,
                    inferenceContext
                );

                // The one-parameter form of "type" returns the class
                // for the specified object.
                if (expandedCallType.shared.name === 'type' && argList.length === 1) {
                    const argTypeResult = getTypeOfArg(argList[0], /* inferenceContext */ undefined);
                    const argType = argTypeResult.type;
                    const returnType = mapSubtypes(argType, (subtype) => {
                        if (isNever(subtype)) {
                            return subtype;
                        }

                        if (isClass(subtype)) {
                            // Specifically handle the case where the subtype is a class-like
                            // object created by calling NewType. At runtime, it's actually
                            // a FunctionType object.
                            if (
                                isClassInstance(subtype) &&
                                ClassType.isNewTypeClass(subtype) &&
                                !subtype.priv.includeSubclasses
                            ) {
                                if (registry.functionClass) {
                                    return registry.functionClass;
                                }
                            }

                            return convertToInstantiable(stripLiteralValue(subtype));
                        }

                        if (TypeBase.isInstance(subtype)) {
                            if (isFunction(subtype) || isTypeVar(subtype)) {
                                return convertToInstantiable(subtype);
                            }
                        }

                        return ClassType.specialize(ClassType.cloneAsInstance(expandedCallType), [
                            UnknownType.create(),
                        ]);
                    });

                    return { returnType, isTypeIncomplete: argTypeResult.isIncomplete };
                }

                if (argList.length >= 2) {
                    // The two-parameter form of a call to a metaclass returns a new class
                    // built from the specified base types.
                    return {
                        returnType:
                            specialForms.createClassFromMetaclass(
                                evaluatorInterface,
                                errorNode,
                                argList,
                                expandedCallType
                            ) || AnyType.create(),
                    };
                }

                // If the parameter to type() is not statically known,
                // fall back to Any.
                return { returnType: AnyType.create() };
            }

            if (className === 'TypeVar') {
                return {
                    returnType: specialForms.createTypeVarType(
                        evaluatorInterface,
                        errorNode,
                        expandedCallType,
                        argList
                    ),
                };
            }

            if (className === 'TypeVarTuple') {
                return {
                    returnType: specialForms.createTypeVarTupleType(
                        evaluatorInterface,
                        errorNode,
                        expandedCallType,
                        argList
                    ),
                };
            }

            if (className === 'ParamSpec') {
                return {
                    returnType: specialForms.createParamSpecType(
                        evaluatorInterface,
                        errorNode,
                        expandedCallType,
                        argList
                    ),
                };
            }

            if (className === 'TypeAliasType') {
                const newTypeAlias = specialForms.createTypeAliasType(evaluatorInterface, errorNode, argList);
                if (newTypeAlias) {
                    return { returnType: newTypeAlias };
                }
            }

            if (className === 'NamedTuple') {
                const result: CallResult = {
                    returnType: createNamedTupleType(evaluatorInterface, errorNode, argList, /* includesTypes */ true),
                };

                const initTypeResult = getBoundInitMethod(
                    evaluatorInterface,
                    errorNode,
                    ClassType.cloneAsInstance(expandedCallType),
                    /* diag */ undefined,
                    /* additionalFlags */ MemberAccessFlags.Default
                );

                if (initTypeResult && isOverloaded(initTypeResult.type)) {
                    validateOverloadedArgTypes(
                        errorNode,
                        argList,
                        { type: initTypeResult.type },
                        /* constraints */ undefined,
                        skipUnknownArgCheck,
                        /* inferenceContext */ undefined
                    );
                }

                return result;
            }

            if (className === 'NewType') {
                return { returnType: specialForms.createNewType(evaluatorInterface, errorNode, argList, registry) };
            }

            // Handle the Sentinel call specially.
            if (className === 'Sentinel') {
                if (AnalyzerNodeInfo.getFileInfo(errorNode).diagnosticRuleSet.enableExperimentalFeatures) {
                    return { returnType: createSentinelType(evaluatorInterface, errorNode, argList) };
                }
            }

            if (ClassType.isSpecialFormClass(expandedCallType)) {
                addDiagnostic(
                    DiagnosticRule.reportCallIssue,
                    LocMessage.typeNotIntantiable().format({ type: className }),
                    errorNode
                );

                return { returnType: UnknownType.create(), argumentErrors: true };
            }

            if (className === 'TypedDict') {
                return { returnType: createTypedDictType(evaluatorInterface, errorNode, expandedCallType, argList) };
            }

            if (className === 'auto' && argList.length === 0) {
                return { returnType: getEnumAutoValueType(evaluatorInterface, errorNode) };
            }
        }

        // Is it a call to an Enum class factory?
        if (
            isClass(expandedCallType) &&
            expandedCallType.shared.effectiveMetaclass &&
            isClass(expandedCallType.shared.effectiveMetaclass) &&
            isEnumMetaclass(expandedCallType.shared.effectiveMetaclass) &&
            !isEnumClassWithMembers(evaluatorInterface, expandedCallType)
        ) {
            return {
                returnType:
                    createEnumType(evaluatorInterface, errorNode, expandedCallType, argList) ??
                    convertToInstance(unexpandedCallType),
            };
        }

        if (ClassType.supportsAbstractMethods(expandedCallType)) {
            const abstractSymbols = getAbstractSymbols(expandedCallType);

            if (
                abstractSymbols.length > 0 &&
                !expandedCallType.priv.includeSubclasses &&
                !isTypeVar(unexpandedCallType)
            ) {
                // If the class is abstract, it can't be instantiated.
                const diagAddendum = new DiagnosticAddendum();
                const errorsToDisplay = 2;

                abstractSymbols.forEach((abstractMethod, index) => {
                    if (index === errorsToDisplay) {
                        diagAddendum.addMessage(
                            LocAddendum.memberIsAbstractMore().format({
                                count: abstractSymbols.length - errorsToDisplay,
                            })
                        );
                    } else if (index < errorsToDisplay) {
                        if (isInstantiableClass(abstractMethod.classType)) {
                            const className = abstractMethod.classType.shared.name;
                            diagAddendum.addMessage(
                                LocAddendum.memberIsAbstract().format({
                                    type: className,
                                    name: abstractMethod.symbolName,
                                })
                            );
                        }
                    }
                });

                addDiagnostic(
                    DiagnosticRule.reportAbstractUsage,
                    LocMessage.instantiateAbstract().format({
                        type: expandedCallType.shared.name,
                    }) + diagAddendum.getString(),
                    errorNode
                );
            }
        }

        if (ClassType.isProtocolClass(expandedCallType) && !expandedCallType.priv.includeSubclasses) {
            // If the class is a protocol, it can't be instantiated.
            addDiagnostic(
                DiagnosticRule.reportAbstractUsage,
                LocMessage.instantiateProtocol().format({
                    type: expandedCallType.shared.name,
                }),
                errorNode
            );
        }

        // Assume this is a call to the constructor.
        const constructorResult = validateConstructorArgs(
            evaluatorInterface,
            errorNode,
            argList,
            expandedCallType,
            skipUnknownArgCheck,
            inferenceContext
        );

        const overloadsUsedForCall = constructorResult.overloadsUsedForCall;
        const argumentErrors = constructorResult.argumentErrors;
        const isTypeIncomplete = constructorResult.isTypeIncomplete;

        let returnType = constructorResult.returnType;

        // If the expandedCallType originated from a TypeVar, convert
        // the constructed type back to the TypeVar. For example, if
        // we have `cls: Type[_T]` followed by `_T()`.
        if (isTypeVar(unexpandedCallType)) {
            returnType = convertToInstance(unexpandedCallType);
        }

        // If we instantiated the "deprecated" class, attach the deprecation
        // message to the instance.
        if (
            errorNode.nodeType === ParseNodeType.Call &&
            returnType &&
            isClassInstance(returnType) &&
            ClassType.isBuiltIn(returnType, 'deprecated')
        ) {
            returnType = ClassType.cloneForDeprecatedInstance(returnType, getDeprecatedMessageFromCall(errorNode));
        }

        // If we instantiated a type, transform it into a class.
        // This can happen if someone directly instantiates a metaclass
        // deriving from type.
        if (
            returnType &&
            isClassInstance(returnType) &&
            returnType.shared.mro.some(
                (baseClass) => isInstantiableClass(baseClass) && ClassType.isBuiltIn(baseClass, 'type')
            )
        ) {
            let newClassName = '__class_' + returnType.shared.name;
            if (argList.length === 3) {
                const firstArgType = getTypeOfArg(argList[0], /* inferenceContext */ undefined).type;

                if (
                    isClassInstance(firstArgType) &&
                    ClassType.isBuiltIn(firstArgType, 'str') &&
                    typeof firstArgType.priv.literalValue === 'string'
                ) {
                    newClassName = firstArgType.priv.literalValue;
                }
            }

            const newClassType = ClassType.createInstantiable(
                newClassName,
                '',
                '',
                AnalyzerNodeInfo.getFileInfo(errorNode).fileUri,
                ClassTypeFlags.None,
                ParseTreeUtils.getTypeSourceId(errorNode),
                ClassType.cloneAsInstantiable(returnType),
                ClassType.cloneAsInstantiable(returnType)
            );
            newClassType.shared.baseClasses.push(getBuiltInType(errorNode, 'object'));
            newClassType.shared.effectiveMetaclass = expandedCallType;
            newClassType.shared.declaration = returnType.shared.declaration;

            computeMroLinearization(newClassType);
            returnType = newClassType;
        }

        return { returnType, overloadsUsedForCall, argumentErrors, isTypeIncomplete };
    }

    function validateCallForClassInstance(
        errorNode: ExpressionNode,
        argList: Arg[],
        expandedCallType: ClassType,
        unexpandedCallType: Type,
        constraints: ConstraintTracker | undefined,
        skipUnknownArgCheck: boolean | undefined,
        inferenceContext: InferenceContext | undefined,
        recursionCount: number
    ): CallResult {
        const callDiag = new DiagnosticAddendum();
        const callMethodResult = getTypeOfBoundMember(
            errorNode,
            expandedCallType,
            '__call__',
            /* usage */ undefined,
            callDiag,
            MemberAccessFlags.SkipInstanceMembers | MemberAccessFlags.SkipAttributeAccessOverride,
            /* selfType */ undefined,
            recursionCount
        );
        const callMethodType = callMethodResult?.type;

        if (!callMethodType || callMethodResult.typeErrors) {
            addDiagnostic(
                DiagnosticRule.reportCallIssue,
                LocMessage.objectNotCallable().format({
                    type: printType(expandedCallType),
                }) + callDiag.getString(),
                errorNode
            );

            return { returnType: UnknownType.create(), argumentErrors: true };
        }

        const callResult = validateCallArgs(
            errorNode,
            argList,
            { type: callMethodType },
            constraints,
            skipUnknownArgCheck,
            inferenceContext,
            recursionCount
        );

        let returnType = callResult.returnType ?? UnknownType.create();
        if (
            isTypeVar(unexpandedCallType) &&
            TypeBase.isInstantiable(unexpandedCallType) &&
            isClass(expandedCallType) &&
            ClassType.isBuiltIn(expandedCallType, 'type')
        ) {
            // Handle the case where a type[T] is being called. We presume this
            // will instantiate an object of type T.
            returnType = convertToInstance(unexpandedCallType);
        }

        return {
            returnType,
            argumentErrors: callResult.argumentErrors,
            overloadsUsedForCall: callResult.overloadsUsedForCall,
        };
    }

    // Evaluates the type of the "cast" call.
    function evaluateCastCall(argList: Arg[], errorNode: ExpressionNode) {
        if (argList[0].argCategory !== ArgCategory.Simple && argList[0].valueExpression) {
            addDiagnostic(
                DiagnosticRule.reportInvalidTypeForm,
                LocMessage.unpackInAnnotation(),
                argList[0].valueExpression
            );
        }

        // Verify that the cast is necessary.
        let castToType = getTypeOfArgExpectingType(argList[0], { typeExpression: true }).type;

        const liveScopeIds = ParseTreeUtils.getTypeVarScopesForNode(errorNode);
        castToType = makeTypeVarsBound(castToType, liveScopeIds);

        let castFromType = getTypeOfArg(argList[1], /* inferenceContext */ undefined).type;

        if (castFromType.props?.specialForm) {
            castFromType = castFromType.props.specialForm;
        }

        if (TypeBase.isInstantiable(castToType) && !isUnknown(castToType)) {
            if (
                isTypeSame(convertToInstance(castToType), castFromType, {
                    ignorePseudoGeneric: true,
                })
            ) {
                addDiagnostic(
                    DiagnosticRule.reportUnnecessaryCast,
                    LocMessage.unnecessaryCast().format({
                        type: printType(castFromType),
                    }),
                    errorNode
                );
            }
        }

        return convertToInstance(castToType);
    }

    // Expands any unpacked tuples within an argument list.
    function expandArgList(argList: Arg[]): Arg[] {
        const expandedArgList: Arg[] = [];

        for (const arg of argList) {
            if (arg.argCategory === ArgCategory.UnpackedList) {
                const argType = getTypeOfArg(arg, /* inferenceContext */ undefined).type;

                // If this is a tuple with specified element types, use those
                // specified types rather than using the more generic iterator
                // type which will be a union of all element types.
                const combinedArgType = combineSameSizedTuples(
                    makeTopLevelTypeVarsConcrete(argType),
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
                                        type: makeTupleObject(evaluatorInterface, [tupleTypeArg]),
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

    // Matches the arguments passed to a function to the corresponding parameters in that
    // function. This matching is done based on positions and keywords. Type evaluation and
    // validation is left to the caller.
    // This logic is based on PEP 3102: https://www.python.org/dev/peps/pep-3102/
    function matchArgsToParams(
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
        argList = expandArgList(argList);

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
                    addDiagnostic(DiagnosticRule.reportCallIssue, LocMessage.argPositional(), nameNode);
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
                        const argType = getTypeOfArg(argList[argIndex], /* inferenceContext */ undefined).type;

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
                        if (!canSkipDiagnosticForNode(errorNode) && !isTypeIncomplete) {
                            addDiagnostic(
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

                const argTypeResult = getTypeOfArg(argList[argIndex], /* inferenceContext */ undefined);

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
                        if (!canSkipDiagnosticForNode(errorNode) && !isTypeIncomplete) {
                            addDiagnostic(
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
                    listElementType = getTypeOfIterator(
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
                            evaluatorInterface,
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
                    if (!canSkipDiagnosticForNode(errorNode) && !isTypeIncomplete) {
                        addDiagnostic(
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
                            if (!canSkipDiagnosticForNode(errorNode) && !isTypeIncomplete) {
                                // Have we run out of arguments and still have parameters left to fill?
                                addDiagnostic(
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
                if (!canSkipDiagnosticForNode(errorNode) && !isTypeIncomplete) {
                    addDiagnostic(
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
                        const tdEntries = getTypedDictMembersForClass(evaluatorInterface, argType);
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

                        const extraItemsType = tdEntries.extraItems?.valueType ?? getObjectType();
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
                            if (!canSkipDiagnosticForNode(errorNode) && !isTypeIncomplete) {
                                addDiagnostic(
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
                        const strObjType = getBuiltInObject(errorNode, 'str');

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
                                assignType(
                                    ClassType.cloneAsInstance(registry.supportsKeysAndGetItemClass),
                                    argType,
                                    /* diag */ undefined,
                                    mappingConstraints
                                )
                            ) {
                                const specializedMapping = solveAndApplyConstraints(
                                    registry.supportsKeysAndGetItemClass,
                                    mappingConstraints
                                ) as ClassType;
                                const typeArgs = specializedMapping.priv.typeArgs;
                                if (typeArgs && typeArgs.length >= 2) {
                                    if (assignType(strObjType, typeArgs[0])) {
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
                                if (!canSkipDiagnosticForNode(errorNode) && !isTypeIncomplete) {
                                    addDiagnostic(
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
                                if (!canSkipDiagnosticForNode(errorNode) && !isTypeIncomplete) {
                                    addDiagnostic(
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
                                if (!canSkipDiagnosticForNode(errorNode) && !isTypeIncomplete) {
                                    addDiagnostic(
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
                            if (!canSkipDiagnosticForNode(errorNode) && !isTypeIncomplete) {
                                addDiagnostic(
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
                            if (!canSkipDiagnosticForNode(errorNode) && !isTypeIncomplete) {
                                addDiagnostic(
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
                            const argTypeResult = getTypeOfArg(argList[argIndex], /* inferenceContext */ undefined);
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
                    if (!canSkipDiagnosticForNode(errorNode)) {
                        const missingParamNames = unassignedParams.map((p) => `"${p}"`).join(', ');
                        if (!canSkipDiagnosticForNode(errorNode) && !isTypeIncomplete) {
                            addDiagnostic(
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
        if (!reportedArgError || !isSpeculativeModeInUse(undefined)) {
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
                        const argType = getTypeOfArg(argParam.argument, /* inferenceContext */ undefined).type;

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
                            if (!canSkipDiagnosticForNode(errorNode) && !isTypeIncomplete) {
                                addDiagnostic(
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
                        specializedTuple = makeTupleObject(evaluatorInterface, tupleTypeArgs, /* isUnpacked */ false);
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

    // After having matched arguments with parameters, this function evaluates the
    // types of each argument expression and validates that the resulting type is
    // compatible with the declared type of the corresponding parameter.
    function validateArgTypesWithContext(
        errorNode: ExpressionNode,
        matchResults: MatchArgsToParamsResult,
        constraints: ConstraintTracker,
        skipUnknownArgCheck = false,
        inferenceContext: InferenceContext | undefined
    ): CallResult {
        const type = matchResults.overload;

        let expectedType: Type | undefined = inferenceContext?.expectedType;

        // Can we safely ignore the inference context, either because it's not provided
        // or will have no effect? If so, avoid the extra work.
        const returnType = inferenceContext?.returnTypeOverride ?? getEffectiveReturnType(type);
        if (!returnType || !requiresSpecialization(returnType)) {
            expectedType = undefined;
        }

        const tryExpectedType = (expectedSubtype: Type): number => {
            const clonedConstraints = constraints.clone();
            const callResult = validateArgTypesWithExpectedType(
                errorNode,
                matchResults,
                clonedConstraints,
                /* skipUnknownArgCheck */ true,
                expectedSubtype,
                returnType
            );

            // Use a heuristic to pick a subtype that is most likely to be correct.
            // We'll look for a subtype that produces no argument errors and has
            // no Unknowns in the return type.
            if (!callResult.argumentErrors && callResult.returnType) {
                const returnType = inferenceContext?.returnTypeOverride
                    ? solveAndApplyConstraints(inferenceContext.returnTypeOverride, clonedConstraints)
                    : callResult.returnType;

                if (
                    assignType(
                        expectedSubtype,
                        returnType,
                        /* diag */ undefined,
                        /* constraints */ undefined,
                        AssignTypeFlags.Default
                    )
                ) {
                    const anyOrUnknown = containsAnyOrUnknown(callResult.returnType, /* recurse */ true);
                    // Prefer return types that have no unknown or Any.
                    if (!anyOrUnknown) {
                        return 3;
                    }

                    // Prefer Any over Unknown.
                    return isAny(anyOrUnknown) ? 2 : 1;
                }
            }

            return 0;
        };

        // Refine the expected type by speculatively evaluating arg types. If the
        // expected type is a union, we may need to perform multiple evaluations
        // to determine whether one of the subtypes works.
        if (expectedType) {
            expectedType = useSpeculativeMode(getSpeculativeNodeForCall(errorNode), () => {
                let validExpectedSubtype: Type | undefined;
                let bestSubtypeScore = -1;

                // If the expected type is a union, we don't know which type is expected.
                // We may or may not be able to make use of the expected type. We'll evaluate
                // speculatively to see if using one of the expected subtypes works.
                if (isUnion(expectedType!)) {
                    doForEachSubtype(
                        expectedType!,
                        (expectedSubtype) => {
                            if (bestSubtypeScore < 3) {
                                const score = tryExpectedType(expectedSubtype);
                                if (score > 0 && score > bestSubtypeScore) {
                                    validExpectedSubtype = expectedSubtype;
                                    bestSubtypeScore = score;
                                }
                            }
                        },
                        /* sortSubtypes */ true
                    );
                }

                if (bestSubtypeScore < 3) {
                    const score = tryExpectedType(expectedType!);
                    if (score > 0 && score > bestSubtypeScore) {
                        validExpectedSubtype = expectedType;
                    }
                }

                return validExpectedSubtype;
            });
        }

        // If there is no expected type, or the expected type is Any or Unknown,
        // there's nothing left to do here.
        if (!expectedType || isAnyOrUnknown(expectedType) || isNever(expectedType)) {
            return validateArgTypes(errorNode, matchResults, constraints, skipUnknownArgCheck);
        }

        return validateArgTypesWithExpectedType(
            errorNode,
            matchResults,
            constraints,
            skipUnknownArgCheck,
            expectedType,
            returnType
        );
    }

    function validateArgTypesWithExpectedType(
        errorNode: ExpressionNode,
        matchResults: MatchArgsToParamsResult,
        constraints: ConstraintTracker,
        skipUnknownArgCheck = false,
        expectedType: Type,
        returnType: Type
    ): CallResult {
        const liveTypeVarScopes = ParseTreeUtils.getTypeVarScopesForNode(errorNode);
        let assignFlags = AssignTypeFlags.PopulateExpectedType;
        if (containsLiteralType(expectedType, /* includeTypeArgs */ true)) {
            assignFlags |= AssignTypeFlags.RetainLiteralsForTypeVar;
        }

        // Prepopulate the constraints based on the specialized expected type.
        // This will allow us to more closely match the expected type if possible.
        if (isClassInstance(returnType) && isClassInstance(expectedType) && !isTypeSame(returnType, expectedType)) {
            const tempConstraints = new ConstraintTracker();
            if (
                addConstraintsForExpectedType(
                    evaluatorInterface,
                    returnType,
                    expectedType,
                    tempConstraints,
                    liveTypeVarScopes,
                    errorNode.start
                )
            ) {
                const genericReturnType = selfSpecializeClass(returnType, {
                    overrideTypeArgs: true,
                });

                expectedType = solveAndApplyConstraints(genericReturnType, tempConstraints, {
                    replaceUnsolved: {
                        scopeIds: getTypeVarScopeIds(returnType),
                        useUnknown: true,
                        tupleClassType: getTupleClassType(),
                    },
                });

                assignFlags |= AssignTypeFlags.SkipPopulateUnknownExpectedType;
            }
        }

        expectedType = transformExpectedType(expectedType, liveTypeVarScopes, errorNode.start);

        assignType(returnType, expectedType, /* diag */ undefined, constraints, assignFlags);

        return validateArgTypes(errorNode, matchResults, constraints, skipUnknownArgCheck);
    }

    function validateArgTypes(
        errorNode: ExpressionNode,
        matchResults: MatchArgsToParamsResult,
        constraints: ConstraintTracker,
        skipUnknownArgCheck: boolean | undefined
    ): CallResult {
        const type = matchResults.overload;
        let isTypeIncomplete = matchResults.isTypeIncomplete;
        let argumentErrors = false;
        let argumentMatchScore = 0;
        let specializedInitSelfType: Type | undefined;
        let anyOrUnknownArg: UnknownType | AnyType | undefined;
        const speculativeNode = getSpeculativeNodeForCall(errorNode);
        const typeCondition = getTypeCondition(type);
        const paramSpec = FunctionType.getParamSpecFromArgsKwargs(type);

        // Check for an attempt to invoke an unimplemented abstract method.
        if (type.priv.boundToType && !type.priv.boundToType.priv.includeSubclasses && type.shared.methodClass) {
            const abstractSymbolInfo = getAbstractSymbolInfo(type.shared.methodClass, type.shared.name);

            if (abstractSymbolInfo && !abstractSymbolInfo.hasImplementation) {
                addDiagnostic(
                    DiagnosticRule.reportAbstractUsage,
                    LocMessage.abstractMethodInvocation().format({
                        method: type.shared.name,
                    }),
                    errorNode.nodeType === ParseNodeType.Call ? errorNode.d.leftExpr : errorNode
                );
            }
        }

        // The type annotation for the "self" parameter in an __init__ method to
        // can influence the type being constructed.
        if (
            type.shared.name === '__init__' &&
            type.priv.strippedFirstParamType &&
            type.priv.boundToType &&
            isClassInstance(type.priv.strippedFirstParamType) &&
            isClassInstance(type.priv.boundToType) &&
            ClassType.isSameGenericClass(type.priv.strippedFirstParamType, type.priv.boundToType) &&
            type.priv.strippedFirstParamType.priv.typeArgs
        ) {
            const typeParams = type.priv.strippedFirstParamType.shared.typeParams;
            specializedInitSelfType = type.priv.strippedFirstParamType;
            type.priv.strippedFirstParamType.priv.typeArgs.forEach((typeArg, index) => {
                if (index < typeParams.length) {
                    const typeParam = typeParams[index];
                    if (!isTypeSame(typeParam, typeArg, { ignorePseudoGeneric: true })) {
                        constraints.setBounds(typeParams[index], typeArg);
                    }
                }
            });
        }

        // Special-case a few built-in calls that are often used for
        // casting or checking for unknown types.
        if (
            FunctionType.isBuiltIn(type, [
                'typing.cast',
                'typing_extensions.cast',
                'builtins.isinstance',
                'builtins.issubclass',
            ])
        ) {
            skipUnknownArgCheck = true;
        }

        // Run through all args and validate them against their matched parameter.
        // We'll do two phases. The first one establishes constraints for type
        // variables. The second perform type validation using the solved
        // types. We can skip the first pass if there are no type vars to solve.
        const typeVarCount = matchResults.argParams.filter((arg) => arg.requiresTypeVarMatching).length;
        if (typeVarCount > 0) {
            // Do up to two passes.
            let passCount = Math.min(typeVarCount, 2);

            for (let i = 0; i < passCount; i++) {
                useSpeculativeMode(speculativeNode, () => {
                    matchResults.argParams.forEach((argParam) => {
                        if (!argParam.requiresTypeVarMatching) {
                            return;
                        }

                        const argResult = validateArgType(
                            argParam,
                            constraints,
                            { type, isIncomplete: matchResults.isTypeIncomplete },
                            {
                                skipUnknownArgCheck,
                                isArgFirstPass: passCount > 1 && i === 0,
                                conditionFilter: typeCondition,
                                skipReportError: true,
                            }
                        );

                        if (argResult.isTypeIncomplete) {
                            isTypeIncomplete = true;
                        }

                        // If we skipped a bare type var during the first pass, add
                        // another pass to ensure that we handle all of the type variables.
                        if (i === 0 && passCount < 2 && argResult.skippedBareTypeVarExpectedType) {
                            passCount++;
                        }
                    });
                });
            }
        }

        let sawParamSpecArgs = false;
        let sawParamSpecKwargs = false;

        let condition: TypeCondition[] = [];
        const argResults: ArgResult[] = [];

        matchResults.argParams.forEach((argParam, argParamIndex) => {
            const argResult = validateArgType(
                argParam,
                constraints,
                { type, isIncomplete: matchResults.isTypeIncomplete },
                {
                    skipUnknownArgCheck,
                    conditionFilter: typeCondition,
                }
            );

            argResults.push(argResult);

            if (!argResult.isCompatible) {
                argumentErrors = true;

                // Add the inverse index so earlier parameters represent larger errors.
                // This will help the heuristics in the overload error paths to pick the
                // most likely intended overload if none of them match.
                argumentMatchScore += 1 + (matchResults.argParams.length - argParamIndex);
            }

            if (argResult.isTypeIncomplete) {
                isTypeIncomplete = true;
            }

            if (argResult.condition) {
                condition = TypeCondition.combine(condition, argResult.condition) ?? [];
            }

            if (isAnyOrUnknown(argResult.argType)) {
                anyOrUnknownArg = anyOrUnknownArg
                    ? preserveUnknown(argResult.argType, anyOrUnknownArg)
                    : argResult.argType;
            }

            if (paramSpec) {
                if (argParam.argument.argCategory === ArgCategory.UnpackedList) {
                    if (isParamSpecArgs(paramSpec, argResult.argType)) {
                        if (sawParamSpecArgs) {
                            addDiagnostic(
                                DiagnosticRule.reportCallIssue,
                                LocMessage.paramSpecArgsKwargsDuplicate().format({ type: printType(paramSpec) }),
                                argParam.errorNode
                            );
                        }

                        sawParamSpecArgs = true;
                    }
                }

                if (argParam.argument.argCategory === ArgCategory.UnpackedDictionary) {
                    if (isParamSpecKwargs(paramSpec, argResult.argType)) {
                        if (sawParamSpecKwargs) {
                            addDiagnostic(
                                DiagnosticRule.reportCallIssue,
                                LocMessage.paramSpecArgsKwargsDuplicate().format({ type: printType(paramSpec) }),
                                argParam.errorNode
                            );
                        }

                        sawParamSpecKwargs = true;
                    }
                }
            }
        });

        let paramSpecConstraints: (ConstraintTracker | undefined)[] = [];

        // Handle the assignment of additional arguments that map to a param spec.
        if (matchResults.paramSpecArgList && matchResults.paramSpecTarget) {
            const paramSpecArgResult = validateArgTypesForParamSpec(
                errorNode,
                matchResults.paramSpecArgList,
                matchResults.paramSpecTarget,
                constraints
            );

            if (paramSpecArgResult.argumentErrors) {
                argumentErrors = true;
                argumentMatchScore += 1;
            }

            paramSpecConstraints = paramSpecArgResult.constraintTrackers;
        } else if (paramSpec) {
            if (!sawParamSpecArgs || !sawParamSpecKwargs) {
                if (!isTypeIncomplete) {
                    addDiagnostic(
                        DiagnosticRule.reportCallIssue,
                        LocMessage.paramSpecArgsMissing().format({ type: printType(paramSpec) }),
                        errorNode
                    );
                }
                argumentErrors = true;
                argumentMatchScore += 1;
            }
        }

        // Calculate the return type.
        const returnTypeResult = getEffectiveReturnTypeResult(type, {
            callSiteInfo: { args: matchResults.argParams, errorNode },
        });
        let returnType = returnTypeResult.type;
        if (returnTypeResult.isIncomplete) {
            isTypeIncomplete = true;
        }

        if (condition.length > 0) {
            returnType = TypeBase.cloneForCondition(returnType, condition);
        }

        let eliminateUnsolvedInUnions = true;

        // If the function is returning a callable, don't eliminate unsolved
        // type vars within a union. There are legit uses for unsolved type vars
        // within a callable.
        if (isFunctionOrOverloaded(returnType)) {
            eliminateUnsolvedInUnions = false;
        }

        let specializedReturnType = solveAndApplyConstraints(returnType, constraints, {
            replaceUnsolved: {
                scopeIds: getTypeVarScopeIds(type),
                unsolvedExemptTypeVars: getUnknownExemptTypeVarsForReturnType(type, returnType),
                tupleClassType: getTupleClassType(),
                eliminateUnsolvedInUnions,
            },
        });
        specializedReturnType = addConditionToType(specializedReturnType, typeCondition, { skipBoundTypeVars: true });

        // If the function includes a ParamSpec and the captured signature(s) includes
        // generic types, we may need to apply those solved TypeVars.
        if (paramSpecConstraints.length > 0) {
            paramSpecConstraints.forEach((paramSpecConstraints) => {
                if (paramSpecConstraints) {
                    specializedReturnType = solveAndApplyConstraints(specializedReturnType, paramSpecConstraints);

                    // It's possible that one or more of the TypeVars or ParamSpecs
                    // in the constraints refer to TypeVars that were solved in
                    // the paramSpecConstraints. Apply these solved TypeVars accordingly.
                    applySourceSolutionToConstraints(
                        constraints,
                        solveConstraints(evaluatorInterface, paramSpecConstraints)
                    );
                }
            });
        }

        // If the final return type is an unpacked tuple, turn it into a normal (unpacked) tuple.
        if (isUnpackedClass(specializedReturnType)) {
            specializedReturnType = ClassType.cloneForPacked(specializedReturnType);
        }

        const liveTypeVarScopes = ParseTreeUtils.getTypeVarScopesForNode(errorNode);
        specializedReturnType = adjustCallableReturnType(errorNode, specializedReturnType, liveTypeVarScopes);

        if (specializedInitSelfType) {
            specializedInitSelfType = solveAndApplyConstraints(specializedInitSelfType, constraints);
        }

        matchResults.argumentMatchScore = argumentMatchScore;

        return {
            argumentErrors,
            argResults,
            anyOrUnknownArg,
            returnType: specializedReturnType,
            isTypeIncomplete,
            activeParam: matchResults.activeParam,
            specializedInitSelfType,
            overloadsUsedForCall: argumentErrors ? [] : [type],
        };
    }

    // In general, all in-scope type variables left in a return type should be
    // replaced with Unknown. However, if the return type is a callable that uses
    // type vars that are found nowhere within the function's input parameters,
    // we'll treat these as though they're scoped to the callable and leave them
    // unsolved.
    function getUnknownExemptTypeVarsForReturnType(functionType: FunctionType, returnType: Type): TypeVarType[] {
        if (isFunction(returnType) && !returnType.shared.name) {
            const returnTypeScopeId = returnType.shared.typeVarScopeId;

            // If one or more type vars found within the return type are scoped to
            // the functionType but don't appear anywhere else within the functionType's
            // input parameters, rescope them to the return type callable so they are
            // not replaced with Unknown.
            if (returnTypeScopeId && functionType.shared.typeVarScopeId) {
                let typeVarsInReturnType = getTypeVarArgsRecursive(returnType);

                // Remove any type variables that appear in the function's input parameters.
                functionType.shared.parameters.forEach((param, index) => {
                    if (FunctionParam.isTypeDeclared(param)) {
                        const typeVarsInInputParam = getTypeVarArgsRecursive(
                            FunctionType.getParamType(functionType, index)
                        );
                        typeVarsInReturnType = typeVarsInReturnType.filter(
                            (returnTypeVar) =>
                                !typeVarsInInputParam.some((inputTypeVar) => isTypeSame(returnTypeVar, inputTypeVar))
                        );
                    }
                });

                return typeVarsInReturnType;
            }
        }

        return [];
    }

    // If the return type includes a generic Callable type, set the type var
    // scope to the scope of the function it was originally associated with
    // to allow these type vars to be solved. This won't work with overloads
    // or unions of callables. It's intended for a specific use case. We may
    // need to make this more sophisticated in the future.
    function adjustCallableReturnType(
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

        inferReturnTypeIfNecessary(returnType);

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

    // Tries to assign the call arguments to the function parameter
    // list and reports any mismatches in types or counts. Returns the
    // specialized return type of the call.
    function validateArgs(
        errorNode: ExpressionNode,
        argList: Arg[],
        typeResult: TypeResult<FunctionType>,
        constraints: ConstraintTracker | undefined,
        skipUnknownArgCheck = false,
        inferenceContext: InferenceContext | undefined
    ): CallResult {
        const matchResults = matchArgsToParams(errorNode, argList, typeResult, 0);

        if (matchResults.argumentErrors) {
            // Evaluate types of all args. This will ensure that referenced symbols are
            // not reported as unaccessed. Also pass the expected parameter type as
            // inference context to enable proper completions even when there are errors.
            matchResults.argParams.forEach((argParam) => {
                if (argParam.argument.valueExpression && !isSpeculativeModeInUse(argParam.argument.valueExpression)) {
                    getTypeOfExpression(
                        argParam.argument.valueExpression,
                        /* flags */ undefined,
                        makeInferenceContext(argParam.paramType)
                    );
                }
            });

            // Also evaluate any arguments that weren't matched to parameters
            argList.forEach((arg) => {
                if (arg.valueExpression && !isSpeculativeModeInUse(arg.valueExpression)) {
                    // Check if this argument was already evaluated above
                    const wasEvaluated = matchResults.argParams.some((argParam) => argParam.argument === arg);
                    if (!wasEvaluated) {
                        getTypeOfExpression(arg.valueExpression);
                    }
                }
            });
            // Use a return type of Unknown but attach a "possible type" to it
            // so the completion provider can suggest better completions.
            const possibleType = FunctionType.getEffectiveReturnType(typeResult.type);
            return {
                returnType:
                    possibleType && !isAnyOrUnknown(possibleType)
                        ? UnknownType.createPossibleType(possibleType, /* isIncomplete */ false)
                        : undefined,
                argumentErrors: true,
                activeParam: matchResults.activeParam,
                overloadsUsedForCall: [],
            };
        }

        return validateArgTypesWithContext(
            errorNode,
            matchResults,
            constraints ?? new ConstraintTracker(),
            skipUnknownArgCheck,
            makeInferenceContext(
                inferenceContext?.expectedType,
                inferenceContext?.isTypeIncomplete,
                inferenceContext?.returnTypeOverride
            )
        );
    }

    // Determines whether the specified argument list satisfies the function
    // signature bound to the specified ParamSpec. Return value indicates success.
    function validateArgTypesForParamSpec(
        errorNode: ExpressionNode,
        argList: Arg[],
        paramSpec: ParamSpecType,
        destConstraints: ConstraintTracker
    ): ParamSpecArgResult {
        const sets = destConstraints.getConstraintSets();

        // Handle the common case where there is only one signature context.
        if (sets.length === 1) {
            return validateArgTypesForParamSpecSignature(errorNode, argList, paramSpec, sets[0]);
        }

        const filteredSets: ConstraintSet[] = [];
        const constraintTrackers: (ConstraintTracker | undefined)[] = [];
        const speculativeNode = getSpeculativeNodeForCall(errorNode);

        sets.forEach((context) => {
            // Use speculative mode to avoid emitting errors or caching types.
            useSpeculativeMode(speculativeNode, () => {
                const paramSpecArgResult = validateArgTypesForParamSpecSignature(
                    errorNode,
                    argList,
                    paramSpec,
                    context
                );

                if (!paramSpecArgResult.argumentErrors) {
                    filteredSets.push(context);
                }

                appendArray(constraintTrackers, paramSpecArgResult.constraintTrackers);
            });
        });

        // Copy back any compatible signature contexts if any were compatible.
        if (filteredSets.length > 0) {
            destConstraints.addConstraintSets(filteredSets);
        }

        // Evaluate non-speculatively to produce a final result and cache types.
        const paramSpecArgResult = validateArgTypesForParamSpecSignature(
            errorNode,
            argList,
            paramSpec,
            filteredSets.length > 0 ? filteredSets[0] : sets[0]
        );

        return { argumentErrors: paramSpecArgResult.argumentErrors, constraintTrackers: constraintTrackers };
    }

    function validateArgTypesForParamSpecSignature(
        errorNode: ExpressionNode,
        argList: Arg[],
        paramSpec: ParamSpecType,
        constraintSet: ConstraintSet
    ): ParamSpecArgResult {
        const solutionSet = solveConstraintSet(evaluatorInterface, constraintSet);
        let paramSpecType = solutionSet.getType(paramSpec);
        paramSpecType = convertTypeToParamSpecValue(paramSpecType ?? paramSpec);

        const matchResults = matchArgsToParams(errorNode, argList, { type: paramSpecType }, 0);
        const functionType = matchResults.overload;
        const constraints = new ConstraintTracker();

        if (matchResults.argumentErrors) {
            // Evaluate types of all args. This will ensure that referenced symbols are
            // not reported as unaccessed.
            argList.forEach((arg) => {
                if (arg.valueExpression && !isSpeculativeModeInUse(arg.valueExpression)) {
                    getTypeOfExpression(arg.valueExpression);
                }
            });

            return { argumentErrors: true, constraintTrackers: [constraints] };
        }

        const functionParamSpec = FunctionType.getParamSpecFromArgsKwargs(functionType);
        const functionWithoutParamSpec = FunctionType.cloneRemoveParamSpecArgsKwargs(functionType);

        // Handle the recursive case where we're passing (*args: P.args, **kwargs: P.args)
        // a remaining function of type (*P).
        if (
            functionParamSpec &&
            functionWithoutParamSpec.shared.parameters.length === 0 &&
            isTypeSame(functionParamSpec, paramSpec)
        ) {
            // If there are any arguments other than *args: P.args or **kwargs: P.kwargs,
            // report an error.
            let argsCount = 0;
            let kwargsCount = 0;
            let argumentErrors = false;
            let argErrorNode: ExpressionNode | undefined;

            for (const arg of argList) {
                const argType = getTypeOfArg(arg, /* inferenceContext */ undefined)?.type;

                if (arg.argCategory === ArgCategory.UnpackedList) {
                    if (isParamSpecArgs(paramSpec, argType)) {
                        argsCount++;
                    }
                } else if (arg.argCategory === ArgCategory.UnpackedDictionary) {
                    if (isParamSpecKwargs(paramSpec, argType)) {
                        kwargsCount++;
                    }
                } else {
                    argErrorNode = argErrorNode ?? arg.valueExpression;
                    argumentErrors = true;
                }
            }

            if (argsCount !== 1 || kwargsCount !== 1) {
                argumentErrors = true;
            }

            if (argumentErrors) {
                addDiagnostic(
                    DiagnosticRule.reportCallIssue,
                    LocMessage.paramSpecArgsMissing().format({
                        type: printType(functionParamSpec),
                    }),
                    argErrorNode ?? errorNode
                );
            }

            return { argumentErrors, constraintTrackers: [constraints] };
        }

        const result = validateArgTypes(errorNode, matchResults, constraints, /* skipUnknownArgCheck */ undefined);
        return { argumentErrors: !!result.argumentErrors, constraintTrackers: [constraints] };
    }

    function validateArgType(
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

            // Is the expected type a "bare" in-scope TypeVar or a union of bare in-scope TypeVars?
            let isExpectedTypeBareTypeVar = true;
            doForEachSubtype(argParam.paramType, (subtype) => {
                if (!isTypeVar(subtype) || subtype.priv.scopeId !== typeResult?.type.shared.typeVarScopeId) {
                    isExpectedTypeBareTypeVar = false;
                }
            });

            if (!options.isArgFirstPass || !isExpectedTypeBareTypeVar) {
                expectedType = argParam.paramType;

                // If the parameter type is a function with a ParamSpec, don't apply
                // the solved TypeVars if the constraint tracker has more than one signature.
                // This will expand the ParamSpec into an overload, which will cause problems.
                const skipApplySolvedTypeVars =
                    isFunction(argParam.paramType) &&
                    FunctionType.getParamSpecFromArgsKwargs(argParam.paramType) &&
                    constraints.getConstraintSets().length > 1;

                if (!skipApplySolvedTypeVars) {
                    expectedType = solveAndApplyConstraints(expectedType, constraints, /* applyOptions */ undefined, {
                        useLowerBoundOnly: !!options.isArgFirstPass,
                    });
                }
            } else {
                skippedBareTypeVarExpectedType = true;
            }

            // If the expected type is unknown, don't use an expected type. Instead,
            // use default rules for evaluating the expression type.
            if (expectedType && isUnknown(expectedType)) {
                expectedType = undefined;
            }

            // Was the argument's type precomputed by the caller?
            if (argParam.argType) {
                argType = argParam.argType;
            } else {
                const flags = argParam.isinstanceParam
                    ? EvalFlags.IsInstanceArgDefaults
                    : EvalFlags.NoFinal | EvalFlags.NoSpecialize;
                const exprTypeResult = getTypeOfExpression(
                    argParam.argument.valueExpression,
                    flags,
                    makeInferenceContext(expectedType, !!typeResult?.isIncomplete)
                );

                argType = exprTypeResult.type;

                // If the argument is unpacked and we are supposed to enforce
                // that it's an iterator, do so now.
                if (argParam.argument.argCategory === ArgCategory.UnpackedList && argParam.argument.enforceIterable) {
                    const iteratorType = getTypeOfIterator(
                        exprTypeResult,
                        /* isAsync */ false,
                        argParam.argument.valueExpression
                    );
                    // Try to prevent cascading errors if it was not iterable.
                    argType = iteratorType?.type ?? UnknownType.create();
                }

                if (exprTypeResult.isIncomplete) {
                    isTypeIncomplete = true;
                }

                if (expectedType && requiresSpecialization(expectedType)) {
                    // Assign the argument type back to the expected type to assign
                    // values to any unification variables.
                    const clonedConstraints = constraints.clone();
                    if (
                        assignType(
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

            if (argParam.argument && argParam.argument.name && !isSpeculativeModeInUse(argParam.errorNode)) {
                writeTypeCache(
                    argParam.argument.name,
                    { type: expectedType ?? argType, isIncomplete: isTypeIncomplete },
                    EvalFlags.None
                );
            }
        } else {
            // Was the argument's type precomputed by the caller?
            if (argParam.argType) {
                argType = argParam.argType;
            } else {
                const argTypeResult = getTypeOfArg(
                    argParam.argument,
                    makeInferenceContext(argParam.paramType, isTypeIncomplete)
                );
                argType = argTypeResult.type;
                if (argTypeResult.isIncomplete) {
                    isTypeIncomplete = true;
                }
            }

            // If the argument came from a parameter's default argument value,
            // we may need to specialize the type.
            if (argParam.isDefaultArg) {
                argType = solveAndApplyConstraints(argType, constraints);
            }
        }

        // If we're assigning to a var arg dictionary with a TypeVar type,
        // strip literals before performing the assignment. This is used in
        // places like a dict constructor.
        if (argParam.paramCategory === ParamCategory.KwargsDict && isTypeVar(argParam.paramType)) {
            argType = stripLiteralValue(argType);
        }

        // If there's a constraint filter, apply it to top-level type variables
        // if appropriate. This doesn't properly handle non-top-level constrained
        // type variables.
        if (options.conditionFilter) {
            argType = mapSubtypesExpandTypeVars(
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
            // Handle the case where we're assigning a *args or **kwargs argument
            // to a *P.args or **P.kwargs parameter.
            if (argParam.paramType.priv.paramSpecAccess !== undefined) {
                return { isCompatible, argType, isTypeIncomplete, condition };
            }

            // Handle the case where we're assigning a *P.args or **P.kwargs argument
            // to a *P.args or **P.kwargs parameter.
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

        if (!assignType(argParam.paramType, argType, diag?.createAddendum(), constraints, assignTypeFlags)) {
            if (!options?.skipReportError) {
                // Mismatching parameter types are common in untyped code; don't bother spending time
                // printing types if the diagnostic is disabled.
                const fileInfo = AnalyzerNodeInfo.getFileInfo(argParam.errorNode);
                if (
                    fileInfo.diagnosticRuleSet.reportArgumentType !== 'none' &&
                    !canSkipDiagnosticForNode(argParam.errorNode) &&
                    !isTypeIncomplete
                ) {
                    const argTypeText = printType(argType);
                    const paramTypeText = printType(argParam.paramType);

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

                    // If we have an expected type diagnostic addendum, use that
                    // instead of the local diagnostic addendum because it will
                    // be more informative.
                    if (expectedTypeDiag) {
                        diag = expectedTypeDiag;
                    }

                    addDiagnostic(
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
            const simplifiedType = makeTopLevelTypeVarsConcrete(removeUnbound(argType));
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

            // Do not check for unknown types if the expected type is "Any".
            // Don't print types if reportUnknownArgumentType is disabled for performance.
            if (
                fileInfo.diagnosticRuleSet.reportUnknownArgumentType !== 'none' &&
                !isAny(argParam.paramType) &&
                !isTypeIncomplete
            ) {
                if (isUnknown(simplifiedType)) {
                    const diagAddendum = getDiagAddendum();
                    addDiagnostic(
                        DiagnosticRule.reportUnknownArgumentType,
                        LocMessage.argTypeUnknown() + diagAddendum.getString(),
                        argParam.errorNode
                    );
                } else if (isPartlyUnknown(simplifiedType)) {
                    // If the parameter type is also partially unknown, don't report
                    // the error because it's likely that the partially-unknown type
                    // arose due to bidirectional type matching.
                    if (!isPartlyUnknown(argParam.paramType)) {
                        const diagAddendum = getDiagAddendum();
                        diagAddendum.addMessage(
                            LocAddendum.argumentType().format({
                                type: printType(simplifiedType, { expandTypeAlias: true }),
                            })
                        );
                        addDiagnostic(
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

    function getTypeOfConstant(node: ConstantNode, flags: EvalFlags): TypeResult {
        let type: Type | undefined;

        if (node.d.constType === KeywordType.None) {
            if (registry.noneTypeClass) {
                type =
                    (flags & EvalFlags.InstantiableType) !== 0
                        ? registry.noneTypeClass
                        : convertToInstance(registry.noneTypeClass);

                if (isTypeFormSupported(node)) {
                    type = TypeBase.cloneWithTypeForm(type, convertToInstance(type));
                }
            }
        } else if (
            node.d.constType === KeywordType.True ||
            node.d.constType === KeywordType.False ||
            node.d.constType === KeywordType.Debug
        ) {
            type = getBuiltInObject(node, 'bool');

            // For True and False, we can create truthy and falsy
            // versions of 'bool'.
            if (type && isClassInstance(type)) {
                if (node.d.constType === KeywordType.True) {
                    type = ClassType.cloneWithLiteral(type, /* value */ true);
                } else if (node.d.constType === KeywordType.False) {
                    type = ClassType.cloneWithLiteral(type, /* value */ false);
                }
            }
        }

        return { type: type ?? UnknownType.create() };
    }

    function getTypeOfMagicMethodCall(
        objType: Type,
        methodName: string,
        argList: TypeResult[],
        errorNode: ExpressionNode,
        inferenceContext?: InferenceContext,
        diag?: DiagnosticAddendum
    ): TypeResult | undefined {
        return memberAccessModule.getTypeOfMagicMethodCall(
            evaluatorInterface,
            registry,
            objType,
            methodName,
            argList,
            errorNode,
            inferenceContext,
            diag
        );
    }

    function getTypeOfDictionary(
        node: DictionaryNode,
        flags: EvalFlags,
        inferenceContext: InferenceContext | undefined
    ): TypeResult {
        if ((flags & EvalFlags.TypeExpression) !== 0 && node.parent?.nodeType !== ParseNodeType.Argument) {
            const diag = new DiagnosticAddendum();
            diag.addMessage(LocAddendum.useDictInstead());
            addDiagnostic(DiagnosticRule.reportInvalidTypeForm, LocMessage.dictInAnnotation() + diag.getString(), node);
        }

        // If the expected type is a union, analyze for each of the subtypes
        // to find one that matches.
        let expectedType = inferenceContext?.expectedType;

        if (inferenceContext && isUnion(inferenceContext.expectedType)) {
            let matchingSubtype: Type | undefined;
            let matchingSubtypeResult: TypeResult | undefined;

            doForEachSubtype(
                inferenceContext.expectedType,
                (subtype) => {
                    // Use shortcut if we've already found a match.
                    if (matchingSubtypeResult && !matchingSubtypeResult.typeErrors) {
                        return;
                    }

                    const subtypeResult = useSpeculativeMode(node, () => {
                        return getTypeOfDictionaryWithContext(node, flags, makeInferenceContext(subtype));
                    });

                    if (subtypeResult && assignType(subtype, subtypeResult.type)) {
                        // If this is the first result we're seeing or it's the first result
                        // without errors, select it as the match.
                        if (!matchingSubtypeResult || (matchingSubtypeResult.typeErrors && !subtypeResult.typeErrors)) {
                            matchingSubtype = subtype;
                            matchingSubtypeResult = subtypeResult;
                        }
                    }
                },
                /* sortSubtypes */ true
            );

            expectedType = matchingSubtype;
        }

        let expectedTypeDiagAddendum = undefined;
        if (expectedType) {
            expectedTypeDiagAddendum = new DiagnosticAddendum();
            const result = getTypeOfDictionaryWithContext(
                node,
                flags,
                makeInferenceContext(expectedType),
                expectedTypeDiagAddendum
            );
            if (result) {
                return result;
            }
        }

        const result = getTypeOfDictionaryInferred(node, flags, /* hasExpectedType */ !!inferenceContext?.expectedType);
        return { ...result, expectedTypeDiagAddendum };
    }

    function getTypeOfDictionaryWithContext(
        node: DictionaryNode,
        flags: EvalFlags,
        inferenceContext: InferenceContext,
        expectedDiagAddendum?: DiagnosticAddendum
    ): TypeResult | undefined {
        inferenceContext.expectedType = transformPossibleRecursiveTypeAlias(inferenceContext.expectedType);
        let concreteExpectedType = makeTopLevelTypeVarsConcrete(inferenceContext.expectedType);

        if (!isClassInstance(concreteExpectedType)) {
            return undefined;
        }

        const keyTypes: TypeResultWithNode[] = [];
        const valueTypes: TypeResultWithNode[] = [];
        let isIncomplete = false;
        let typeErrors = false;

        // Handle TypedDict's as a special case.
        if (ClassType.isTypedDictClass(concreteExpectedType)) {
            // Remove any conditions associated with the type so the resulting type isn't
            // considered compatible with a bound TypeVar.
            concreteExpectedType = TypeBase.cloneForCondition(concreteExpectedType, undefined);

            const expectedTypedDictEntries = getTypedDictMembersForClass(evaluatorInterface, concreteExpectedType);

            // Infer the key and value types if possible.
            const keyValueTypeResult = getKeyAndValueTypesFromDictionary(
                node,
                flags,
                keyTypes,
                valueTypes,
                /* forceStrictInference */ true,
                /* isValueTypeInvariant */ true,
                /* expectedKeyType */ undefined,
                /* expectedValueType */ undefined,
                expectedTypedDictEntries,
                expectedDiagAddendum
            );

            if (keyValueTypeResult.isIncomplete) {
                isIncomplete = true;
            }

            if (keyValueTypeResult.typeErrors) {
                typeErrors = true;
            }

            const resultTypedDict = assignToTypedDict(
                evaluatorInterface,
                concreteExpectedType,
                keyTypes,
                valueTypes,
                // Don't overwrite existing expectedDiagAddendum messages if they were
                // already provided by getKeyValueTypesFromDictionary.
                expectedDiagAddendum?.isEmpty() ? expectedDiagAddendum : undefined
            );
            if (resultTypedDict) {
                return {
                    type: resultTypedDict,
                    isIncomplete,
                };
            }

            return undefined;
        }

        let expectedKeyType: Type;
        let expectedValueType: Type;

        if (isAnyOrUnknown(inferenceContext.expectedType)) {
            expectedKeyType = inferenceContext.expectedType;
            expectedValueType = inferenceContext.expectedType;
        } else {
            const builtInDict = getBuiltInObject(node, 'dict');
            if (!isClassInstance(builtInDict)) {
                return undefined;
            }

            const dictConstraints = new ConstraintTracker();
            if (
                !addConstraintsForExpectedType(
                    evaluatorInterface,
                    builtInDict,
                    inferenceContext.expectedType,
                    dictConstraints,
                    ParseTreeUtils.getTypeVarScopesForNode(node),
                    node.start
                )
            ) {
                return undefined;
            }

            const specializedDict = solveAndApplyConstraints(
                ClassType.cloneAsInstantiable(builtInDict),
                dictConstraints
            ) as ClassType;
            if (!specializedDict.priv.typeArgs || specializedDict.priv.typeArgs.length !== 2) {
                return undefined;
            }

            expectedKeyType = specializedDict.priv.typeArgs[0];
            expectedValueType = specializedDict.priv.typeArgs[1];
        }

        // Dict and MutableMapping types have invariant value types, so they
        // cannot be narrowed further. Other super-types like Mapping, Collection,
        // and Iterable use covariant value types, so they can be narrowed.
        let isValueTypeInvariant = false;
        if (isClassInstance(inferenceContext.expectedType)) {
            if (inferenceContext.expectedType.shared.typeParams.length >= 2) {
                const valueTypeParam = inferenceContext.expectedType.shared.typeParams[1];
                if (TypeVarType.getVariance(valueTypeParam) === Variance.Invariant) {
                    isValueTypeInvariant = true;
                }
            }
        }

        // Infer the key and value types if possible.
        const keyValueResult = getKeyAndValueTypesFromDictionary(
            node,
            flags,
            keyTypes,
            valueTypes,
            /* forceStrictInference */ true,
            isValueTypeInvariant,
            expectedKeyType,
            expectedValueType,
            undefined,
            expectedDiagAddendum
        );

        if (keyValueResult.isIncomplete) {
            isIncomplete = true;
        }

        if (keyValueResult.typeErrors) {
            typeErrors = true;
        }

        const specializedKeyType = inferTypeArgFromExpectedEntryType(
            makeInferenceContext(expectedKeyType),
            keyTypes.map((result) => result.type),
            /* isNarrowable */ false
        );
        const specializedValueType = inferTypeArgFromExpectedEntryType(
            makeInferenceContext(expectedValueType),
            valueTypes.map((result) => result.type),
            !isValueTypeInvariant
        );
        if (!specializedKeyType || !specializedValueType) {
            return undefined;
        }

        const type = getBuiltInObject(node, 'dict', [specializedKeyType, specializedValueType]);
        return { type, isIncomplete, typeErrors };
    }

    // Attempts to infer the type of a dictionary statement. If hasExpectedType
    // is true, strict inference is used for the subexpressions.
    function getTypeOfDictionaryInferred(node: DictionaryNode, flags: EvalFlags, hasExpectedType: boolean): TypeResult {
        const fallbackType = hasExpectedType ? AnyType.create() : UnknownType.create();
        let keyType: Type = fallbackType;
        let valueType: Type = fallbackType;

        const keyTypeResults: TypeResultWithNode[] = [];
        const valueTypeResults: TypeResultWithNode[] = [];

        let isEmptyContainer = false;
        let isIncomplete = false;
        let typeErrors = false;

        // Infer the key and value types if possible.
        const keyValueResult = getKeyAndValueTypesFromDictionary(
            node,
            flags,
            keyTypeResults,
            valueTypeResults,
            /* forceStrictInference */ hasExpectedType,
            /* isValueTypeInvariant */ false
        );

        if (keyValueResult.isIncomplete) {
            isIncomplete = true;
        }

        if (keyValueResult.typeErrors) {
            typeErrors = true;
        }

        // Strip any literal values and TypeForm types.
        const keyTypes = keyTypeResults.map((t) =>
            stripTypeForm(convertSpecialFormToRuntimeValue(stripLiteralValue(t.type), flags, !hasExpectedType))
        );
        const valueTypes = valueTypeResults.map((t) =>
            stripTypeForm(convertSpecialFormToRuntimeValue(stripLiteralValue(t.type), flags, !hasExpectedType))
        );

        if (keyTypes.length > 0) {
            if (AnalyzerNodeInfo.getFileInfo(node).diagnosticRuleSet.strictDictionaryInference || hasExpectedType) {
                keyType = combineTypes(keyTypes);
            } else {
                keyType = areTypesSame(keyTypes, { ignorePseudoGeneric: true }) ? keyTypes[0] : fallbackType;
            }
        } else {
            keyType = fallbackType;
        }

        // If the value type differs and we're not using "strict inference mode",
        // we need to back off because we can't properly represent the mappings
        // between different keys and associated value types. If all the values
        // are the same type, we'll assume that all values in this dictionary should
        // be the same.
        if (valueTypes.length > 0) {
            if (AnalyzerNodeInfo.getFileInfo(node).diagnosticRuleSet.strictDictionaryInference || hasExpectedType) {
                valueType = combineTypes(valueTypes);
            } else {
                valueType = areTypesSame(valueTypes, { ignorePseudoGeneric: true }) ? valueTypes[0] : fallbackType;
            }
        } else {
            valueType = fallbackType;
            isEmptyContainer = true;
        }

        const dictClass = getBuiltInType(node, 'dict');
        const type = isInstantiableClass(dictClass)
            ? ClassType.cloneAsInstance(
                  ClassType.specialize(
                      dictClass,
                      [keyType, valueType],
                      /* isTypeArgExplicit */ true,
                      /* includeSubclasses */ undefined,
                      /* tupleTypeArgs */ undefined,
                      isEmptyContainer
                  )
              )
            : UnknownType.create();

        if (isIncomplete) {
            if (getContainerDepth(type) > maxInferredContainerDepth) {
                return { type: UnknownType.create() };
            }
        }

        return { type, isIncomplete, typeErrors };
    }

    function getKeyAndValueTypesFromDictionary(
        node: DictionaryNode,
        flags: EvalFlags,
        keyTypes: TypeResultWithNode[],
        valueTypes: TypeResultWithNode[],
        forceStrictInference: boolean,
        isValueTypeInvariant: boolean,
        expectedKeyType?: Type,
        expectedValueType?: Type,
        expectedTypedDictEntries?: TypedDictEntries,
        expectedDiagAddendum?: DiagnosticAddendum
    ): TypeResult {
        let isIncomplete = false;
        let typeErrors = false;

        // Mask out some of the flags that are not applicable for a dictionary key
        // even if it appears within an inlined TypedDict annotation.
        const keyFlags = flags & ~(EvalFlags.TypeExpression | EvalFlags.StrLiteralAsType | EvalFlags.InstantiableType);

        // Infer the key and value types if possible.
        node.d.items.forEach((entryNode, index) => {
            let addUnknown = true;

            if (entryNode.nodeType === ParseNodeType.DictionaryKeyEntry) {
                const keyTypeResult = getTypeOfExpression(
                    entryNode.d.keyExpr,
                    keyFlags | EvalFlags.StripTupleLiterals,
                    makeInferenceContext(
                        expectedKeyType ?? (forceStrictInference ? NeverType.createNever() : undefined)
                    )
                );

                if (keyTypeResult.isIncomplete) {
                    isIncomplete = true;
                }

                if (keyTypeResult.typeErrors) {
                    typeErrors = true;
                }

                const keyType = keyTypeResult.type;

                if (!keyTypeResult.isIncomplete && !keyTypeResult.typeErrors) {
                    verifySetEntryOrDictKeyIsHashable(entryNode.d.keyExpr, keyType, /* isDictKey */ true);
                }

                if (expectedDiagAddendum && keyTypeResult.expectedTypeDiagAddendum) {
                    expectedDiagAddendum.addAddendum(keyTypeResult.expectedTypeDiagAddendum);
                }

                let valueTypeResult: TypeResult;
                let entryInferenceContext: InferenceContext | undefined;

                if (
                    expectedTypedDictEntries &&
                    isClassInstance(keyType) &&
                    ClassType.isBuiltIn(keyType, 'str') &&
                    isLiteralType(keyType) &&
                    (expectedTypedDictEntries.knownItems.has(keyType.priv.literalValue as string) ||
                        expectedTypedDictEntries.extraItems)
                ) {
                    let effectiveValueType =
                        expectedTypedDictEntries.knownItems.get(keyType.priv.literalValue as string)?.valueType ??
                        expectedTypedDictEntries.extraItems?.valueType;
                    if (effectiveValueType) {
                        const liveTypeVarScopes = ParseTreeUtils.getTypeVarScopesForNode(node);
                        effectiveValueType = transformExpectedType(effectiveValueType, liveTypeVarScopes, node.start);
                    }
                    entryInferenceContext = makeInferenceContext(effectiveValueType);
                    valueTypeResult = getTypeOfExpression(
                        entryNode.d.valueExpr,
                        flags | EvalFlags.StripTupleLiterals,
                        entryInferenceContext
                    );
                } else {
                    let effectiveValueType =
                        expectedValueType ?? (forceStrictInference ? NeverType.createNever() : undefined);
                    if (effectiveValueType) {
                        const liveTypeVarScopes = ParseTreeUtils.getTypeVarScopesForNode(node);
                        effectiveValueType = transformExpectedType(effectiveValueType, liveTypeVarScopes, node.start);
                    }
                    entryInferenceContext = makeInferenceContext(effectiveValueType);
                    valueTypeResult = getTypeOfExpression(
                        entryNode.d.valueExpr,
                        flags | EvalFlags.StripTupleLiterals,
                        entryInferenceContext
                    );
                }

                if (entryInferenceContext && !valueTypeResult.typeErrors) {
                    const fromExpectedType = inferTypeArgFromExpectedEntryType(
                        entryInferenceContext,
                        [valueTypeResult.type],
                        !isValueTypeInvariant
                    );

                    if (fromExpectedType) {
                        valueTypeResult = { ...valueTypeResult, type: fromExpectedType };
                    }
                }

                if (expectedDiagAddendum && valueTypeResult.expectedTypeDiagAddendum) {
                    expectedDiagAddendum.addAddendum(valueTypeResult.expectedTypeDiagAddendum);
                }

                const valueType = valueTypeResult.type;
                if (valueTypeResult.isIncomplete) {
                    isIncomplete = true;
                }

                if (valueTypeResult.typeErrors) {
                    typeErrors = true;
                }

                if (forceStrictInference || index < maxEntriesToUseForInference) {
                    // If an existing key has the same literal type, delete the previous
                    // key since we're overwriting it here.
                    if (isClass(keyType) && isLiteralType(keyType)) {
                        const existingIndex = keyTypes.findIndex((kt) => isTypeSame(keyType, kt.type));
                        if (existingIndex >= 0) {
                            keyTypes.splice(existingIndex, 1);
                            valueTypes.splice(existingIndex, 1);
                        }
                    }

                    keyTypes.push({ node: entryNode.d.keyExpr, type: keyType });
                    valueTypes.push({ node: entryNode.d.valueExpr, type: valueType });
                }

                addUnknown = false;
            } else if (entryNode.nodeType === ParseNodeType.DictionaryExpandEntry) {
                let expectedType: Type | undefined;
                if (expectedKeyType && expectedValueType) {
                    if (
                        registry.supportsKeysAndGetItemClass &&
                        isInstantiableClass(registry.supportsKeysAndGetItemClass)
                    ) {
                        expectedType = ClassType.cloneAsInstance(
                            ClassType.specialize(registry.supportsKeysAndGetItemClass, [
                                expectedKeyType,
                                expectedValueType,
                            ])
                        );
                    }
                }

                const entryInferenceContext = makeInferenceContext(expectedType);
                let unexpandedTypeResult = getTypeOfExpression(
                    entryNode.d.expr,
                    flags | EvalFlags.StripTupleLiterals,
                    entryInferenceContext
                );

                if (entryInferenceContext && !unexpandedTypeResult.typeErrors) {
                    const fromExpectedType = inferTypeArgFromExpectedEntryType(
                        entryInferenceContext,
                        [unexpandedTypeResult.type],
                        !isValueTypeInvariant
                    );

                    if (fromExpectedType) {
                        unexpandedTypeResult = { ...unexpandedTypeResult, type: fromExpectedType };
                    }
                }

                if (unexpandedTypeResult.isIncomplete) {
                    isIncomplete = true;
                }

                if (unexpandedTypeResult.typeErrors) {
                    typeErrors = true;
                }

                const unexpandedType = unexpandedTypeResult.type;

                if (isAnyOrUnknown(unexpandedType)) {
                    if (forceStrictInference || index < maxEntriesToUseForInference) {
                        keyTypes.push({ node: entryNode, type: unexpandedType });
                        valueTypes.push({ node: entryNode, type: unexpandedType });
                    }
                    addUnknown = false;
                } else if (isClassInstance(unexpandedType) && ClassType.isTypedDictClass(unexpandedType)) {
                    // Handle dictionary expansion for a TypedDict.
                    if (registry.strClass && isInstantiableClass(registry.strClass)) {
                        const strObject = ClassType.cloneAsInstance(registry.strClass);
                        const tdEntries = getTypedDictMembersForClass(
                            evaluatorInterface,
                            unexpandedType,
                            /* allowNarrowed */ true
                        );

                        tdEntries.knownItems.forEach((entry, name) => {
                            if (entry.isRequired || entry.isProvided) {
                                keyTypes.push({
                                    node: entryNode,
                                    type: ClassType.cloneWithLiteral(strObject, name),
                                });
                                valueTypes.push({ node: entryNode, type: entry.valueType });
                            }
                        });

                        if (!expectedTypedDictEntries) {
                            keyTypes.push({ node: entryNode, type: ClassType.cloneAsInstance(strObject) });
                            valueTypes.push({
                                node: entryNode,
                                type: tdEntries.extraItems?.valueType ?? getObjectType(),
                            });
                        }

                        addUnknown = false;
                    }
                } else if (
                    registry.supportsKeysAndGetItemClass &&
                    isInstantiableClass(registry.supportsKeysAndGetItemClass)
                ) {
                    const mappingConstraints = new ConstraintTracker();

                    const supportsKeysAndGetItemClass = selfSpecializeClass(registry.supportsKeysAndGetItemClass);

                    if (
                        assignType(
                            ClassType.cloneAsInstance(supportsKeysAndGetItemClass),
                            unexpandedType,
                            /* diag */ undefined,
                            mappingConstraints,
                            AssignTypeFlags.RetainLiteralsForTypeVar
                        )
                    ) {
                        const specializedMapping = solveAndApplyConstraints(
                            supportsKeysAndGetItemClass,
                            mappingConstraints
                        ) as ClassType;
                        const typeArgs = specializedMapping.priv.typeArgs;
                        if (typeArgs && typeArgs.length >= 2) {
                            if (forceStrictInference || index < maxEntriesToUseForInference) {
                                keyTypes.push({ node: entryNode, type: typeArgs[0] });
                                valueTypes.push({ node: entryNode, type: typeArgs[1] });
                            }
                            addUnknown = false;
                        }
                    } else {
                        addDiagnostic(
                            DiagnosticRule.reportGeneralTypeIssues,
                            LocMessage.dictUnpackIsNotMapping(),
                            entryNode
                        );
                    }
                }
            } else if (entryNode.nodeType === ParseNodeType.Comprehension) {
                const dictEntryTypeResult = getElementTypeFromComprehension(
                    entryNode,
                    flags | EvalFlags.StripTupleLiterals,
                    expectedValueType,
                    expectedKeyType
                );
                const dictEntryType = dictEntryTypeResult.type;
                if (dictEntryTypeResult.isIncomplete) {
                    isIncomplete = true;
                }

                if (dictEntryTypeResult.typeErrors) {
                    typeErrors = true;
                }

                // The result should be a tuple.
                if (isClassInstance(dictEntryType) && isTupleClass(dictEntryType)) {
                    const typeArgs = dictEntryType.priv.tupleTypeArgs?.map((t) => t.type);
                    if (typeArgs && typeArgs.length === 2) {
                        if (forceStrictInference || index < maxEntriesToUseForInference) {
                            keyTypes.push({ node: entryNode, type: typeArgs[0] });
                            valueTypes.push({ node: entryNode, type: typeArgs[1] });
                        }
                        addUnknown = false;
                    }
                }
            }

            if (addUnknown) {
                if (forceStrictInference || index < maxEntriesToUseForInference) {
                    keyTypes.push({ node: entryNode, type: UnknownType.create() });
                    valueTypes.push({ node: entryNode, type: UnknownType.create() });
                }
            }
        });

        return { type: AnyType.create(), isIncomplete, typeErrors };
    }

    function getTypeOfListOrSet(
        node: ListNode | SetNode,
        flags: EvalFlags,
        inferenceContext: InferenceContext | undefined
    ): TypeResult {
        if (
            (flags & EvalFlags.TypeExpression) !== 0 &&
            node.nodeType === ParseNodeType.List &&
            node.parent?.nodeType !== ParseNodeType.Argument
        ) {
            const diag = new DiagnosticAddendum();
            diag.addMessage(LocAddendum.useListInstead());
            addDiagnostic(DiagnosticRule.reportInvalidTypeForm, LocMessage.listInAnnotation() + diag.getString(), node);
        }

        flags &= ~(EvalFlags.TypeExpression | EvalFlags.StrLiteralAsType | EvalFlags.InstantiableType);

        // If the expected type is a union, recursively call for each of the subtypes
        // to find one that matches.
        let expectedType = inferenceContext?.expectedType;

        if (inferenceContext && isUnion(inferenceContext.expectedType)) {
            let matchingSubtype: Type | undefined;
            let matchingSubtypeResult: TypeResult | undefined;

            doForEachSubtype(
                inferenceContext.expectedType,
                (subtype) => {
                    // Use shortcut if we've already found a match.
                    if (matchingSubtypeResult && !matchingSubtypeResult.typeErrors) {
                        return;
                    }

                    const subtypeResult = useSpeculativeMode(node, () => {
                        return getTypeOfListOrSetWithContext(node, flags, makeInferenceContext(subtype));
                    });

                    if (subtypeResult && assignType(subtype, subtypeResult.type)) {
                        // If this is the first result we're seeing or it's the first result
                        // without errors, select it as the match.
                        if (!matchingSubtypeResult || (matchingSubtypeResult.typeErrors && !subtypeResult.typeErrors)) {
                            matchingSubtype = subtype;
                            matchingSubtypeResult = subtypeResult;
                        }
                    }
                },
                /* sortSubtypes */ true
            );

            expectedType = matchingSubtype;
        }

        let expectedTypeDiagAddendum: DiagnosticAddendum | undefined;
        if (expectedType) {
            const result = getTypeOfListOrSetWithContext(node, flags, makeInferenceContext(expectedType));
            if (result && !result.typeErrors) {
                return result;
            }

            expectedTypeDiagAddendum = result?.expectedTypeDiagAddendum;
        }

        const typeResult = getTypeOfListOrSetInferred(
            node,
            flags,
            /* hasExpectedType */ !!inferenceContext?.expectedType
        );
        return { ...typeResult, expectedTypeDiagAddendum };
    }

    // Attempts to determine the type of a list or set statement based on an expected type.
    // Returns undefined if that type cannot be honored.
    function getTypeOfListOrSetWithContext(
        node: ListNode | SetNode,
        flags: EvalFlags,
        inferenceContext: InferenceContext
    ): TypeResult | undefined {
        const builtInClassName = node.nodeType === ParseNodeType.List ? 'list' : 'set';
        inferenceContext.expectedType = transformPossibleRecursiveTypeAlias(inferenceContext.expectedType);

        let isIncomplete = false;
        let typeErrors = false;
        const verifyHashable = node.nodeType === ParseNodeType.Set;

        const expectedEntryType = getExpectedEntryTypeForIterable(
            node,
            getBuiltInType(node, builtInClassName),
            inferenceContext
        );
        if (!expectedEntryType) {
            return undefined;
        }

        const entryTypes: Type[] = [];
        const expectedTypeDiagAddendum = new DiagnosticAddendum();
        node.d.items.forEach((entry) => {
            let entryTypeResult: TypeResult;

            if (entry.nodeType === ParseNodeType.Comprehension) {
                entryTypeResult = getElementTypeFromComprehension(
                    entry,
                    flags | EvalFlags.StripTupleLiterals,
                    expectedEntryType
                );
            } else {
                entryTypeResult = getTypeOfExpression(
                    entry,
                    flags | EvalFlags.StripTupleLiterals,
                    makeInferenceContext(expectedEntryType)
                );
            }

            entryTypes.push(entryTypeResult.type);

            if (entryTypeResult.isIncomplete) {
                isIncomplete = true;
            }

            if (entryTypeResult.typeErrors) {
                typeErrors = true;
            }

            if (entryTypeResult.expectedTypeDiagAddendum) {
                expectedTypeDiagAddendum.addAddendum(entryTypeResult.expectedTypeDiagAddendum);
            }

            if (verifyHashable && !entryTypeResult.isIncomplete && !entryTypeResult.typeErrors) {
                verifySetEntryOrDictKeyIsHashable(entry, entryTypeResult.type, /* isDictKey */ false);
            }
        });

        let isTypeInvariant = false;

        if (isClassInstance(inferenceContext.expectedType)) {
            inferVarianceForClass(inferenceContext.expectedType);

            if (
                inferenceContext.expectedType.shared.typeParams.some(
                    (t) => TypeVarType.getVariance(t) === Variance.Invariant
                )
            ) {
                isTypeInvariant = true;
            }
        }

        const specializedEntryType = inferTypeArgFromExpectedEntryType(
            makeInferenceContext(expectedEntryType),
            entryTypes,
            !isTypeInvariant
        );
        if (!specializedEntryType) {
            return { type: UnknownType.create(), isIncomplete, typeErrors: true, expectedTypeDiagAddendum };
        }

        const type = getBuiltInObject(node, builtInClassName, [specializedEntryType]);
        return { type, isIncomplete, typeErrors, expectedTypeDiagAddendum };
    }

    function getExpectedEntryTypeForIterable(
        node: ListNode | SetNode | ComprehensionNode,
        expectedClassType: Type | undefined,
        inferenceContext?: InferenceContext
    ): Type | undefined {
        if (!inferenceContext) {
            return undefined;
        }

        if (!expectedClassType || !isInstantiableClass(expectedClassType)) {
            return undefined;
        }

        if (isAnyOrUnknown(inferenceContext.expectedType)) {
            return inferenceContext.expectedType;
        }

        if (!isClassInstance(inferenceContext.expectedType)) {
            return undefined;
        }

        const constraints = new ConstraintTracker();
        if (
            !addConstraintsForExpectedType(
                evaluatorInterface,
                ClassType.cloneAsInstance(expectedClassType),
                inferenceContext.expectedType,
                constraints,
                ParseTreeUtils.getTypeVarScopesForNode(node),
                node.start
            )
        ) {
            return undefined;
        }

        const specializedListOrSet = solveAndApplyConstraints(expectedClassType, constraints) as ClassType;
        if (!specializedListOrSet.priv.typeArgs) {
            return undefined;
        }

        return specializedListOrSet.priv.typeArgs[0];
    }

    // Attempts to infer the type of a list or set statement with no "expected type".
    function getTypeOfListOrSetInferred(
        node: ListNode | SetNode,
        flags: EvalFlags,
        hasExpectedType: boolean
    ): TypeResult {
        const builtInClassName = node.nodeType === ParseNodeType.List ? 'list' : 'set';
        const verifyHashable = node.nodeType === ParseNodeType.Set;
        let isEmptyContainer = false;
        let isIncomplete = false;
        let typeErrors = false;

        let entryTypes: Type[] = [];
        node.d.items.forEach((entry, index) => {
            let entryTypeResult: TypeResult;

            if (entry.nodeType === ParseNodeType.Comprehension && !entry.d.isGenerator) {
                entryTypeResult = getElementTypeFromComprehension(entry, flags | EvalFlags.StripTupleLiterals);
            } else {
                entryTypeResult = getTypeOfExpression(entry, flags | EvalFlags.StripTupleLiterals);
            }

            entryTypeResult.type = stripTypeForm(
                convertSpecialFormToRuntimeValue(entryTypeResult.type, flags, !hasExpectedType)
            );

            if (entryTypeResult.isIncomplete) {
                isIncomplete = true;
            }

            if (entryTypeResult.typeErrors) {
                typeErrors = true;
            }

            if (hasExpectedType || index < maxEntriesToUseForInference) {
                entryTypes.push(entryTypeResult.type);
            }

            if (verifyHashable && !entryTypeResult.isIncomplete && !entryTypeResult.typeErrors) {
                verifySetEntryOrDictKeyIsHashable(entry, entryTypeResult.type, /* isDictKey */ false);
            }
        });

        entryTypes = entryTypes.map((t) => stripLiteralValue(t));

        let inferredEntryType: Type = hasExpectedType ? AnyType.create() : UnknownType.create();
        if (entryTypes.length > 0) {
            const fileInfo = AnalyzerNodeInfo.getFileInfo(node);
            // If there was an expected type or we're using strict list inference,
            // combine the types into a union.
            if (
                (builtInClassName === 'list' && fileInfo.diagnosticRuleSet.strictListInference) ||
                (builtInClassName === 'set' && fileInfo.diagnosticRuleSet.strictSetInference) ||
                hasExpectedType
            ) {
                inferredEntryType = combineTypes(entryTypes, { maxSubtypeCount: maxSubtypesForInferredType });
            } else {
                // Is the list or set homogeneous? If so, use stricter rules. Otherwise relax the rules.
                inferredEntryType = areTypesSame(entryTypes, { ignorePseudoGeneric: true })
                    ? entryTypes[0]
                    : inferredEntryType;
            }
        } else {
            isEmptyContainer = true;
        }

        const listOrSetClass = getBuiltInType(node, builtInClassName);
        const type = isInstantiableClass(listOrSetClass)
            ? ClassType.cloneAsInstance(
                  ClassType.specialize(
                      listOrSetClass,
                      [inferredEntryType],
                      /* isTypeArgExplicit */ true,
                      /* includeSubclasses */ undefined,
                      /* tupleTypeArgs */ undefined,
                      isEmptyContainer
                  )
              )
            : UnknownType.create();

        if (isIncomplete) {
            if (getContainerDepth(type) > maxInferredContainerDepth) {
                return { type: UnknownType.create() };
            }
        }

        return { type, isIncomplete, typeErrors };
    }

    function verifySetEntryOrDictKeyIsHashable(entry: ExpressionNode, type: Type, isDictKey: boolean) {
        // Verify that the type is hashable.
        if (!isTypeHashable(type)) {
            const diag = new DiagnosticAddendum();
            diag.addMessage(LocAddendum.unhashableType().format({ type: printType(type) }));

            const message = isDictKey ? LocMessage.unhashableDictKey() : LocMessage.unhashableSetEntry();

            addDiagnostic(DiagnosticRule.reportUnhashable, message + diag.getString(), entry);
        }
    }

    function inferTypeArgFromExpectedEntryType(
        inferenceContext: InferenceContext,
        entryTypes: Type[],
        isNarrowable: boolean
    ): Type | undefined {
        // If the expected type is Any, the resulting type becomes Any.
        if (isAny(inferenceContext.expectedType)) {
            return inferenceContext.expectedType;
        }

        const constraints = new ConstraintTracker();
        const expectedType = inferenceContext.expectedType;
        let isCompatible = true;

        entryTypes.forEach((entryType) => {
            if (isCompatible && !assignType(expectedType, entryType, /* diag */ undefined, constraints)) {
                isCompatible = false;
            }
        });

        if (!isCompatible) {
            return undefined;
        }

        if (isNarrowable && entryTypes.length > 0) {
            const combinedTypes = combineTypes(entryTypes);
            return containsLiteralType(inferenceContext.expectedType)
                ? combinedTypes
                : stripLiteralValue(combinedTypes);
        }

        return mapSubtypes(
            solveAndApplyConstraints(inferenceContext.expectedType, constraints, {
                replaceUnsolved: {
                    scopeIds: [],
                    tupleClassType: getTupleClassType(),
                },
            }),
            (subtype) => {
                if (entryTypes.length !== 1) {
                    return subtype;
                }
                const entryType = entryTypes[0];

                // If the entry type is a TypedDict instance, clone it with additional information.
                if (
                    isTypeSame(subtype, entryType, { ignoreTypedDictNarrowEntries: true }) &&
                    isClass(subtype) &&
                    isClass(entryType) &&
                    ClassType.isTypedDictClass(entryType)
                ) {
                    return ClassType.cloneForNarrowedTypedDictEntries(subtype, entryType.priv.typedDictNarrowedEntries);
                }

                return subtype;
            }
        );
    }

    function getTypeOfYield(node: YieldNode): TypeResult {
        let expectedYieldType: Type | undefined;
        let sentType: Type | undefined;
        let isIncomplete = false;

        const enclosingFunction = ParseTreeUtils.getEnclosingFunction(node);
        if (enclosingFunction) {
            const functionTypeInfo = getTypeOfFunction(enclosingFunction);
            if (functionTypeInfo) {
                let returnType = FunctionType.getEffectiveReturnType(functionTypeInfo.functionType);
                if (returnType) {
                    const liveScopeIds = ParseTreeUtils.getTypeVarScopesForNode(node);
                    returnType = makeTypeVarsBound(returnType, liveScopeIds);

                    expectedYieldType = getGeneratorYieldType(returnType, !!enclosingFunction.d.isAsync);

                    const generatorTypeArgs = getGeneratorTypeArgs(returnType);
                    if (generatorTypeArgs && generatorTypeArgs.length >= 2) {
                        sentType = makeTypeVarsBound(generatorTypeArgs[1], liveScopeIds);
                    }
                }
            }
        }

        if (node.d.expr) {
            const exprResult = getTypeOfExpression(
                node.d.expr,
                /* flags */ undefined,
                makeInferenceContext(expectedYieldType)
            );
            if (exprResult.isIncomplete) {
                isIncomplete = true;
            }
        }

        return { type: sentType || UnknownType.create(), isIncomplete };
    }

    function getTypeOfYieldFrom(node: YieldFromNode): TypeResult {
        const yieldFromTypeResult = getTypeOfExpression(node.d.expr);
        const yieldFromType = yieldFromTypeResult.type;

        const returnedType = mapSubtypes(yieldFromType, (yieldFromSubtype) => {
            // Is the expression a Generator type?
            let generatorTypeArgs = getGeneratorTypeArgs(yieldFromSubtype);
            if (generatorTypeArgs) {
                return generatorTypeArgs.length >= 2 ? generatorTypeArgs[2] : UnknownType.create();
            }

            // Handle old-style (pre-await) Coroutines as a special case.
            if (
                isClassInstance(yieldFromSubtype) &&
                ClassType.isBuiltIn(yieldFromSubtype, ['Coroutine', 'CoroutineType'])
            ) {
                return UnknownType.create();
            }

            // Handle simple iterables.
            const iterableType =
                getTypeOfIterable(yieldFromTypeResult, /* isAsync */ false, node)?.type ?? UnknownType.create();

            // Does the iterable return a Generator?
            generatorTypeArgs = getGeneratorTypeArgs(iterableType);
            return generatorTypeArgs && generatorTypeArgs.length >= 2 ? generatorTypeArgs[2] : UnknownType.create();
        });

        return { type: returnedType };
    }

    function getTypeOfLambda(node: LambdaNode, inferenceContext: InferenceContext | undefined): TypeResult {
        let expectedFunctionTypes: FunctionType[] = [];
        if (inferenceContext) {
            mapSubtypes(inferenceContext.expectedType, (subtype) => {
                if (isFunction(subtype)) {
                    expectedFunctionTypes.push(subtype);
                }

                if (isClassInstance(subtype)) {
                    const boundMethod = getBoundMagicMethod(subtype, '__call__');
                    if (boundMethod && isFunction(boundMethod)) {
                        expectedFunctionTypes.push(boundMethod as FunctionType);
                    }
                }

                return undefined;
            });
        }

        let expectedSubtype: FunctionType | undefined;

        // If there's more than one type, try each in turn until we find one that works.
        if (expectedFunctionTypes.length > 1) {
            // Sort the expected types for deterministic results.
            expectedFunctionTypes = sortTypes(expectedFunctionTypes) as FunctionType[];

            for (const subtype of expectedFunctionTypes) {
                const result = getTypeOfLambdaWithExpectedType(
                    node,
                    subtype,
                    inferenceContext,
                    /* forceSpeculative */ true
                );

                if (!result.typeErrors) {
                    expectedSubtype = subtype;
                    break;
                }
            }
        }

        if (!expectedSubtype && expectedFunctionTypes.length > 0) {
            expectedSubtype = expectedFunctionTypes[0];
        }

        return getTypeOfLambdaWithExpectedType(node, expectedSubtype, inferenceContext, /* forceSpeculative */ false);
    }

    function getTypeOfLambdaWithExpectedType(
        node: LambdaNode,
        expectedType: FunctionType | undefined,
        inferenceContext: InferenceContext | undefined,
        forceSpeculative: boolean
    ): TypeResult {
        let isIncomplete = !!inferenceContext?.isTypeIncomplete;
        let paramsArePositionOnly = true;

        let expectedReturnType: Type | undefined;
        let expectedParamDetails: ParamListDetails | undefined;

        if (expectedType) {
            const liveTypeVarScopes = ParseTreeUtils.getTypeVarScopesForNode(node);
            expectedType = transformExpectedType(expectedType, liveTypeVarScopes, node.start) as FunctionType;

            expectedParamDetails = getParamListDetails(expectedType);
            expectedReturnType = getEffectiveReturnType(expectedType);
        }

        let functionType = FunctionType.createInstance('', '', '', FunctionTypeFlags.PartiallyEvaluated);
        functionType.shared.typeVarScopeId = ParseTreeUtils.getScopeIdForNode(node);

        return invalidateTypeCacheIfCanceled(() => {
            // Pre-cache the incomplete function type in case the evaluation of the
            // lambda depends on itself.
            writeTypeCache(node, { type: functionType, isIncomplete: true }, EvalFlags.None);

            // We assume for simplicity that the parameter signature of the lambda is
            // the same as the expected type. If this isn't the case, we'll use
            // object for any lambda parameters that don't match. We could make this
            // more sophisticated in the future, but it becomes very complex to handle
            // all of the permutations.
            let sawParamMismatch = false;

            node.d.params.forEach((param, index) => {
                let paramType: Type | undefined;

                if (expectedParamDetails && !sawParamMismatch) {
                    if (index < expectedParamDetails.params.length) {
                        const expectedParam = expectedParamDetails.params[index];

                        // If the parameter category matches and both of the parameters are
                        // either separators (/ or *) or not separators, copy the type
                        // from the expected parameter.
                        if (
                            expectedParam.param.category === param.d.category &&
                            !param.d.name === !expectedParam.param.name
                        ) {
                            paramType = expectedParam.type;
                        } else {
                            sawParamMismatch = true;
                        }
                    } else if (param.d.defaultValue) {
                        // If the lambda param has a default value but there is no associated
                        // parameter in the expected type, assume that the default value is
                        // being used to explicitly capture a value from an outer scope. Infer
                        // its type from the default value expression.
                        paramType = getTypeOfExpression(param.d.defaultValue, undefined, inferenceContext).type;
                    }
                } else if (param.d.defaultValue) {
                    // If there is no inference context but we have a default value,
                    // use the default value to infer the parameter's type.
                    paramType = inferParamTypeFromDefaultValue(param.d.defaultValue);
                }

                if (param.d.name) {
                    writeTypeCache(
                        param.d.name,
                        {
                            type: transformVariadicParamType(node, param.d.category, paramType ?? UnknownType.create()),
                        },
                        EvalFlags.None
                    );
                }

                if (param.d.defaultValue) {
                    // Evaluate the default value if it's present.
                    getTypeOfExpression(param.d.defaultValue, EvalFlags.ConvertEllipsisToAny);
                }

                // Determine whether we need to insert an implied position-only parameter.
                // This is needed when a function's parameters are named using the old-style
                // way of specifying position-only parameters.
                if (index >= 0) {
                    let isImplicitPositionOnlyParam = false;

                    if (param.d.category === ParamCategory.Simple && param.d.name) {
                        if (isPrivateName(param.d.name.d.value)) {
                            isImplicitPositionOnlyParam = true;
                        }
                    } else {
                        paramsArePositionOnly = false;
                    }

                    if (
                        paramsArePositionOnly &&
                        !isImplicitPositionOnlyParam &&
                        functionType.shared.parameters.length > 0
                    ) {
                        FunctionType.addPositionOnlyParamSeparator(functionType);
                    }

                    if (!isImplicitPositionOnlyParam) {
                        paramsArePositionOnly = false;
                    }
                }

                const functionParam = FunctionParam.create(
                    param.d.category,
                    paramType ?? UnknownType.create(),
                    FunctionParamFlags.TypeDeclared,
                    param.d.name ? param.d.name.d.value : undefined,
                    param.d.defaultValue ? AnyType.create(/* isEllipsis */ true) : undefined,
                    param.d.defaultValue
                );

                FunctionType.addParam(functionType, functionParam);
            });

            if (paramsArePositionOnly && functionType.shared.parameters.length > 0) {
                FunctionType.addPositionOnlyParamSeparator(functionType);
            }

            let typeErrors = false;

            // If we're speculatively evaluating the lambda, create another speculative
            // evaluation scope for the return expression and do not allow retention
            // of the cached types.
            // We need to set allowCacheRetention to false because we don't want to
            // cache the type of the lambda return expression because it depends on
            // the parameter types that we set above, and the speculative type cache
            // doesn't know about that context.
            useSpeculativeMode(
                forceSpeculative || isSpeculativeModeInUse(node) || inferenceContext?.isTypeIncomplete
                    ? node.d.expr
                    : undefined,
                () => {
                    const returnTypeResult = getTypeOfExpression(
                        node.d.expr,
                        /* flags */ undefined,
                        makeInferenceContext(expectedReturnType)
                    );

                    functionType.shared.inferredReturnType = {
                        type: returnTypeResult.type,
                    };
                    if (returnTypeResult.isIncomplete) {
                        isIncomplete = true;
                    }

                    if (returnTypeResult.typeErrors) {
                        typeErrors = true;
                    } else if (expectedReturnType) {
                        // If the expectedReturnType is generic, see if the actual return type
                        // provides types for some or all type variables.
                        if (requiresSpecialization(expectedReturnType)) {
                            const constraints = new ConstraintTracker();
                            if (
                                assignType(expectedReturnType, returnTypeResult.type, /* diag */ undefined, constraints)
                            ) {
                                functionType = solveAndApplyConstraints(functionType, constraints, {
                                    replaceUnsolved: {
                                        scopeIds: [],
                                        tupleClassType: getTupleClassType(),
                                    },
                                }) as FunctionType;
                            }
                        }
                    }
                },
                {
                    dependentType: inferenceContext?.expectedType,
                    allowDiagnostics:
                        !forceSpeculative && !canSkipDiagnosticForNode(node) && !inferenceContext?.isTypeIncomplete,
                }
            );

            // Mark the function type as no longer being evaluated.
            functionType.shared.flags &= ~FunctionTypeFlags.PartiallyEvaluated;

            // Is the resulting function compatible with the expected type?
            if (expectedType && !assignType(expectedType, functionType)) {
                typeErrors = true;
            }

            return { type: functionType, isIncomplete, typeErrors };
        });
    }

    function getTypeOfComprehension(
        node: ComprehensionNode,
        flags: EvalFlags,
        inferenceContext?: InferenceContext
    ): TypeResult {
        let isIncomplete = false;
        let typeErrors = false;

        // If any of the "for" clauses are marked async or any of the "if" clauses
        // or any clause other than the leftmost "for" contain an "await" operator,
        // it is treated as an async generator.
        let isAsync = node.d.forIfNodes.some((comp, index) => {
            if (comp.nodeType === ParseNodeType.ComprehensionFor && comp.d.isAsync) {
                return true;
            }
            return index > 0 && ParseTreeUtils.containsAwaitNode(comp);
        });
        let type: Type = UnknownType.create();

        if (ParseTreeUtils.containsAwaitNode(node.d.expr)) {
            isAsync = true;
        }

        const builtInIteratorType = getTypingType(node, isAsync ? 'AsyncGenerator' : 'Generator');

        const expectedEntryType = getExpectedEntryTypeForIterable(node, builtInIteratorType, inferenceContext);
        const elementTypeResult = getElementTypeFromComprehension(
            node,
            flags | EvalFlags.StripTupleLiterals,
            expectedEntryType
        );

        if (elementTypeResult.isIncomplete) {
            isIncomplete = true;
        }

        if (elementTypeResult.typeErrors) {
            typeErrors = true;
        }

        let elementType = elementTypeResult.type;
        if (!expectedEntryType || !containsLiteralType(expectedEntryType)) {
            elementType = stripLiteralValue(elementType);
        }

        if (builtInIteratorType && isInstantiableClass(builtInIteratorType)) {
            type = ClassType.cloneAsInstance(
                ClassType.specialize(
                    builtInIteratorType,
                    isAsync ? [elementType, getNoneType()] : [elementType, getNoneType(), getNoneType()]
                )
            );
        }

        return { type, isIncomplete, typeErrors };
    }

    function reportPossibleUnknownAssignment(
        diagLevel: DiagnosticLevel,
        rule: DiagnosticRule,
        target: NameNode,
        type: Type,
        errorNode: ExpressionNode,
        ignoreEmptyContainers: boolean
    ) {
        // Don't bother if the feature is disabled.
        if (diagLevel === 'none') {
            return;
        }

        const nameValue = target.d.value;

        // Sometimes variables contain an "unbound" type if they're
        // assigned only within conditional statements. Remove this
        // to avoid confusion.
        const simplifiedType = removeUnbound(type);

        if (isUnknown(simplifiedType)) {
            addDiagnostic(rule, LocMessage.typeUnknown().format({ name: nameValue }), errorNode);
        } else if (isPartlyUnknown(simplifiedType)) {
            // If ignoreEmptyContainers is true, don't report the problem for
            // empty containers (lists or dictionaries). We'll report the problem
            // only if the assigned value is used later.
            if (!ignoreEmptyContainers || !isClassInstance(type) || !type.priv.isEmptyContainer) {
                const diagAddendum = new DiagnosticAddendum();
                diagAddendum.addMessage(
                    LocAddendum.typeOfSymbol().format({
                        name: nameValue,
                        type: printType(simplifiedType, { expandTypeAlias: true }),
                    })
                );
                addDiagnostic(
                    rule,
                    LocMessage.typePartiallyUnknown().format({ name: nameValue }) + diagAddendum.getString(),
                    errorNode
                );
            }
        }
    }

    function evaluateComprehensionForIf(node: ComprehensionForIfNode) {
        let isIncomplete = false;

        if (node.nodeType === ParseNodeType.ComprehensionFor) {
            const iterableTypeResult = getTypeOfExpression(node.d.iterableExpr);
            if (iterableTypeResult.isIncomplete) {
                isIncomplete = true;
            }
            const iterableType = stripLiteralValue(iterableTypeResult.type);
            const itemTypeResult = getTypeOfIterator(
                { type: iterableType, isIncomplete: iterableTypeResult.isIncomplete },
                !!node.d.isAsync,
                node.d.iterableExpr
            ) ?? { type: UnknownType.create(), isIncomplete: iterableTypeResult.isIncomplete };

            const targetExpr = node.d.targetExpr;
            assignTypeToExpression(targetExpr, itemTypeResult, node.d.iterableExpr);
        } else {
            assert(node.nodeType === ParseNodeType.ComprehensionIf);

            // Evaluate the test expression to validate it and mark symbols
            // as referenced. This doesn't affect the type of the evaluated
            // comprehension, but it is important for evaluating intermediate
            // expressions such as assignment expressions that can affect other
            // subexpressions.
            getTypeOfExpression(node.d.testExpr);
        }

        return isIncomplete;
    }

    // Returns the type of one entry returned by the comprehension.
    function getElementTypeFromComprehension(
        node: ComprehensionNode,
        flags: EvalFlags,
        expectedValueOrElementType?: Type,
        expectedKeyType?: Type
    ): TypeResult {
        let isIncomplete = false;
        let typeErrors = false;

        // "Execute" the list comprehensions from start to finish.
        for (const forIfNode of node.d.forIfNodes) {
            if (evaluateComprehensionForIf(forIfNode)) {
                isIncomplete = true;
            }
        }

        let type: Type = UnknownType.create();
        if (node.d.expr.nodeType === ParseNodeType.DictionaryKeyEntry) {
            // Create a tuple with the key/value types.
            const keyTypeResult = getTypeOfExpression(
                node.d.expr.d.keyExpr,
                flags,
                makeInferenceContext(expectedKeyType)
            );
            if (keyTypeResult.isIncomplete) {
                isIncomplete = true;
            }
            if (keyTypeResult.typeErrors) {
                typeErrors = true;
            }
            let keyType = keyTypeResult.type;
            if (!expectedKeyType || !containsLiteralType(expectedKeyType)) {
                keyType = stripLiteralValue(keyType);
            }

            const valueTypeResult = getTypeOfExpression(
                node.d.expr.d.valueExpr,
                flags,
                makeInferenceContext(expectedValueOrElementType)
            );
            if (valueTypeResult.isIncomplete) {
                isIncomplete = true;
            }
            if (valueTypeResult.typeErrors) {
                typeErrors = true;
            }
            let valueType = valueTypeResult.type;
            if (!expectedValueOrElementType || !containsLiteralType(expectedValueOrElementType)) {
                valueType = stripLiteralValue(valueType);
            }

            type = makeTupleObject(evaluatorInterface, [
                { type: keyType, isUnbounded: false },
                { type: valueType, isUnbounded: false },
            ]);
        } else if (node.d.expr.nodeType === ParseNodeType.DictionaryExpandEntry) {
            // The parser should have reported an error in this case because it's not allowed.
            getTypeOfExpression(node.d.expr.d.expr, flags, makeInferenceContext(expectedValueOrElementType));
        } else if (isExpressionNode(node)) {
            const exprTypeResult = getTypeOfExpression(
                node.d.expr as ExpressionNode,
                flags,
                makeInferenceContext(expectedValueOrElementType)
            );
            if (exprTypeResult.isIncomplete) {
                isIncomplete = true;
            }
            if (exprTypeResult.typeErrors) {
                typeErrors = true;
            }
            type = exprTypeResult.type;
        }

        return { type, isIncomplete, typeErrors };
    }

    function getTypeOfSlice(node: SliceNode): TypeResult {
        const noneType = getNoneType();
        let startType = noneType;
        let endType = noneType;
        let stepType = noneType;
        let isIncomplete = false;

        // Evaluate the expressions to report errors and record symbol
        // references.
        if (node.d.startValue) {
            const startTypeResult = getTypeOfExpression(node.d.startValue);
            startType = startTypeResult.type;
            if (startTypeResult.isIncomplete) {
                isIncomplete = true;
            }
        }

        if (node.d.endValue) {
            const endTypeResult = getTypeOfExpression(node.d.endValue);
            endType = endTypeResult.type;
            if (endTypeResult.isIncomplete) {
                isIncomplete = true;
            }
        }

        if (node.d.stepValue) {
            const stepTypeResult = getTypeOfExpression(node.d.stepValue);
            stepType = stepTypeResult.type;
            if (stepTypeResult.isIncomplete) {
                isIncomplete = true;
            }
        }

        const sliceType = getBuiltInObject(node, 'slice');

        if (!isClassInstance(sliceType)) {
            return { type: sliceType };
        }

        return { type: ClassType.specialize(sliceType, [startType, endType, stepType]), isIncomplete };
    }

    // Verifies that a type argument's type is not disallowed.
    function validateTypeArg(argResult: TypeResultWithNode, options?: ValidateTypeArgsOptions): boolean {
        if (argResult.typeList) {
            if (!options?.allowTypeArgList) {
                addDiagnostic(DiagnosticRule.reportInvalidTypeForm, LocMessage.typeArgListNotAllowed(), argResult.node);
                return false;
            } else {
                argResult.typeList.forEach((typeArg) => {
                    validateTypeArg(typeArg);
                });
            }
        }

        if (isEllipsisType(argResult.type)) {
            if (!options?.allowTypeArgList) {
                addDiagnostic(DiagnosticRule.reportInvalidTypeForm, LocMessage.ellipsisContext(), argResult.node);
                return false;
            }
        }

        if (isModule(argResult.type)) {
            addDiagnostic(DiagnosticRule.reportInvalidTypeForm, LocMessage.moduleAsType(), argResult.node);
            return false;
        }

        if (isParamSpec(argResult.type)) {
            if (!options?.allowParamSpec) {
                addDiagnostic(DiagnosticRule.reportInvalidTypeForm, LocMessage.paramSpecContext(), argResult.node);
                return false;
            }
        }

        if (isTypeVarTuple(argResult.type) && !argResult.type.priv.isInUnion) {
            if (!options?.allowTypeVarTuple) {
                addDiagnostic(DiagnosticRule.reportInvalidTypeForm, LocMessage.typeVarTupleContext(), argResult.node);
                return false;
            } else {
                specialForms.validateTypeVarTupleIsUnpacked(evaluatorInterface, argResult.type, argResult.node);
            }
        }

        if (!options?.allowEmptyTuple && argResult.isEmptyTupleShorthand) {
            addDiagnostic(DiagnosticRule.reportInvalidTypeForm, LocMessage.zeroLengthTupleNotAllowed(), argResult.node);
            return false;
        }

        if (isUnpackedClass(argResult.type)) {
            if (!options?.allowUnpackedTuples) {
                addDiagnostic(
                    DiagnosticRule.reportInvalidTypeForm,
                    LocMessage.unpackedArgInTypeArgument(),
                    argResult.node
                );
                return false;
            }
        }

        return true;
    }

    // Evaluates the type arguments for a Callable type. It should have zero
    // to two arguments.The first argument, if present, should be an ellipsis,
    // a ParamSpec, a Concatenate, or a list of positional parameter types.
    function cloneBuiltinObjectWithLiteral(node: ParseNode, builtInName: string, value: LiteralValue): Type {
        const type = getBuiltInObject(node, builtInName);
        if (isClassInstance(type)) {
            return ClassType.cloneWithLiteral(ClassType.cloneRemoveTypePromotions(type), value);
        }

        return UnknownType.create();
    }

    function transformTypeForTypeAlias(
        type: Type,
        errorNode: ExpressionNode,
        typeAliasPlaceholder: TypeVarType,
        isPep695TypeVarType: boolean,
        typeParamNodes?: TypeParameterNode[]
    ): Type {
        return symbolResolution.transformTypeForTypeAlias(
            evaluatorInterface,
            type,
            errorNode,
            typeAliasPlaceholder,
            isPep695TypeVarType,
            typeParamNodes
        );
    }

    // Handles some special-case type annotations that are found
    // within the typings.pyi file.
    function handleTypingStubTypeAnnotation(node: ExpressionNode): Type | undefined {
        if (!node.parent || node.parent.nodeType !== ParseNodeType.TypeAnnotation) {
            return undefined;
        }

        if (node.parent.d.valueExpr.nodeType !== ParseNodeType.Name) {
            return undefined;
        }

        const nameNode = node.parent.d.valueExpr;
        const assignedName = nameNode.d.value;

        const specialTypes: Map<string, AliasMapEntry> = new Map([
            ['Tuple', { alias: 'tuple', module: 'builtins' }],
            ['Generic', { alias: '', module: 'builtins', isSpecialForm: true }],
            ['Protocol', { alias: '', module: 'builtins', isSpecialForm: true }],
            ['Callable', { alias: '', module: 'builtins', isSpecialForm: true }],
            ['Type', { alias: 'type', module: 'builtins' }],
            ['ClassVar', { alias: '', module: 'builtins', isSpecialForm: true }],
            ['Final', { alias: '', module: 'builtins', isSpecialForm: true }],
            ['Literal', { alias: '', module: 'builtins', isSpecialForm: true }],
            ['TypedDict', { alias: 'TypedDictFallback', module: 'internals' }],
            ['Union', { alias: '', module: 'builtins', isSpecialForm: true }],
            ['Optional', { alias: '', module: 'builtins', isSpecialForm: true }],
            ['Annotated', { alias: '', module: 'builtins', isSpecialForm: true, isIllegalInIsinstance: true }],
            ['TypeAlias', { alias: '', module: 'builtins', isSpecialForm: true }],
            ['Concatenate', { alias: '', module: 'builtins', isSpecialForm: true }],
            [
                'TypeGuard',
                {
                    alias: '',
                    module: 'builtins',
                    implicitBaseClass: 'bool',
                    isSpecialForm: true,
                    typeParamVariance: Variance.Covariant,
                },
            ],
            ['Unpack', { alias: '', module: 'builtins', isSpecialForm: true }],
            ['Required', { alias: '', module: 'builtins', isSpecialForm: true }],
            ['NotRequired', { alias: '', module: 'builtins', isSpecialForm: true }],
            ['Self', { alias: '', module: 'builtins', isSpecialForm: true }],
            ['NoReturn', { alias: '', module: 'builtins', isSpecialForm: true }],
            ['Never', { alias: '', module: 'builtins', isSpecialForm: true }],
            ['LiteralString', { alias: '', module: 'builtins', isSpecialForm: true }],
            ['ReadOnly', { alias: '', module: 'builtins', isSpecialForm: true }],
            [
                'TypeIs',
                {
                    alias: '',
                    module: 'builtins',
                    implicitBaseClass: 'bool',
                    isSpecialForm: true,
                    typeParamVariance: Variance.Invariant,
                },
            ],
            [
                'TypeForm',
                {
                    alias: '',
                    module: 'builtins',
                    isSpecialForm: true,
                    typeParamVariance: Variance.Covariant,
                    isIllegalInIsinstance: true,
                },
            ],
        ]);

        const aliasMapEntry = specialTypes.get(assignedName);

        if (aliasMapEntry) {
            const cachedType = readTypeCache(node, EvalFlags.None);
            if (cachedType) {
                return cachedType;
            }

            let specialType: Type = specialForms.createSpecialBuiltInClass(
                evaluatorInterface,
                node,
                assignedName,
                aliasMapEntry,
                registry
            );

            // Handle 'LiteralString' specially because we want it to act as
            // though it derives from 'str'.
            if (assignedName === 'LiteralString') {
                specialType.shared.baseClasses.push(registry.strClass ?? AnyType.create());
                computeMroLinearization(specialType);

                if (isTypeFormSupported(node)) {
                    specialType = TypeBase.cloneWithTypeForm(specialType, convertToInstance(specialType));
                }
            }

            // Handle 'Never' and 'NoReturn' specially.
            if (assignedName === 'Never' || assignedName === 'NoReturn') {
                specialType = TypeBase.cloneAsSpecialForm(
                    assignedName === 'Never' ? NeverType.createNever() : NeverType.createNoReturn(),
                    specialType
                );

                if (isTypeFormSupported(node)) {
                    specialType = TypeBase.cloneWithTypeForm(specialType, convertToInstance(specialType));
                }
            }

            writeTypeCache(node, { type: specialType }, EvalFlags.None);
            return specialType;
        }

        return undefined;
    }

    // Handles some special-case assignment statements that are found
    // within the typings.pyi file.
    function handleTypingStubAssignment(node: AssignmentNode): Type | undefined {
        if (node.d.leftExpr.nodeType !== ParseNodeType.Name) {
            return undefined;
        }

        const nameNode = node.d.leftExpr;
        const assignedName = nameNode.d.value;

        if (assignedName === 'Any') {
            return AnyType.createSpecialForm();
        }

        const specialTypes: Map<string, AliasMapEntry> = new Map([
            ['overload', { alias: '', module: 'builtins' }],
            ['TypeVar', { alias: '', module: 'builtins' }],
            ['_promote', { alias: '', module: 'builtins' }],
            ['no_type_check', { alias: '', module: 'builtins' }],
            ['NoReturn', { alias: '', module: 'builtins' }],
            ['Never', { alias: '', module: 'builtins' }],
            ['Counter', { alias: 'Counter', module: 'collections' }],
            ['List', { alias: 'list', module: 'builtins' }],
            ['Dict', { alias: 'dict', module: 'builtins' }],
            ['DefaultDict', { alias: 'defaultdict', module: 'collections' }],
            ['Set', { alias: 'set', module: 'builtins' }],
            ['FrozenSet', { alias: 'frozenset', module: 'builtins' }],
            ['Deque', { alias: 'deque', module: 'collections' }],
            ['ChainMap', { alias: 'ChainMap', module: 'collections' }],
            ['OrderedDict', { alias: 'OrderedDict', module: 'collections' }],
        ]);

        const aliasMapEntry = specialTypes.get(assignedName);
        if (aliasMapEntry) {
            // Evaluate the expression so symbols are marked as accessed.
            getTypeOfExpression(node.d.rightExpr);
            return specialForms.createSpecialBuiltInClass(
                evaluatorInterface,
                node,
                assignedName,
                aliasMapEntry,
                registry
            );
        }

        return undefined;
    }

    function evaluateTypesForAssignmentStatement(node: AssignmentNode): void {
        const fileInfo = AnalyzerNodeInfo.getFileInfo(node);

        // If the entire statement has already been evaluated, don't
        // re-evaluate it.
        if (isTypeCached(node)) {
            return;
        }

        let flags: EvalFlags = EvalFlags.None;
        if (fileInfo.isStubFile) {
            // An assignment of ellipsis means "Any" within a type stub file.
            flags |= EvalFlags.ConvertEllipsisToAny;
        }

        if (
            node.d.rightExpr.nodeType === ParseNodeType.Name ||
            node.d.rightExpr.nodeType === ParseNodeType.MemberAccess
        ) {
            // Don't specialize a generic class on assignment (e.g. "x = list"
            // or "x = collections.OrderedDict") because we may want to later
            // specialize it (e.g. "x[int]").
            flags |= EvalFlags.NoSpecialize;
        }

        // Is this type already cached?
        let rightHandType = readTypeCache(node.d.rightExpr, /* flags */ undefined);
        let isIncomplete = false;
        let expectedTypeDiagAddendum: DiagnosticAddendum | undefined;

        if (!rightHandType) {
            // Special-case the typing.pyi file, which contains some special
            // types that the type analyzer needs to interpret differently.
            if (fileInfo.isTypingStubFile || fileInfo.isTypingExtensionsStubFile) {
                rightHandType = handleTypingStubAssignment(node);
                if (rightHandType) {
                    writeTypeCache(node.d.rightExpr, { type: rightHandType }, EvalFlags.None);
                }
            }
        }

        if (!rightHandType) {
            let typeAliasNameNode: NameNode | undefined;
            let typeAliasPlaceholder: TypeVarType | undefined;
            let isSpeculativeTypeAlias = false;

            if (isDeclaredTypeAlias(node.d.leftExpr)) {
                flags =
                    EvalFlags.InstantiableType |
                    EvalFlags.TypeExpression |
                    EvalFlags.StrLiteralAsType |
                    EvalFlags.NoParamSpec |
                    EvalFlags.NoTypeVarTuple |
                    EvalFlags.NoClassVar;

                typeAliasNameNode = (node.d.leftExpr as TypeAnnotationNode).d.valueExpr as NameNode;

                if (!isLegalTypeAliasExpressionForm(node.d.rightExpr, /* allowStrLiteral */ true)) {
                    addDiagnostic(
                        DiagnosticRule.reportInvalidTypeForm,
                        LocMessage.typeAliasIllegalExpressionForm(),
                        node.d.rightExpr
                    );
                }
            } else if (node.d.leftExpr.nodeType === ParseNodeType.Name) {
                const symbolWithScope = lookUpSymbolRecursive(
                    node.d.leftExpr,
                    node.d.leftExpr.d.value,
                    /* honorCodeFlow */ false
                );

                if (symbolWithScope) {
                    const decls = symbolWithScope.symbol.getDeclarations();

                    if (decls.length === 1) {
                        if (isPossibleTypeAliasDeclaration(decls[0])) {
                            typeAliasNameNode = node.d.leftExpr;
                            isSpeculativeTypeAlias = true;
                            flags |= EvalFlags.NoConvertSpecialForm;
                        } else if (isPossibleTypeDictFactoryCall(decls[0])) {
                            // Handle calls to TypedDict factory functions like type
                            // aliases to support recursive field type definitions.
                            typeAliasNameNode = node.d.leftExpr;
                        }
                    }
                }
            }

            if (typeAliasNameNode) {
                typeAliasPlaceholder = synthesizeTypeAliasPlaceholder(typeAliasNameNode);

                writeTypeCache(node, { type: typeAliasPlaceholder }, /* flags */ undefined);
                writeTypeCache(node.d.leftExpr, { type: typeAliasPlaceholder }, /* flags */ undefined);

                if (node.d.leftExpr.nodeType === ParseNodeType.TypeAnnotation) {
                    writeTypeCache(node.d.leftExpr.d.valueExpr, { type: typeAliasPlaceholder }, /* flags */ undefined);
                }
            }

            let declaredType = getDeclaredTypeForExpression(node.d.leftExpr, { method: 'set' });

            if (declaredType) {
                const liveTypeVarScopes = ParseTreeUtils.getTypeVarScopesForNode(node);
                declaredType = makeTypeVarsBound(declaredType, liveTypeVarScopes);
            }

            const srcTypeResult = getTypeOfExpression(node.d.rightExpr, flags, makeInferenceContext(declaredType));

            rightHandType = srcTypeResult.type;
            expectedTypeDiagAddendum = srcTypeResult.expectedTypeDiagAddendum;
            if (srcTypeResult.isIncomplete) {
                isIncomplete = true;
            }

            // If this was a speculative type alias, it becomes a real type alias
            // only if the evaluated type is an instantiable type.
            if (isSpeculativeTypeAlias && !isLegalImplicitTypeAliasType(rightHandType)) {
                typeAliasNameNode = undefined;
            }

            if (typeAliasNameNode) {
                assert(typeAliasPlaceholder !== undefined);

                // If this is a type alias, record its name based on the assignment target.
                rightHandType = transformTypeForTypeAlias(
                    rightHandType,
                    typeAliasNameNode,
                    typeAliasPlaceholder,
                    /* isPep695TypeVarType */ false
                );

                if (isTypeAliasRecursive(typeAliasPlaceholder, rightHandType)) {
                    addDiagnostic(
                        DiagnosticRule.reportGeneralTypeIssues,
                        LocMessage.typeAliasIsRecursiveDirect().format({
                            name: typeAliasNameNode.d.value,
                        }),
                        node.d.rightExpr
                    );

                    rightHandType = UnknownType.create();
                }

                // Set the resulting type to the boundType of the original type alias
                // to support recursive type aliases.
                typeAliasPlaceholder.shared.boundType = rightHandType;

                // Record the type parameters within the recursive type alias so it
                // can be specialized.
                typeAliasPlaceholder.shared.recursiveAlias!.typeParams =
                    rightHandType.props?.typeAliasInfo?.shared.typeParams;
            } else {
                // If the RHS is a constant boolean expression, assign it a literal type.
                const constExprValue = evaluateStaticBoolExpression(
                    node.d.rightExpr,
                    fileInfo.executionEnvironment,
                    fileInfo.definedConstants
                );

                if (constExprValue !== undefined) {
                    const boolType = getBuiltInObject(node, 'bool');
                    if (isClassInstance(boolType)) {
                        rightHandType = ClassType.cloneWithLiteral(boolType, constExprValue);
                    }
                }
            }
        }

        assignTypeToExpression(
            node.d.leftExpr,
            { type: rightHandType, isIncomplete },
            node.d.rightExpr,
            /* ignoreEmptyContainers */ true,
            /* allowAssignmentToFinalVar */ true,
            expectedTypeDiagAddendum
        );

        writeTypeCache(node, { type: rightHandType, isIncomplete }, EvalFlags.None);
    }

    // Synthesize a TypeVar that acts as a placeholder for a type alias. This allows
    // the type alias definition to refer to itself.
    function synthesizeTypeAliasPlaceholder(nameNode: NameNode, isTypeAliasType: boolean = false): TypeVarType {
        return symbolResolution.synthesizeTypeAliasPlaceholder(nameNode, isTypeAliasType);
    }

    // Evaluates the type of a type alias (i.e. "type") statement. This code
    // path does not handle traditional type aliases, which are treated as
    // variables since they use normal variable assignment syntax.
    function getTypeOfTypeAlias(node: TypeAliasNode): Type {
        return getTypeOfTypeAliasCommon(
            node,
            node.d.name,
            node.d.expr,
            /* isPep695Syntax */ true,
            node.d.typeParams?.d.params,
            () => {
                if (node.d.typeParams) {
                    return evaluateTypeParamList(node.d.typeParams);
                }
                return undefined;
            }
        );
    }

    // This function is common to the handling of "type" statements and explicit
    // calls to the TypeAliasType constructor.
    function getTypeOfTypeAliasCommon(
        declNode: ParseNode,
        nameNode: NameNode,
        valueNode: ExpressionNode,
        isPep695Syntax: boolean,
        typeParamNodes: TypeParameterNode[] | undefined,
        getTypeParamCallback: () => TypeVarType[] | undefined
    ) {
        const cachedType = readTypeCache(nameNode, EvalFlags.None);
        if (cachedType) {
            return cachedType;
        }

        // Synthesize a type variable that represents the type alias while we're
        // evaluating it. This allows us to handle recursive definitions.
        const typeAliasTypeVar = synthesizeTypeAliasPlaceholder(nameNode, /* isTypeAliasType */ true);

        // Write the type to the type cache to support recursive type alias definitions.
        writeTypeCache(nameNode, { type: typeAliasTypeVar }, /* flags */ undefined);

        // Set a partial type to handle recursive (self-referential) type aliases.
        const scope = ScopeUtils.getScopeForNode(declNode);
        const typeAliasSymbol = scope?.lookUpSymbolRecursive(nameNode.d.value);
        const typeAliasDecl = AnalyzerNodeInfo.getDeclaration(declNode);
        if (typeAliasDecl && typeAliasSymbol) {
            setSymbolResolutionPartialType(typeAliasSymbol.symbol, typeAliasDecl, typeAliasTypeVar);
        }

        const typeParams = getTypeParamCallback();
        if (typeAliasTypeVar.shared.recursiveAlias) {
            typeAliasTypeVar.shared.recursiveAlias.typeParams = typeParams ?? [];
        }

        let aliasTypeResult: TypeResult;
        if (isPep695Syntax) {
            aliasTypeResult = getTypeOfExpressionExpectingType(valueNode, {
                forwardRefs: true,
                typeExpression: true,
            });
        } else {
            const flags =
                EvalFlags.InstantiableType |
                EvalFlags.TypeExpression |
                EvalFlags.StrLiteralAsType |
                EvalFlags.NoParamSpec |
                EvalFlags.NoTypeVarTuple |
                EvalFlags.NoClassVar;
            aliasTypeResult = getTypeOfExpression(valueNode, flags);
        }

        let isIncomplete = false;
        let aliasType = aliasTypeResult.type;
        if (aliasTypeResult.isIncomplete) {
            isIncomplete = true;
        }

        aliasType = transformTypeForTypeAlias(
            aliasType,
            nameNode,
            typeAliasTypeVar,
            /* isPep695TypeVarType */ true,
            typeParamNodes
        );

        // See if the type alias relies on itself in a way that cannot be resolved.
        if (isTypeAliasRecursive(typeAliasTypeVar, aliasType)) {
            addDiagnostic(
                DiagnosticRule.reportGeneralTypeIssues,
                LocMessage.typeAliasIsRecursiveDirect().format({
                    name: nameNode.d.value,
                }),
                valueNode
            );

            aliasType = UnknownType.create();
        }

        // Set the resulting type to the boundType of the original type alias
        // to support recursive type aliases.
        typeAliasTypeVar.shared.boundType = aliasType;

        writeTypeCache(nameNode, { type: aliasType, isIncomplete }, EvalFlags.None);

        return aliasType;
    }

    function evaluateTypesForAugmentedAssignment(node: AugmentedAssignmentNode): void {
        if (isTypeCached(node)) {
            return;
        }

        const destTypeResult = getTypeOfAugmentedAssignment(evaluatorInterface, node, /* inferenceContext */ undefined);

        writeTypeCache(node, destTypeResult, EvalFlags.None);
    }

    function getPseudoGenericTypeVarName(paramName: string) {
        return `__type_of_${paramName}`;
    }

    function getTypeOfClass(node: ClassNode): ClassTypeResult | undefined {
        ensureRegistryInitialized(node);

        // Is this type already cached?
        const cachedClassType = readTypeCache(node.d.name, EvalFlags.None);

        if (cachedClassType) {
            if (!isInstantiableClass(cachedClassType)) {
                // This can happen in rare circumstances where the class declaration
                // is located in an unreachable code block.
                return undefined;
            }
            return {
                classType: cachedClassType,
                decoratedType: readTypeCache(node, EvalFlags.None) || UnknownType.create(),
            };
        }

        // The type wasn't cached, so we need to create a new one.
        const scope = ScopeUtils.getScopeForNode(node);

        const fileInfo = AnalyzerNodeInfo.getFileInfo(node);
        let classFlags = ClassTypeFlags.None;
        if (
            scope?.type === ScopeType.Builtin ||
            fileInfo.isTypingStubFile ||
            fileInfo.isTypingExtensionsStubFile ||
            fileInfo.isBuiltInStubFile ||
            fileInfo.isTypeshedStubFile
        ) {
            classFlags |= ClassTypeFlags.BuiltIn;

            if (fileInfo.isTypingExtensionsStubFile) {
                classFlags |= ClassTypeFlags.TypingExtensionClass;
            }

            if (node.d.name.d.value === 'property') {
                classFlags |= ClassTypeFlags.PropertyClass;
            }

            if (node.d.name.d.value === 'tuple') {
                classFlags |= ClassTypeFlags.TupleClass;
            }
        }

        if (fileInfo.isStubFile) {
            classFlags |= ClassTypeFlags.DefinedInStub;
        }

        const classType = ClassType.createInstantiable(
            node.d.name.d.value,
            ParseTreeUtils.getClassFullName(node, fileInfo.moduleName, node.d.name.d.value),
            fileInfo.moduleName,
            fileInfo.fileUri,
            classFlags,
            ParseTreeUtils.getTypeSourceId(node),
            /* declaredMetaclass */ undefined,
            /* effectiveMetaclass */ undefined,
            ParseTreeUtils.getDocString(node.d.suite.d.statements)
        );

        classType.shared.typeVarScopeId = ParseTreeUtils.getScopeIdForNode(node);

        // Is this a special type that supports type promotions according to PEP 484?
        if (typePromotions.has(classType.shared.fullName)) {
            classType.priv.includePromotions = true;
        }

        // Some classes refer to themselves within type arguments used within
        // base classes. We'll register the partially-constructed class type
        // to allow these to be resolved.
        const classSymbol = scope?.lookUpSymbol(node.d.name.d.value);
        let classDecl: ClassDeclaration | undefined;
        const decl = AnalyzerNodeInfo.getDeclaration(node);
        if (decl) {
            classDecl = decl as ClassDeclaration;
        }
        if (classDecl && classSymbol) {
            setSymbolResolutionPartialType(classSymbol, classDecl, classType);
        }
        classType.shared.flags |= ClassTypeFlags.PartiallyEvaluated;
        classType.shared.declaration = classDecl;

        return invalidateTypeCacheIfCanceled(() => {
            writeTypeCache(node, { type: classType }, /* flags */ undefined);
            writeTypeCache(node.d.name, { type: classType }, /* flags */ undefined);

            // Keep a list of unique type parameters that are used in the
            // base class arguments.
            let typeParams: TypeVarType[] = [];

            if (node.d.typeParams) {
                typeParams = evaluateTypeParamList(node.d.typeParams).map((t) => TypeVarType.cloneAsInstance(t));
            }

            // If the class derives from "Generic" directly, it will provide
            // all of the type parameters in the specified order.
            let genericTypeParams: TypeVarType[] | undefined;
            let protocolTypeParams: TypeVarType[] | undefined;
            let isNamedTupleSubclass = false;

            const initSubclassArgs: Arg[] = [];
            let metaclassNode: ExpressionNode | undefined;
            let exprFlags =
                EvalFlags.InstantiableType |
                EvalFlags.AllowGeneric |
                EvalFlags.NoNakedGeneric |
                EvalFlags.NoTypeVarWithScopeId |
                EvalFlags.TypeVarGetsCurScope |
                EvalFlags.EnforceVarianceConsistency;
            if (fileInfo.isStubFile) {
                exprFlags |= EvalFlags.ForwardRefs;
            }
            let sawClosedOrExtraItems = false;

            node.d.arguments.forEach((arg) => {
                // Ignore unpacked arguments.
                if (arg.d.argCategory === ArgCategory.UnpackedDictionary) {
                    // Evaluate the expression's type so symbols are marked accessed
                    // and errors are reported.
                    getTypeOfExpression(arg.d.valueExpr);
                    return;
                }

                if (!arg.d.name) {
                    let argType: Type;

                    if (arg.d.argCategory === ArgCategory.UnpackedList) {
                        getTypeOfExpression(arg.d.valueExpr);
                        argType = UnknownType.create();
                    } else {
                        argType = getTypeOfExpression(arg.d.valueExpr, exprFlags).type;

                        if (
                            isTypeVar(argType) &&
                            argType.props?.specialForm &&
                            TypeBase.isInstance(argType.props.specialForm)
                        ) {
                            addDiagnostic(DiagnosticRule.reportGeneralTypeIssues, LocMessage.baseClassInvalid(), arg);
                            argType = UnknownType.create();
                        }

                        argType = makeTopLevelTypeVarsConcrete(argType);
                    }

                    // In some stub files, classes are conditionally defined (e.g. based
                    // on platform type). We'll assume that the conditional logic is correct
                    // and strip off the "unbound" union.
                    if (isUnion(argType)) {
                        argType = removeUnbound(argType);
                    }

                    // Any is allowed as a base class. Remove its "special form" flag to avoid
                    // false positive errors.
                    if (isAny(argType) && argType.props?.specialForm) {
                        argType = AnyType.create();
                    }

                    argType = stripTypeFormRecursive(argType);

                    if (!isAnyOrUnknown(argType) && !isUnbound(argType)) {
                        // If the specified base class is type(T), use the metaclass
                        // of T if it's known.
                        if (
                            isClass(argType) &&
                            TypeBase.getInstantiableDepth(argType) > 0 &&
                            argType.shared.effectiveMetaclass &&
                            isClass(argType.shared.effectiveMetaclass)
                        ) {
                            argType = argType.shared.effectiveMetaclass;
                        }

                        if (isMetaclassInstance(argType)) {
                            assert(isClassInstance(argType));
                            argType =
                                argType.priv.typeArgs && argType.priv.typeArgs.length > 0
                                    ? argType.priv.typeArgs[0]
                                    : UnknownType.create();
                        } else if (!isInstantiableClass(argType)) {
                            addDiagnostic(DiagnosticRule.reportGeneralTypeIssues, LocMessage.baseClassInvalid(), arg);
                            argType = UnknownType.create();
                        } else {
                            if (
                                ClassType.isPartiallyEvaluated(argType) ||
                                argType.shared.mro.some((t) => isClass(t) && ClassType.isPartiallyEvaluated(t))
                            ) {
                                // If the base class is partially evaluated, install a callback
                                // so we can fix up this class (e.g. compute the MRO) when the
                                // dependent class is completed.
                                registerDeferredClassCompletion(node, argType);
                            }

                            if (ClassType.isBuiltIn(argType, 'Protocol')) {
                                if (
                                    !fileInfo.isStubFile &&
                                    !ClassType.isTypingExtensionClass(argType) &&
                                    PythonVersion.isLessThan(
                                        fileInfo.executionEnvironment.pythonVersion,
                                        pythonVersion3_7
                                    )
                                ) {
                                    addDiagnostic(
                                        DiagnosticRule.reportInvalidTypeForm,
                                        LocMessage.protocolIllegal(),
                                        arg.d.valueExpr
                                    );
                                }
                                classType.shared.flags |= ClassTypeFlags.ProtocolClass;
                            }

                            if (ClassType.isBuiltIn(argType, 'property')) {
                                classType.shared.flags |= ClassTypeFlags.PropertyClass;
                            }

                            // If the class directly derives from NamedTuple (in Python 3.6 or
                            // newer), it's considered a (read-only) dataclass.
                            if (
                                PythonVersion.isGreaterOrEqualTo(
                                    fileInfo.executionEnvironment.pythonVersion,
                                    pythonVersion3_6
                                )
                            ) {
                                if (ClassType.isBuiltIn(argType, 'NamedTuple')) {
                                    isNamedTupleSubclass = true;
                                }
                            }

                            // If the class directly derives from TypedDict or from a class that is
                            // a TypedDict, it is considered a TypedDict.
                            if (ClassType.isBuiltIn(argType, 'TypedDict') || ClassType.isTypedDictClass(argType)) {
                                classType.shared.flags |= ClassTypeFlags.TypedDictClass;

                                // Propagate the "effectively closed" flag from base classes.
                                if (ClassType.isTypedDictEffectivelyClosed(argType)) {
                                    classType.shared.flags |= ClassTypeFlags.TypedDictEffectivelyClosed;
                                }
                            }

                            // Validate that the class isn't deriving from itself, creating a
                            // circular dependency.
                            if (derivesFromClassRecursive(argType, classType, /* ignoreUnknown */ true)) {
                                addDiagnostic(
                                    DiagnosticRule.reportGeneralTypeIssues,
                                    LocMessage.baseClassCircular(),
                                    arg
                                );
                                argType = UnknownType.create();
                            }

                            // If the class is attempting to derive from a TypeAliasType,
                            // generate an error.
                            if (
                                argType.props?.specialForm &&
                                ClassType.isBuiltIn(argType.props.specialForm, 'TypeAliasType')
                            ) {
                                addDiagnostic(
                                    DiagnosticRule.reportGeneralTypeIssues,
                                    LocMessage.typeAliasTypeBaseClass(),
                                    arg
                                );
                                argType = UnknownType.create();
                            }
                        }
                    }

                    if (isUnknown(argType)) {
                        addDiagnostic(DiagnosticRule.reportUntypedBaseClass, LocMessage.baseClassUnknown(), arg);
                    }

                    // Check for a duplicate class.
                    if (
                        classType.shared.baseClasses.some((prevBaseClass) => {
                            return (
                                isInstantiableClass(prevBaseClass) &&
                                isInstantiableClass(argType) &&
                                ClassType.isSameGenericClass(argType, prevBaseClass)
                            );
                        })
                    ) {
                        addDiagnostic(
                            DiagnosticRule.reportGeneralTypeIssues,
                            LocMessage.duplicateBaseClass(),
                            arg.d.name || arg
                        );
                    }

                    classType.shared.baseClasses.push(argType);
                    if (isInstantiableClass(argType)) {
                        if (ClassType.isEnumClass(argType)) {
                            classType.shared.flags |= ClassTypeFlags.EnumClass;
                        }

                        // Determine if the class is abstract. Protocol classes support abstract methods
                        // because they are constructed by the _ProtocolMeta metaclass, which derives
                        // from ABCMeta.
                        if (ClassType.supportsAbstractMethods(argType) || ClassType.isProtocolClass(argType)) {
                            classType.shared.flags |= ClassTypeFlags.SupportsAbstractMethods;
                        }

                        if (ClassType.isPropertyClass(argType)) {
                            classType.shared.flags |= ClassTypeFlags.PropertyClass;
                        }

                        if (ClassType.isFinal(argType)) {
                            const className = printObjectTypeForClass(argType);
                            addDiagnostic(
                                DiagnosticRule.reportGeneralTypeIssues,
                                LocMessage.baseClassFinal().format({ type: className }),
                                arg.d.valueExpr
                            );
                        }
                    }

                    addTypeVarsToListIfUnique(typeParams, getTypeVarArgsRecursive(argType));
                    if (isInstantiableClass(argType)) {
                        if (ClassType.isBuiltIn(argType, 'Generic')) {
                            // 'Generic' is implicitly added if type parameter syntax is used.
                            if (node.d.typeParams) {
                                addDiagnostic(
                                    DiagnosticRule.reportGeneralTypeIssues,
                                    LocMessage.genericBaseClassNotAllowed(),
                                    arg.d.valueExpr
                                );
                            } else {
                                if (!genericTypeParams) {
                                    if (protocolTypeParams) {
                                        addDiagnostic(
                                            DiagnosticRule.reportGeneralTypeIssues,
                                            LocMessage.duplicateGenericAndProtocolBase(),
                                            arg.d.valueExpr
                                        );
                                    }
                                    genericTypeParams = buildTypeParamsFromTypeArgs(argType);
                                }
                            }
                        } else if (
                            ClassType.isBuiltIn(argType, 'Protocol') &&
                            argType.priv.typeArgs &&
                            argType.priv.typeArgs.length > 0
                        ) {
                            if (!protocolTypeParams) {
                                if (genericTypeParams) {
                                    addDiagnostic(
                                        DiagnosticRule.reportGeneralTypeIssues,
                                        LocMessage.duplicateGenericAndProtocolBase(),
                                        arg.d.valueExpr
                                    );
                                }
                                protocolTypeParams = buildTypeParamsFromTypeArgs(argType);

                                if (node.d.typeParams && protocolTypeParams.length > 0) {
                                    addDiagnostic(
                                        DiagnosticRule.reportGeneralTypeIssues,
                                        LocMessage.protocolBaseClassWithTypeArgs(),
                                        arg.d.valueExpr
                                    );
                                    protocolTypeParams = [];
                                }
                            }
                        }
                    }
                } else if (ClassType.isTypedDictClass(classType)) {
                    if (arg.d.name.d.value === 'total' || arg.d.name.d.value === 'closed') {
                        // The "total" and "readonly" parameters apply only for TypedDict classes.
                        // PEP 589 specifies that the parameter must be either True or False.
                        const constArgValue = evaluateStaticBoolExpression(
                            arg.d.valueExpr,
                            fileInfo.executionEnvironment,
                            fileInfo.definedConstants
                        );

                        if (constArgValue === undefined) {
                            addDiagnostic(
                                DiagnosticRule.reportGeneralTypeIssues,
                                LocMessage.typedDictBoolParam().format({ name: arg.d.name.d.value }),
                                arg.d.valueExpr
                            );
                        } else if (arg.d.name.d.value === 'total' && !constArgValue) {
                            classType.shared.flags |= ClassTypeFlags.CanOmitDictValues;
                        } else if (arg.d.name.d.value === 'closed') {
                            if (constArgValue) {
                                classType.shared.flags |=
                                    ClassTypeFlags.TypedDictMarkedClosed | ClassTypeFlags.TypedDictEffectivelyClosed;

                                if (classType.shared.typedDictExtraItemsExpr) {
                                    addDiagnostic(
                                        DiagnosticRule.reportGeneralTypeIssues,
                                        LocMessage.typedDictExtraItemsClosed(),
                                        classType.shared.typedDictExtraItemsExpr
                                    );
                                }
                            } else {
                                // PEP 728: A class that subclasses from a non-open TypedDict
                                // cannot specify closed=False.
                                const nonOpenBase = classType.shared.baseClasses.find(
                                    (base) =>
                                        isInstantiableClass(base) &&
                                        ClassType.isTypedDictClass(base) &&
                                        ClassType.isTypedDictEffectivelyClosed(base)
                                );
                                if (nonOpenBase) {
                                    addDiagnostic(
                                        DiagnosticRule.reportGeneralTypeIssues,
                                        LocMessage.typedDictClosedFalseNonOpenBase().format({
                                            name: (nonOpenBase as ClassType).shared.name,
                                        }),
                                        arg.d.valueExpr
                                    );
                                }
                            }

                            if (sawClosedOrExtraItems) {
                                addDiagnostic(
                                    DiagnosticRule.reportGeneralTypeIssues,
                                    LocMessage.typedDictExtraItemsClosed(),
                                    arg.d.valueExpr
                                );
                            }

                            sawClosedOrExtraItems = true;
                        }
                    } else if (arg.d.name.d.value === 'extra_items') {
                        // Record a reference to the expression but don't evaluate it yet.
                        // It may refer to the class itself.
                        classType.shared.typedDictExtraItemsExpr = arg.d.valueExpr;
                        classType.shared.flags |= ClassTypeFlags.TypedDictEffectivelyClosed;

                        if (ClassType.isTypedDictMarkedClosed(classType)) {
                            addDiagnostic(
                                DiagnosticRule.reportGeneralTypeIssues,
                                LocMessage.typedDictExtraItemsClosed(),
                                classType.shared.typedDictExtraItemsExpr
                            );
                        }

                        if (sawClosedOrExtraItems) {
                            addDiagnostic(
                                DiagnosticRule.reportGeneralTypeIssues,
                                LocMessage.typedDictExtraItemsClosed(),
                                arg.d.valueExpr
                            );
                        }

                        sawClosedOrExtraItems = true;
                    } else {
                        addDiagnostic(
                            DiagnosticRule.reportGeneralTypeIssues,
                            LocMessage.typedDictInitsubclassParameter().format({ name: arg.d.name.d.value }),
                            arg
                        );
                    }
                } else if (arg.d.name.d.value === 'metaclass') {
                    if (metaclassNode) {
                        addDiagnostic(DiagnosticRule.reportGeneralTypeIssues, LocMessage.metaclassDuplicate(), arg);
                    } else {
                        metaclassNode = arg.d.valueExpr;
                    }
                } else {
                    // Collect arguments that will be passed to the `__init_subclass__`
                    // method described in PEP 487.
                    initSubclassArgs.push({
                        argCategory: ArgCategory.Simple,
                        node: arg,
                        name: arg.d.name,
                        valueExpression: arg.d.valueExpr,
                    });
                }
            });

            // Check for NamedTuple multiple inheritance.
            if (classType.shared.baseClasses.length > 1) {
                let derivesFromNamedTuple = false;
                let foundIllegalBaseClass = false;

                classType.shared.baseClasses.forEach((baseClass) => {
                    if (isInstantiableClass(baseClass)) {
                        if (ClassType.isBuiltIn(baseClass, 'NamedTuple')) {
                            derivesFromNamedTuple = true;
                        } else if (!ClassType.isBuiltIn(baseClass, 'Generic')) {
                            foundIllegalBaseClass = true;
                        }
                    }
                });

                if (derivesFromNamedTuple && foundIllegalBaseClass) {
                    addDiagnostic(
                        DiagnosticRule.reportGeneralTypeIssues,
                        LocMessage.namedTupleMultipleInheritance(),
                        node.d.name
                    );
                }
            }

            // Make sure we don't have 'object' derive from itself. Infinite
            // recursion will result.
            if (
                !ClassType.isBuiltIn(classType, 'object') &&
                classType.shared.baseClasses.filter((baseClass) => isClass(baseClass)).length === 0
            ) {
                // If there are no other (known) base classes, the class implicitly derives from object.
                classType.shared.baseClasses.push(getBuiltInType(node, 'object'));
            }

            // If genericTypeParams or protocolTypeParams are provided,
            // make sure that typeParams is a proper subset.
            genericTypeParams = genericTypeParams ?? protocolTypeParams;
            if (genericTypeParams && !node.d.typeParams) {
                verifyGenericTypeParams(node.d.name, typeParams, genericTypeParams);
            }
            classType.shared.typeParams = genericTypeParams ?? typeParams;

            // Determine if one or more type parameters is autovariance.
            if (
                classType.shared.typeParams.some(
                    (param) =>
                        param.shared.declaredVariance === Variance.Auto && param.priv.computedVariance === undefined
                )
            ) {
                classType.shared.requiresVarianceInference = true;
            }

            // Make sure there's at most one TypeVarTuple.
            const variadics = typeParams.filter((param) => isTypeVarTuple(param));
            if (variadics.length > 1) {
                addDiagnostic(
                    DiagnosticRule.reportGeneralTypeIssues,
                    LocMessage.variadicTypeParamTooManyClass().format({
                        names: variadics.map((v) => `"${v.shared.name}"`).join(', '),
                    }),
                    node.d.name,
                    TextRange.combine(node.d.arguments) || node.d.name
                );
            } else if (variadics.length > 0) {
                // Make sure a TypeVar with a default doesn't come after a TypeVarTuple.
                const firstVariadicIndex = typeParams.findIndex((param) => isTypeVarTuple(param));
                const typeVarWithDefaultIndex = typeParams.findIndex(
                    (param, index) =>
                        index > firstVariadicIndex && !isParamSpec(param) && param.shared.isDefaultExplicit
                );

                if (typeVarWithDefaultIndex >= 0) {
                    addDiagnostic(
                        DiagnosticRule.reportGeneralTypeIssues,
                        LocMessage.typeVarWithDefaultFollowsVariadic().format({
                            typeVarName: typeParams[typeVarWithDefaultIndex].shared.name,
                            variadicName: typeParams[firstVariadicIndex].shared.name,
                        }),
                        node.d.typeParams ? node.d.typeParams.d.params[typeVarWithDefaultIndex].d.name : node.d.name
                    );
                }
            }

            // Validate the default types for all type parameters.
            classType.shared.typeParams.forEach((typeParam, index) => {
                let bestErrorNode: ExpressionNode = node.d.name;
                if (node.d.typeParams && index < node.d.typeParams.d.params.length) {
                    const typeParamNode = node.d.typeParams.d.params[index];
                    bestErrorNode = typeParamNode.d.defaultExpr ?? typeParamNode.d.name;
                }
                validateTypeParamDefault(
                    bestErrorNode,
                    typeParam,
                    classType.shared.typeParams.slice(0, index),
                    classType.shared.typeVarScopeId!
                );
            });

            if (!computeMroLinearization(classType)) {
                addDiagnostic(DiagnosticRule.reportGeneralTypeIssues, LocMessage.methodOrdering(), node.d.name);
            }

            // The scope for this class becomes the "fields" for the corresponding type.
            const innerScope = ScopeUtils.getScopeForNode(node.d.suite);
            classType.shared.fields = innerScope?.symbolTable
                ? new Map<string, Symbol>(innerScope.symbolTable)
                : new Map<string, Symbol>();

            // Determine whether the class should inherit __hash__. If a class defines
            // __eq__ but doesn't define __hash__ then __hash__ is set to None.
            if (classType.shared.fields.has('__eq__') && !classType.shared.fields.has('__hash__')) {
                classType.shared.fields.set(
                    '__hash__',
                    Symbol.createWithType(
                        SymbolFlags.ClassMember |
                            SymbolFlags.ClassVar |
                            SymbolFlags.IgnoredForProtocolMatch |
                            SymbolFlags.IgnoredForOverrideChecks,
                        getNoneType()
                    )
                );
            }

            // Determine whether the class's instance variables are constrained
            // to those defined by __slots__. We need to do this prior to dataclass
            // processing because dataclasses can implicitly add to the slots
            // list.
            const slotsNames = innerScope?.getSlotsNames();
            if (slotsNames) {
                classType.shared.localSlotsNames = slotsNames;
            }

            // Determine if the class should be a "pseudo-generic" class, characterized
            // by having an __init__ method with parameters that lack type annotations.
            // For such classes, we'll treat them as generic, with the type arguments provided
            // by the callers of the constructor.
            if (!fileInfo.isStubFile && classType.shared.typeParams.length === 0) {
                const initMethod = classType.shared.fields.get('__init__');
                if (initMethod) {
                    const initDecls = initMethod.getTypedDeclarations();
                    if (initDecls.length === 1 && initDecls[0].type === DeclarationType.Function) {
                        const initDeclNode = initDecls[0].node;
                        const initParams = initDeclNode.d.params;

                        if (
                            initParams.length > 1 &&
                            !initParams.some(
                                (_param, index) => !!ParseTreeUtils.getTypeAnnotationForParam(initDeclNode, index)
                            )
                        ) {
                            const genericParams = initParams.filter(
                                (param, index) =>
                                    index > 0 &&
                                    param.d.name &&
                                    param.d.category === ParamCategory.Simple &&
                                    !param.d.defaultValue
                            );

                            if (genericParams.length > 0) {
                                classType.shared.flags |= ClassTypeFlags.PseudoGenericClass;

                                // Create a type parameter for each simple, named parameter
                                // in the __init__ method.
                                classType.shared.typeParams = genericParams.map((param) => {
                                    const typeVar = TypeVarType.createInstance(
                                        getPseudoGenericTypeVarName(param.d.name!.d.value)
                                    );
                                    typeVar.shared.isSynthesized = true;
                                    typeVar.priv.scopeId = ParseTreeUtils.getScopeIdForNode(initDeclNode);
                                    typeVar.shared.boundType = UnknownType.create();
                                    return TypeVarType.cloneForScopeId(
                                        typeVar,
                                        ParseTreeUtils.getScopeIdForNode(node),
                                        node.d.name.d.value,
                                        TypeVarScopeType.Class
                                    );
                                });
                            }
                        }
                    }
                }
            }

            // Determine if the class has a custom __class_getitem__ method. This applies
            // only to classes that have no type parameters, since those with type parameters
            // are assumed to follow normal subscripting semantics for generic classes.
            if (classType.shared.typeParams.length === 0 && !ClassType.isBuiltIn(classType, 'type')) {
                if (
                    classType.shared.baseClasses.some(
                        (baseClass) => isInstantiableClass(baseClass) && ClassType.hasCustomClassGetItem(baseClass)
                    ) ||
                    classType.shared.fields.has('__class_getitem__')
                ) {
                    classType.shared.flags |= ClassTypeFlags.HasCustomClassGetItem;
                }
            }

            // Determine the effective metaclass.
            if (metaclassNode) {
                let metaclassType = getTypeOfExpression(metaclassNode, exprFlags).type;
                if (isInstantiableClass(metaclassType) || isUnknown(metaclassType)) {
                    if (requiresSpecialization(metaclassType, { ignorePseudoGeneric: true })) {
                        addDiagnostic(
                            DiagnosticRule.reportGeneralTypeIssues,
                            LocMessage.metaclassIsGeneric(),
                            metaclassNode
                        );
                    }

                    // If the specified metaclass is type(T), use the metaclass
                    // of T if it's known.
                    if (
                        TypeBase.getInstantiableDepth(metaclassType) > 0 &&
                        isClass(metaclassType) &&
                        metaclassType.shared.effectiveMetaclass &&
                        isClass(metaclassType.shared.effectiveMetaclass)
                    ) {
                        metaclassType = metaclassType.shared.effectiveMetaclass;
                    }

                    classType.shared.declaredMetaclass = metaclassType;
                    if (isInstantiableClass(metaclassType)) {
                        if (isEnumMetaclass(metaclassType)) {
                            classType.shared.flags |= ClassTypeFlags.EnumClass;
                        }

                        if (derivesFromStdlibClass(metaclassType, 'ABCMeta')) {
                            classType.shared.flags |= ClassTypeFlags.SupportsAbstractMethods;
                        }
                    }
                }
            }

            const effectiveMetaclass = computeEffectiveMetaclass(classType, node.d.name);

            // Clear the "partially constructed" flag.
            classType.shared.flags &= ~ClassTypeFlags.PartiallyEvaluated;

            // Now determine the decorated type of the class.
            let decoratedType: Type = classType;
            let foundUnknown = false;

            for (let i = node.d.decorators.length - 1; i >= 0; i--) {
                const decorator = node.d.decorators[i];

                const newDecoratedType = useSignatureTracker(node.parent ?? node, () =>
                    applyClassDecorator(evaluatorInterface, decoratedType, classType, decorator)
                );
                const unknownOrAny = containsAnyOrUnknown(newDecoratedType, /* recurse */ false);

                if (unknownOrAny && isUnknown(unknownOrAny)) {
                    // Report this error only on the first unknown type.
                    if (!foundUnknown) {
                        addDiagnostic(
                            DiagnosticRule.reportUntypedClassDecorator,
                            LocMessage.classDecoratorTypeUnknown(),
                            node.d.decorators[i].d.expr
                        );

                        foundUnknown = true;
                    }
                } else {
                    // Apply the decorator only if the type is known.
                    decoratedType = newDecoratedType;
                }
            }

            // Determine whether this class derives from (or has a metaclass) that imbues
            // it with dataclass-like behaviors. If so, we'll apply those here.
            let dataClassBehaviors: DataClassBehaviors | undefined;
            if (isInstantiableClass(effectiveMetaclass) && effectiveMetaclass.shared.classDataClassTransform) {
                dataClassBehaviors = effectiveMetaclass.shared.classDataClassTransform;
            } else {
                const baseClassDataTransform = classType.shared.mro.find((mroClass) => {
                    return (
                        isClass(mroClass) &&
                        mroClass.shared.classDataClassTransform !== undefined &&
                        !ClassType.isSameGenericClass(mroClass, classType)
                    );
                });

                if (baseClassDataTransform) {
                    dataClassBehaviors = (baseClassDataTransform as ClassType).shared.classDataClassTransform;
                }
            }

            if (dataClassBehaviors) {
                applyDataClassClassBehaviorOverrides(
                    evaluatorInterface,
                    node.d.name,
                    classType,
                    initSubclassArgs,
                    dataClassBehaviors
                );
            }

            // Run any deferred class completions that depend on this class.
            runDeferredClassCompletions(classType);

            // If there are any outstanding deferred class completions registered that
            // were not removed by the call to runDeferredClassCompletions, assume that
            // the current class may depend on them and register for deferred completion.
            registerDeferredClassCompletion(node, /* dependsUpon */ undefined);

            // Synthesize TypedDict methods.
            if (ClassType.isTypedDictClass(classType)) {
                // TypedDict classes must derive only from other TypedDict classes.
                let foundInvalidBaseClass = false;
                const diag = new DiagnosticAddendum();

                classType.shared.baseClasses.forEach((baseClass) => {
                    if (
                        isClass(baseClass) &&
                        !ClassType.isTypedDictClass(baseClass) &&
                        !ClassType.isBuiltIn(baseClass, ['_TypedDict', 'TypedDictFallback', 'Generic'])
                    ) {
                        foundInvalidBaseClass = true;
                        diag.addMessage(LocAddendum.typedDictBaseClass().format({ type: baseClass.shared.name }));
                    }
                });

                if (foundInvalidBaseClass) {
                    addDiagnostic(
                        DiagnosticRule.reportGeneralTypeIssues,
                        LocMessage.typedDictBaseClass() + diag.getString(),
                        node.d.name
                    );
                }

                synthesizeTypedDictClassMethods(evaluatorInterface, node, classType);
            }

            // Synthesize dataclass methods.
            if (ClassType.isDataClass(classType) || isNamedTupleSubclass) {
                const skipSynthesizedInit = ClassType.isDataClassSkipGenerateInit(classType);
                let hasExistingInitMethod = skipSynthesizedInit;

                // See if there's already a non-synthesized __init__ method.
                // We shouldn't override it.
                if (!skipSynthesizedInit) {
                    const initSymbol = classType.shared.fields.get('__init__');
                    if (initSymbol && initSymbol.isClassMember()) {
                        hasExistingInitMethod = true;
                    }
                }

                let skipSynthesizeHash = false;
                const hashSymbol = classType.shared.fields.get('__hash__');

                // If there is a hash symbol defined in the class (i.e. one that we didn't
                // synthesize above), then we shouldn't synthesize a new one for the dataclass.
                if (hashSymbol && hashSymbol.isClassMember() && !hashSymbol.getSynthesizedType()) {
                    skipSynthesizeHash = true;
                }

                const synthesizeMethods = () =>
                    synthesizeDataClassMethods(
                        evaluatorInterface,
                        node,
                        classType,
                        isNamedTupleSubclass,
                        skipSynthesizedInit,
                        hasExistingInitMethod,
                        skipSynthesizeHash
                    );

                // If this is a NamedTuple subclass, immediately synthesize dataclass methods
                // because we also need to update the MRO classes in this case. For regular
                // dataclasses, we'll defer the  method synthesis to avoid circular dependencies.
                if (isNamedTupleSubclass) {
                    synthesizeMethods();
                } else {
                    classType.shared.synthesizeMethodsDeferred = () => {
                        delete classType.shared.synthesizeMethodsDeferred;
                        synthesizeMethods();
                    };
                }
            }

            // Build a complete list of all slots names defined by the class hierarchy.
            // This needs to be done after dataclass processing.
            classType.shared.calculateInheritedSlotsNamesDeferred = () => {
                delete classType.shared.calculateInheritedSlotsNamesDeferred;

                if (classType.shared.localSlotsNames) {
                    let isLimitedToSlots = true;
                    const extendedSlotsNames = Array.from(classType.shared.localSlotsNames);

                    classType.shared.baseClasses.forEach((baseClass) => {
                        if (isInstantiableClass(baseClass)) {
                            if (
                                !ClassType.isBuiltIn(baseClass, 'object') &&
                                !ClassType.isBuiltIn(baseClass, 'type') &&
                                !ClassType.isBuiltIn(baseClass, 'Generic')
                            ) {
                                const inheritedSlotsNames = ClassType.getInheritedSlotsNames(baseClass);
                                if (inheritedSlotsNames) {
                                    appendArray(extendedSlotsNames, inheritedSlotsNames);
                                } else {
                                    isLimitedToSlots = false;
                                }
                            }
                        } else {
                            isLimitedToSlots = false;
                        }
                    });

                    if (isLimitedToSlots) {
                        classType.shared.inheritedSlotsNamesCached = extendedSlotsNames;
                    }
                }
            };

            // If Any is defined using a class statement, treat it as a special form.
            if (node.d.name.d.value === 'Any' && fileInfo.isTypingStubFile) {
                decoratedType = AnyType.createSpecialForm();
            }

            // Update the undecorated class type.
            writeTypeCache(node.d.name, { type: classType }, EvalFlags.None);

            // Update the decorated class type.
            writeTypeCache(node, { type: decoratedType }, EvalFlags.None);

            return { classType, decoratedType };
        });
    }

    function buildTypeParamsFromTypeArgs(classType: ClassType): TypeVarType[] {
        const typeParams: TypeVarType[] = [];
        const typeArgs = classType.priv.typeArgs ?? [];

        typeArgs.forEach((typeArg, index) => {
            if (isTypeVar(typeArg)) {
                typeParams.push(typeArg);
                return;
            }

            // Synthesize a dummy type parameter.
            const typeVar = TypeVarType.createInstance(`__P${index}`);
            typeVar.shared.isSynthesized = true;
            typeParams.push(typeVar);
        });

        return typeParams;
    }

    // Determines whether the type parameters has a default that refers to another
    // type parameter. If so, validates that it is in the list of "live" type
    // parameters and updates the scope of the type parameter referred to in the
    // default type expression.
    function validateTypeParamDefault(
        errorNode: ExpressionNode,
        typeParam: TypeVarType,
        otherLiveTypeParams: TypeVarType[],
        scopeId: TypeVarScopeId
    ) {
        symbolResolution.validateTypeParamDefault(
            evaluatorInterface,
            errorNode,
            typeParam,
            otherLiveTypeParams,
            scopeId
        );
    }

    function inferVarianceForClass(classType: ClassType): void {
        symbolResolution.inferVarianceForClass(evaluatorInterface, classType);
    }

    function evaluateTypeParamList(node: TypeParameterListNode): TypeVarType[] {
        const paramTypes: TypeVarType[] = [];
        const typeParamScope = AnalyzerNodeInfo.getScope(node);

        node.d.params.forEach((param) => {
            const paramSymbol = typeParamScope?.symbolTable.get(param.d.name.d.value);
            if (!paramSymbol) {
                // This can happen if the code is unreachable.
                return;
            }

            const typeOfParam = getDeclaredTypeOfSymbol(paramSymbol, param.d.name)?.type;
            if (!typeOfParam || !isTypeVar(typeOfParam)) {
                return;
            }

            writeTypeCache(param.d.name, { type: typeOfParam }, EvalFlags.None);
            paramTypes.push(typeOfParam);
        });

        return paramTypes;
    }

    function computeEffectiveMetaclass(classType: ClassType, errorNode: ParseNode) {
        let effectiveMetaclass = classType.shared.declaredMetaclass;
        let reportedMetaclassConflict = false;

        if (!effectiveMetaclass || isInstantiableClass(effectiveMetaclass)) {
            for (const baseClass of classType.shared.baseClasses) {
                if (isInstantiableClass(baseClass)) {
                    const baseClassMeta = baseClass.shared.effectiveMetaclass ?? registry.typeClass;
                    if (baseClassMeta && isInstantiableClass(baseClassMeta)) {
                        // Make sure there is no metaclass conflict.
                        if (!effectiveMetaclass) {
                            effectiveMetaclass = baseClassMeta;
                        } else if (
                            derivesFromClassRecursive(baseClassMeta, effectiveMetaclass, /* ignoreUnknown */ false)
                        ) {
                            effectiveMetaclass = baseClassMeta;
                        } else if (
                            !derivesFromClassRecursive(effectiveMetaclass, baseClassMeta, /* ignoreUnknown */ false)
                        ) {
                            if (!reportedMetaclassConflict) {
                                const diag = new DiagnosticAddendum();

                                diag.addMessage(
                                    LocAddendum.metaclassConflict().format({
                                        metaclass1: printType(convertToInstance(effectiveMetaclass)),
                                        metaclass2: printType(convertToInstance(baseClassMeta)),
                                    })
                                );
                                addDiagnostic(
                                    DiagnosticRule.reportGeneralTypeIssues,
                                    LocMessage.metaclassConflict() + diag.getString(),
                                    errorNode
                                );

                                // Don't report more than once.
                                reportedMetaclassConflict = true;
                            }
                        }
                    } else {
                        effectiveMetaclass = baseClassMeta ? UnknownType.create() : undefined;
                        break;
                    }
                } else {
                    // If one of the base classes is unknown, then the effective
                    // metaclass is also unknowable.
                    effectiveMetaclass = UnknownType.create();
                    break;
                }
            }
        }

        // If we haven't found an effective metaclass, assume "type", which
        // is the metaclass for "object".
        if (!effectiveMetaclass) {
            const typeMetaclass = getBuiltInType(errorNode, 'type');
            effectiveMetaclass =
                typeMetaclass && isInstantiableClass(typeMetaclass) ? typeMetaclass : UnknownType.create();
        }

        classType.shared.effectiveMetaclass = effectiveMetaclass;

        return effectiveMetaclass;
    }

    // Verifies that the type variables provided outside of "Generic"
    // or "Protocol" are also provided within the "Generic". For example:
    //    class Foo(Mapping[K, V], Generic[V])
    // is illegal because K is not included in Generic.
    function verifyGenericTypeParams(
        errorNode: ExpressionNode,
        typeVars: TypeVarType[],
        genericTypeVars: TypeVarType[]
    ) {
        const missingFromGeneric = typeVars.filter((typeVar) => {
            return !genericTypeVars.some((genericTypeVar) => genericTypeVar.shared.name === typeVar.shared.name);
        });

        if (missingFromGeneric.length > 0) {
            const diag = new DiagnosticAddendum();
            diag.addMessage(
                LocAddendum.typeVarsMissing().format({
                    names: missingFromGeneric.map((typeVar) => `"${typeVar.shared.name}"`).join(', '),
                })
            );
            addDiagnostic(
                DiagnosticRule.reportGeneralTypeIssues,
                LocMessage.typeVarsNotInGenericOrProtocol() + diag.getString(),
                errorNode
            );
        }
    }

    // Records the fact that the specified class requires "deferred completion" because
    // one of its base classes has not yet been fully evaluated. If the caller passes
    // undefined for "dependsUpon", then the class is added to all outstanding deferred
    // completions.
    function registerDeferredClassCompletion(classToComplete: ClassNode, dependsUpon: ClassType | undefined) {
        if (dependsUpon) {
            // See if there is an existing entry for this dependency.
            const entry = state.deferredClassCompletions.find((e) =>
                ClassType.isSameGenericClass(e.dependsUpon, dependsUpon)
            );
            if (entry) {
                entry.classesToComplete.push(classToComplete);
            } else {
                state.deferredClassCompletions.push({ dependsUpon, classesToComplete: [classToComplete] });
            }
        } else {
            state.deferredClassCompletions.forEach((e) => {
                e.classesToComplete.push(classToComplete);
            });
        }
    }

    // Runs any registered "deferred class completions" that depend on the specified
    // class type. This allows us to complete any work that requires dependent classes
    // to be completed.
    function runDeferredClassCompletions(type: ClassType) {
        state.deferredClassCompletions.forEach((e) => {
            if (ClassType.isSameGenericClass(e.dependsUpon, type)) {
                e.classesToComplete.forEach((classNode) => {
                    const classType = readTypeCache(classNode.d.name, EvalFlags.None);
                    if (classType) {
                        completeClassTypeDeferred(classType as ClassType, classNode.d.name);
                    }
                });
            }
        });

        // Remove any completions that depend on this type.
        state.deferredClassCompletions = state.deferredClassCompletions.filter(
            (e) => !ClassType.isSameGenericClass(e.dependsUpon, type)
        );
    }

    // Recomputes the MRO and effective metaclass for the class after dependent
    // classes have been fully constructed.
    function completeClassTypeDeferred(type: ClassType, errorNode: ParseNode) {
        // Recompute the MRO linearization.
        if (!computeMroLinearization(type)) {
            addDiagnostic(DiagnosticRule.reportGeneralTypeIssues, LocMessage.methodOrdering(), errorNode);
        }

        // Recompute the effective metaclass.
        computeEffectiveMetaclass(type, errorNode);
    }

    function validateInitSubclassArgs(node: ClassNode, classType: ClassType) {
        // Collect arguments that will be passed to the `__init_subclass__`
        // method described in PEP 487 and validate it.
        const argList: Arg[] = [];

        node.d.arguments.forEach((arg) => {
            if (arg.d.name && arg.d.name.d.value !== 'metaclass') {
                argList.push({
                    argCategory: ArgCategory.Simple,
                    node: arg,
                    name: arg.d.name,
                    valueExpression: arg.d.valueExpr,
                });
            }
        });

        let newMethodMember: ClassMember | undefined;

        // See if the class has a metaclass that overrides `__new__`. If so, we
        // will validate the signature of the `__new__` method.
        if (classType.shared.effectiveMetaclass && isClass(classType.shared.effectiveMetaclass)) {
            // If the metaclass is 'type' or 'ABCMeta', we'll assume it will call through to
            // __init_subclass__, so we'll skip the `__new__` method check. We need to exclude
            // TypedDict classes here because _TypedDict uses ABCMeta as its metaclass, but its
            // typeshed definition doesn't override __init_subclass__.
            const metaclassCallsInitSubclass =
                ClassType.isBuiltIn(classType.shared.effectiveMetaclass, ['ABCMeta', 'type']) &&
                !ClassType.isTypedDictClass(classType);

            if (!metaclassCallsInitSubclass) {
                // See if the metaclass has a `__new__` method that accepts keyword parameters.
                newMethodMember = lookUpClassMember(
                    classType.shared.effectiveMetaclass,
                    '__new__',
                    MemberAccessFlags.SkipTypeBaseClass
                );
            }
        }

        if (newMethodMember) {
            const newMethodType = getTypeOfMember(newMethodMember);
            if (isFunction(newMethodType)) {
                const paramListDetails = getParamListDetails(newMethodType);

                if (paramListDetails.firstKeywordOnlyIndex !== undefined) {
                    // Build a map of the keyword-only parameters.
                    const paramMap = new Map<string, number>();
                    for (let i = paramListDetails.firstKeywordOnlyIndex; i < paramListDetails.params.length; i++) {
                        const paramInfo = paramListDetails.params[i];
                        if (
                            paramInfo.param.category === ParamCategory.Simple &&
                            paramInfo.param.name &&
                            paramInfo.kind !== ParamKind.Positional
                        ) {
                            paramMap.set(paramInfo.param.name, i);
                        }
                    }

                    argList.forEach((arg) => {
                        if (arg.argCategory === ArgCategory.Simple && arg.name) {
                            const paramIndex = paramMap.get(arg.name.d.value) ?? paramListDetails.kwargsIndex;

                            if (paramIndex !== undefined) {
                                const paramInfo = paramListDetails.params[paramIndex];
                                const argParam: ValidateArgTypeParams = {
                                    paramCategory: paramInfo.param.category,
                                    paramType: paramInfo.type,
                                    requiresTypeVarMatching: false,
                                    argument: arg,
                                    errorNode: arg.valueExpression ?? node.d.name,
                                };

                                validateArgType(
                                    argParam,
                                    new ConstraintTracker(),
                                    { type: newMethodType },
                                    { skipUnknownArgCheck: true }
                                );
                                paramMap.delete(arg.name.d.value);
                            } else {
                                addDiagnostic(
                                    DiagnosticRule.reportGeneralTypeIssues,
                                    LocMessage.paramNameMissing().format({ name: arg.name.d.value }),
                                    arg.name ?? node.d.name
                                );
                            }
                        }
                    });

                    // See if we have any remaining unmatched parameters without
                    // default values.
                    const unassignedParams: string[] = [];
                    paramMap.forEach((index, paramName) => {
                        const paramInfo = paramListDetails.params[index];
                        if (!paramInfo.defaultType) {
                            unassignedParams.push(paramName);
                        }
                    });

                    if (unassignedParams.length > 0) {
                        const missingParamNames = unassignedParams.map((p) => `"${p}"`).join(', ');
                        addDiagnostic(
                            DiagnosticRule.reportGeneralTypeIssues,
                            unassignedParams.length === 1
                                ? LocMessage.argMissingForParam().format({ name: missingParamNames })
                                : LocMessage.argMissingForParams().format({ names: missingParamNames }),
                            node.d.name
                        );
                    }
                }
            }
        } else {
            // If there was no custom metaclass __new__ method, see if there is an __init_subclass__
            // method present somewhere in the class hierarchy.
            const initSubclassMethodInfo = getTypeOfBoundMember(
                node.d.name,
                classType,
                '__init_subclass__',
                /* usage */ undefined,
                /* diag */ undefined,
                MemberAccessFlags.SkipClassMembers |
                    MemberAccessFlags.SkipOriginalClass |
                    MemberAccessFlags.SkipAttributeAccessOverride
            );

            if (initSubclassMethodInfo) {
                const initSubclassMethodType = initSubclassMethodInfo.type;

                if (initSubclassMethodType && initSubclassMethodInfo.classType) {
                    const callResult = validateCallArgs(
                        node.d.name,
                        argList,
                        { type: initSubclassMethodType },
                        /* constraints */ undefined,
                        /* skipUnknownArgCheck */ false,
                        makeInferenceContext(getNoneType())
                    );

                    if (callResult.argumentErrors) {
                        const diag = addDiagnostic(
                            DiagnosticRule.reportGeneralTypeIssues,
                            LocMessage.initSubclassCallFailed(),
                            node.d.name
                        );

                        const initSubclassFunction = isOverloaded(initSubclassMethodType)
                            ? OverloadedType.getOverloads(initSubclassMethodType)[0]
                            : initSubclassMethodType;
                        const initSubclassDecl = isFunction(initSubclassFunction)
                            ? initSubclassFunction.shared.declaration
                            : undefined;

                        if (diag && initSubclassDecl) {
                            diag.addRelatedInfo(
                                LocAddendum.initSubclassLocation().format({
                                    name: printType(convertToInstance(initSubclassMethodInfo.classType)),
                                }),
                                initSubclassDecl.uri,
                                initSubclassDecl.range
                            );
                        }
                    }
                }
            }
        }

        // Evaluate all of the expressions so they are checked and marked referenced.
        argList.forEach((arg) => {
            if (arg.valueExpression) {
                getTypeOfExpression(arg.valueExpression);
            }
        });
    }

    function getTypeOfFunction(node: FunctionNode): FunctionTypeResult | undefined {
        ensureRegistryInitialized(node);

        // Is this predecorated function type cached?
        let functionType = readTypeCache(node.d.name, EvalFlags.None);

        if (functionType) {
            if (!isFunction(functionType)) {
                // This can happen in certain rare circumstances where the
                // function declaration falls within an unreachable code block.
                return undefined;
            }

            if (FunctionType.isPartiallyEvaluated(functionType)) {
                return { functionType, decoratedType: functionType };
            }
        } else {
            functionType = getTypeOfFunctionPredecorated(node);
        }

        // Is the decorated function type cached?
        let decoratedType = readTypeCache(node, EvalFlags.None);
        if (decoratedType) {
            return { functionType, decoratedType };
        }

        // Populate the cache with a temporary value to handle recursion.
        writeTypeCache(node, { type: functionType }, /* flags */ undefined);

        // If it's an async function, wrap the return type in an Awaitable or Generator.
        // Set the "partially evaluated" flag around this logic to detect recursion.
        functionType.shared.flags |= FunctionTypeFlags.PartiallyEvaluated;
        const preDecoratedType = node.d.isAsync
            ? specialForms.createAsyncFunction(evaluatorInterface, node, functionType)
            : functionType;

        // Apply all of the decorators in reverse order.
        decoratedType = preDecoratedType;
        let foundUnknown = false;
        for (let i = node.d.decorators.length - 1; i >= 0; i--) {
            const decorator = node.d.decorators[i];

            const newDecoratedType = useSignatureTracker(node.parent ?? node, () => {
                assert(decoratedType !== undefined);
                return applyFunctionDecorator(evaluatorInterface, decoratedType, functionType, decorator, node);
            });

            const unknownOrAny = containsAnyOrUnknown(newDecoratedType, /* recurse */ false);

            if (unknownOrAny && isUnknown(unknownOrAny)) {
                // Report this error only on the first unknown type.
                if (!foundUnknown) {
                    addDiagnostic(
                        DiagnosticRule.reportUntypedFunctionDecorator,
                        LocMessage.functionDecoratorTypeUnknown(),
                        node.d.decorators[i].d.expr
                    );

                    foundUnknown = true;
                }
            } else {
                // Apply the decorator only if the type is known.
                decoratedType = newDecoratedType;
            }
        }

        // See if there are any overloads provided by previous function declarations.
        if (isFunction(decoratedType)) {
            decoratedType.shared.deprecatedMessage = functionType.shared.deprecatedMessage;

            if (FunctionType.isOverloaded(decoratedType)) {
                // Mark all the parameters as accessed.
                node.d.params.forEach((param) => {
                    markParamAccessed(param);
                });
            }
        }

        decoratedType = addOverloadsToFunctionType(evaluatorInterface, node, decoratedType);

        writeTypeCache(node, { type: decoratedType }, EvalFlags.None);

        // Now that the decorator has been applied, we can clear the
        // "partially evaluated" flag.
        functionType.shared.flags &= ~FunctionTypeFlags.PartiallyEvaluated;

        return { functionType, decoratedType };
    }

    // Evaluates the type of a "def" statement without applying an async
    // modifier or any decorators.
    function getTypeOfFunctionPredecorated(node: FunctionNode): FunctionType {
        const fileInfo = AnalyzerNodeInfo.getFileInfo(node);

        // Is this type already cached?
        const cachedFunctionType = readTypeCache(node.d.name, EvalFlags.None);

        if (cachedFunctionType && isFunction(cachedFunctionType)) {
            return cachedFunctionType;
        }

        let functionDecl: FunctionDeclaration | undefined;
        const decl = AnalyzerNodeInfo.getDeclaration(node);
        if (decl) {
            functionDecl = decl as FunctionDeclaration;
        }

        // There was no cached type, so create a new one.
        // Retrieve the containing class node if the function is a method.
        const containingClassNode = ParseTreeUtils.getEnclosingClass(node, /* stopAtFunction */ true);
        let containingClassType: ClassType | undefined;
        if (containingClassNode) {
            containingClassType = getTypeOfClass(containingClassNode)?.classType;
        }

        const functionInfo = getFunctionInfoFromDecorators(evaluatorInterface, node, !!containingClassNode);
        let functionFlags = functionInfo.flags;
        if (functionDecl?.isGenerator) {
            functionFlags |= FunctionTypeFlags.Generator;
        }

        if (fileInfo.isStubFile) {
            functionFlags |= FunctionTypeFlags.StubDefinition;
        } else if (fileInfo.isInPyTypedPackage) {
            functionFlags |= FunctionTypeFlags.PyTypedDefinition;
        }

        if (node.d.isAsync) {
            functionFlags |= FunctionTypeFlags.Async;
        }

        const functionType = FunctionType.createInstance(
            node.d.name.d.value,
            getFunctionFullName(node, fileInfo.moduleName, node.d.name.d.value),
            fileInfo.moduleName,
            functionFlags | FunctionTypeFlags.PartiallyEvaluated,
            ParseTreeUtils.getDocString(node.d.suite.d.statements)
        );

        functionType.shared.typeVarScopeId = ParseTreeUtils.getScopeIdForNode(node);
        functionType.shared.deprecatedMessage = functionInfo.deprecationMessage;
        functionType.shared.methodClass = containingClassType;

        if (node.d.name.d.value === '__init__' || node.d.name.d.value === '__new__') {
            if (containingClassNode) {
                functionType.priv.constructorTypeVarScopeId = ParseTreeUtils.getScopeIdForNode(containingClassNode);
            }
        }

        if (fileInfo.isBuiltInStubFile || fileInfo.isTypingStubFile || fileInfo.isTypingExtensionsStubFile) {
            // Mark the function as a built-in stdlib function.
            functionType.shared.flags |= FunctionTypeFlags.BuiltIn;
        }

        functionType.shared.declaration = functionDecl;

        // Allow recursion by caching and registering the partially-constructed function type.
        const scope = ScopeUtils.getScopeForNode(node);
        const functionSymbol = scope?.lookUpSymbolRecursive(node.d.name.d.value);
        if (functionDecl && functionSymbol) {
            setSymbolResolutionPartialType(functionSymbol.symbol, functionDecl, functionType);
        }

        return invalidateTypeCacheIfCanceled(() => {
            writeTypeCache(node.d.name, { type: functionType }, /* flags */ undefined);

            // Is this an "__init__" method within a pseudo-generic class? If so,
            // we'll add generic types to the constructor's parameters.
            const addGenericParamTypes =
                containingClassType &&
                ClassType.isPseudoGenericClass(containingClassType) &&
                node.d.name.d.value === '__init__';

            const paramTypes: Type[] = [];

            // Determine if the first parameter should be skipped for comment-based
            // function annotations.
            let firstCommentAnnotationIndex = 0;
            if (containingClassType && (functionType.shared.flags & FunctionTypeFlags.StaticMethod) === 0) {
                firstCommentAnnotationIndex = 1;
            }

            // If there is a function annotation comment, validate that it has the correct
            // number of parameter annotations.
            if (node.d.funcAnnotationComment && !node.d.funcAnnotationComment.d.isEllipsis) {
                const expected = node.d.params.length - firstCommentAnnotationIndex;
                const received = node.d.funcAnnotationComment.d.paramAnnotations.length;

                // For methods with "self" or "cls" parameters, the annotation list
                // can either include or exclude the annotation for the first parameter.
                if (firstCommentAnnotationIndex > 0 && received === node.d.params.length) {
                    firstCommentAnnotationIndex = 0;
                } else if (received !== expected) {
                    addDiagnostic(
                        DiagnosticRule.reportInvalidTypeForm,
                        LocMessage.annotatedParamCountMismatch().format({
                            expected,
                            received,
                        }),
                        node.d.funcAnnotationComment
                    );
                }
            }

            // If this function uses PEP 695 syntax for type parameters,
            // accumulate the list of type parameters upfront.
            const typeParamsSeen: TypeVarType[] = [];
            if (node.d.typeParams) {
                functionType.shared.typeParams = evaluateTypeParamList(node.d.typeParams).map((typeParam) =>
                    convertToInstance(typeParam)
                );
            } else {
                functionType.shared.typeParams = typeParamsSeen;
            }

            let paramsArePositionOnly = true;
            const isFirstParamClsOrSelf =
                containingClassType &&
                (FunctionType.isClassMethod(functionType) ||
                    FunctionType.isInstanceMethod(functionType) ||
                    FunctionType.isConstructorMethod(functionType));
            const firstNonClsSelfParamIndex = isFirstParamClsOrSelf ? 1 : 0;

            node.d.params.forEach((param, index) => {
                let paramType: Type | undefined;
                let annotatedType: Type | undefined;
                let paramTypeNode: ExpressionNode | undefined;

                if (param.d.name) {
                    if (index === 0 && isFirstParamClsOrSelf) {
                        // Mark "self/cls" as accessed.
                        markParamAccessed(param);
                    } else if (FunctionType.isAbstractMethod(functionType)) {
                        // Mark all parameters in abstract methods as accessed.
                        markParamAccessed(param);
                    } else if (containingClassType && ClassType.isProtocolClass(containingClassType)) {
                        // Mark all parameters in protocol methods as accessed.
                        markParamAccessed(param);
                    }
                }

                if (param.d.annotation) {
                    paramTypeNode = param.d.annotation;
                } else if (param.d.annotationComment) {
                    paramTypeNode = param.d.annotationComment;
                } else if (node.d.funcAnnotationComment && !node.d.funcAnnotationComment.d.isEllipsis) {
                    const adjustedIndex = index - firstCommentAnnotationIndex;
                    if (adjustedIndex >= 0 && adjustedIndex < node.d.funcAnnotationComment.d.paramAnnotations.length) {
                        paramTypeNode = node.d.funcAnnotationComment.d.paramAnnotations[adjustedIndex];
                    }
                }

                if (paramTypeNode) {
                    if ((functionInfo.flags & FunctionTypeFlags.NoTypeCheck) !== 0) {
                        annotatedType = UnknownType.create();
                    } else {
                        annotatedType = getTypeOfParamAnnotation(paramTypeNode, param.d.category);
                    }

                    if (annotatedType) {
                        addTypeVarsToListIfUnique(
                            typeParamsSeen,
                            getTypeVarArgsRecursive(annotatedType),
                            functionType.shared.typeVarScopeId
                        );
                    }

                    if (isTypeVarTuple(annotatedType) && !annotatedType.priv.isUnpacked) {
                        addDiagnostic(
                            DiagnosticRule.reportInvalidTypeForm,
                            LocMessage.unpackedTypeVarTupleExpected().format({
                                name1: annotatedType.shared.name,
                                name2: annotatedType.shared.name,
                            }),
                            paramTypeNode
                        );
                        annotatedType = UnknownType.create();
                    }
                }

                if (!annotatedType && addGenericParamTypes) {
                    if (
                        index > 0 &&
                        param.d.category === ParamCategory.Simple &&
                        param.d.name &&
                        !param.d.defaultValue
                    ) {
                        const typeParamName = getPseudoGenericTypeVarName(param.d.name.d.value);
                        annotatedType = containingClassType!.shared.typeParams.find(
                            (param) => param.shared.name === typeParamName
                        );
                    }
                }

                if (annotatedType) {
                    const adjustedAnnotatedType = adjustParamAnnotatedType(param, annotatedType);
                    if (adjustedAnnotatedType !== annotatedType) {
                        annotatedType = adjustedAnnotatedType;
                    }
                }

                let defaultValueType: Type | undefined;
                if (param.d.defaultValue) {
                    // If this is a stub file, a protocol, an overload, or a class
                    // whose body is a placeholder implementation, treat a "...", as
                    // an "Any" value.
                    let treatEllipsisAsAny = fileInfo.isStubFile || ParseTreeUtils.isSuiteEmpty(node.d.suite);
                    if (containingClassType && ClassType.isProtocolClass(containingClassType)) {
                        treatEllipsisAsAny = true;
                    }
                    if (FunctionType.isOverloaded(functionType) || FunctionType.isAbstractMethod(functionType)) {
                        treatEllipsisAsAny = true;
                    }

                    defaultValueType = getTypeOfExpression(
                        param.d.defaultValue,
                        treatEllipsisAsAny ? EvalFlags.ConvertEllipsisToAny : EvalFlags.None,
                        makeInferenceContext(annotatedType)
                    ).type;
                }

                if (annotatedType) {
                    // If there was both a type annotation and a default value, verify
                    // that the default value matches the annotation.
                    if (param.d.defaultValue && defaultValueType) {
                        const diagAddendum = new DiagnosticAddendum();

                        if (!assignType(annotatedType, defaultValueType, diagAddendum)) {
                            addDiagnostic(
                                DiagnosticRule.reportArgumentType,
                                LocMessage.paramAssignmentMismatch().format({
                                    sourceType: printType(defaultValueType),
                                    paramType: printType(annotatedType),
                                }) + diagAddendum.getString(),
                                param.d.defaultValue
                            );
                        }
                    }

                    paramType = annotatedType;
                }

                // Determine whether we need to insert an implied position-only parameter.
                // This is needed when a function's parameters are named using the old-style
                // way of specifying position-only parameters.
                if (index >= firstNonClsSelfParamIndex) {
                    let isImplicitPositionOnlyParam = false;

                    if (param.d.category === ParamCategory.Simple && param.d.name) {
                        if (
                            isPrivateName(param.d.name.d.value) &&
                            !node.d.params.some((p) => p.d.category === ParamCategory.Simple && !p.d.name)
                        ) {
                            isImplicitPositionOnlyParam = true;

                            // If the parameter name indicates an implicit position-only parameter
                            // but we have already seen non-position-only parameters, report an error.
                            if (
                                !paramsArePositionOnly &&
                                functionType.shared.parameters.every((p) => p.category === ParamCategory.Simple)
                            ) {
                                addDiagnostic(
                                    DiagnosticRule.reportGeneralTypeIssues,
                                    LocMessage.positionOnlyAfterNon(),
                                    param.d.name
                                );
                            }
                        }
                    } else {
                        paramsArePositionOnly = false;
                    }

                    if (
                        paramsArePositionOnly &&
                        !isImplicitPositionOnlyParam &&
                        functionType.shared.parameters.length > firstNonClsSelfParamIndex
                    ) {
                        FunctionType.addPositionOnlyParamSeparator(functionType);
                    }

                    if (!isImplicitPositionOnlyParam) {
                        paramsArePositionOnly = false;
                    }
                }

                // If there was no annotation for the parameter, infer its type if possible.
                let isTypeInferred = false;
                if (!paramTypeNode) {
                    isTypeInferred = true;
                    const inferredType = inferParamType(node, functionType.shared.flags, index, containingClassType);
                    if (inferredType) {
                        paramType = inferredType;
                    }
                }

                paramType = paramType ?? UnknownType.create();

                const functionParam = FunctionParam.create(
                    param.d.category,
                    paramType,
                    (isTypeInferred ? FunctionParamFlags.TypeInferred : FunctionParamFlags.None) |
                        (paramTypeNode ? FunctionParamFlags.TypeDeclared : FunctionParamFlags.None),
                    param.d.name ? param.d.name.d.value : undefined,
                    defaultValueType,
                    param.d.defaultValue
                );

                FunctionType.addParam(functionType, functionParam);

                if (FunctionParam.isTypeDeclared(functionParam)) {
                    addTypeVarsToListIfUnique(
                        typeParamsSeen,
                        getTypeVarArgsRecursive(paramType),
                        functionType.shared.typeVarScopeId
                    );
                }

                if (param.d.name) {
                    const variadicParamType = transformVariadicParamType(node, param.d.category, paramType);
                    paramTypes.push(variadicParamType);
                } else {
                    paramTypes.push(paramType);
                }
            });

            if (paramsArePositionOnly && functionType.shared.parameters.length > firstNonClsSelfParamIndex) {
                FunctionType.addPositionOnlyParamSeparator(functionType);
            }

            // Update the types for the nodes associated with the parameters.
            const scopeIds = ParseTreeUtils.getTypeVarScopesForNode(node);
            paramTypes.forEach((paramType, index) => {
                const paramNameNode = node.d.params[index].d.name;
                if (paramNameNode) {
                    if (isUnknown(paramType)) {
                        functionType.shared.flags |= FunctionTypeFlags.UnannotatedParams;
                    }

                    paramType = makeTypeVarsBound(paramType, scopeIds);

                    writeTypeCache(paramNameNode, { type: paramType }, EvalFlags.None);
                }
            });

            // If the function ends in P.args and P.kwargs parameters, make it exempt from
            // args/kwargs compatibility checks. This is important for protocol comparisons.
            if (paramTypes.length >= 2) {
                const paramType1 = paramTypes[paramTypes.length - 2];
                const paramType2 = paramTypes[paramTypes.length - 1];
                if (
                    isParamSpec(paramType1) &&
                    paramType1.priv.paramSpecAccess === 'args' &&
                    isParamSpec(paramType2) &&
                    paramType2.priv.paramSpecAccess === 'kwargs'
                ) {
                    functionType.shared.flags |= FunctionTypeFlags.GradualCallableForm;
                }
            }

            // If the function contains an *args and a **kwargs parameter and both
            // are annotated as Any or are unannotated, make it exempt from
            // args/kwargs compatibility checks.
            const variadicsWithAnyType = functionType.shared.parameters.filter(
                (param, index) =>
                    param.category !== ParamCategory.Simple &&
                    param.name &&
                    isAnyOrUnknown(FunctionType.getParamType(functionType, index))
            );
            if (variadicsWithAnyType.length >= 2) {
                functionType.shared.flags |= FunctionTypeFlags.GradualCallableForm;
            }

            // If there was a defined return type, analyze that first so when we
            // walk the contents of the function, return statements can be
            // validated against this type.
            const returnTypeAnnotationNode =
                node.d.returnAnnotation ?? node.d.funcAnnotationComment?.d.returnAnnotation;
            if (returnTypeAnnotationNode) {
                // Temporarily set the return type to unknown in case of recursion.
                functionType.shared.declaredReturnType = UnknownType.create();

                const returnType = getTypeOfAnnotation(returnTypeAnnotationNode, {
                    typeVarGetsCurScope: true,
                });
                functionType.shared.declaredReturnType = returnType;
            } else {
                // If there was no return type annotation and this is a type stub,
                // we have no opportunity to infer the return type, so we'll indicate
                // that it's unknown.
                if (fileInfo.isStubFile) {
                    // Special-case the __init__ method, which is commonly left without
                    // an annotated return type, but we can assume it returns None.
                    if (node.d.name.d.value === '__init__') {
                        functionType.shared.declaredReturnType = getNoneType();
                    } else {
                        functionType.shared.declaredReturnType = UnknownType.create();
                    }
                }
            }

            // Accumulate any type parameters used in the return type.
            if (functionType.shared.declaredReturnType && returnTypeAnnotationNode) {
                addTypeVarsToListIfUnique(
                    typeParamsSeen,
                    getTypeVarArgsRecursive(functionType.shared.declaredReturnType),
                    functionType.shared.typeVarScopeId
                );
            }

            // Validate the default types for all type parameters.
            functionType.shared.typeParams.forEach((typeParam, index) => {
                let bestErrorNode: ExpressionNode = node.d.name;
                if (node.d.typeParams && index < node.d.typeParams.d.params.length) {
                    const typeParamNode = node.d.typeParams.d.params[index];
                    bestErrorNode = typeParamNode.d.defaultExpr ?? typeParamNode.d.name;
                }

                validateTypeParamDefault(
                    bestErrorNode,
                    typeParam,
                    functionType.shared.typeParams.slice(0, index),
                    functionType.shared.typeVarScopeId!
                );
            });

            // Clear the "partially evaluated" flag to indicate that the functionType
            // is fully evaluated.
            functionType.shared.flags &= ~FunctionTypeFlags.PartiallyEvaluated;

            writeTypeCache(node.d.name, { type: functionType }, EvalFlags.None);

            return functionType;
        });
    }

    function markParamAccessed(param: ParameterNode) {
        if (param.d.name) {
            const symbolWithScope = lookUpSymbolRecursive(
                param.d.name,
                param.d.name.d.value,
                /* honorCodeFlow */ false
            );
            if (symbolWithScope) {
                setSymbolAccessed(AnalyzerNodeInfo.getFileInfo(param), symbolWithScope.symbol, param.d.name);
            }
        }
    }

    function adjustParamAnnotatedType(param: ParameterNode, type: Type): Type {
        // PEP 484 indicates that if a parameter has a default value of 'None'
        // the type checker should assume that the type is optional (i.e. a union
        // of the specified type and 'None'). Skip this step if the type is already
        // optional to avoid losing alias names when combining the types.
        if (
            param.d.defaultValue?.nodeType === ParseNodeType.Constant &&
            param.d.defaultValue.d.constType === KeywordType.None &&
            !isOptionalType(type) &&
            !AnalyzerNodeInfo.getFileInfo(param).diagnosticRuleSet.strictParameterNoneValue
        ) {
            return combineTypes([type, getNoneType()]);
        }

        return type;
    }

    // Attempts to infer an unannotated parameter type from available context.
    function inferParamType(
        functionNode: FunctionNode,
        functionFlags: FunctionTypeFlags,
        paramIndex: number,
        containingClassType: ClassType | undefined
    ) {
        // Is the function a method within a class? If so, see if a base class
        // defines the same method and provides annotations.
        if (containingClassType) {
            if (paramIndex === 0) {
                if ((functionFlags & FunctionTypeFlags.StaticMethod) === 0) {
                    const hasClsParam =
                        (functionFlags & (FunctionTypeFlags.ClassMethod | FunctionTypeFlags.ConstructorMethod)) !== 0;
                    return synthesizeTypeVarForSelfCls(containingClassType, hasClsParam);
                }
            }

            const methodName = functionNode.d.name.d.value;

            const baseClassMemberInfo = lookUpClassMember(
                containingClassType,
                methodName,
                MemberAccessFlags.SkipOriginalClass
            );

            if (baseClassMemberInfo) {
                const memberDecls = baseClassMemberInfo.symbol.getDeclarations();
                if (memberDecls.length === 1 && memberDecls[0].type === DeclarationType.Function) {
                    const baseClassMethodNode = memberDecls[0].node;

                    // Does the signature match exactly with the exception of annotations?
                    if (
                        baseClassMethodNode.d.params.length === functionNode.d.params.length &&
                        baseClassMethodNode.d.params.every((param, index) => {
                            const overrideParam = functionNode.d.params[index];
                            return (
                                overrideParam.d.name?.d.value === param.d.name?.d.value &&
                                overrideParam.d.category === param.d.category
                            );
                        })
                    ) {
                        const baseClassParam = baseClassMethodNode.d.params[paramIndex];
                        const baseClassParamAnnotation =
                            baseClassParam.d.annotation ?? baseClassParam.d.annotationComment;
                        if (baseClassParamAnnotation) {
                            let inferredParamType = getTypeOfParamAnnotation(
                                baseClassParamAnnotation,
                                functionNode.d.params[paramIndex].d.category
                            );

                            // If the parameter type is generic, specialize it in the context
                            // of the child class.
                            if (requiresSpecialization(inferredParamType) && isClass(baseClassMemberInfo.classType)) {
                                const scopeIds: TypeVarScopeId[] = getTypeVarScopeIds(baseClassMemberInfo.classType);
                                const solution = buildSolutionFromSpecializedClass(baseClassMemberInfo.classType);

                                scopeIds.push(ParseTreeUtils.getScopeIdForNode(baseClassMethodNode));

                                // Replace any unsolved TypeVars with Unknown (including all function-scoped TypeVars).
                                inferredParamType = applySolvedTypeVars(inferredParamType, solution, {
                                    replaceUnsolved: {
                                        scopeIds,
                                        tupleClassType: getTupleClassType(),
                                    },
                                });
                            }

                            const fileInfo = AnalyzerNodeInfo.getFileInfo(functionNode);
                            if (fileInfo.isInPyTypedPackage && !fileInfo.isStubFile) {
                                inferredParamType = TypeBase.cloneForAmbiguousType(inferredParamType);
                            }

                            return inferredParamType;
                        }
                    }
                }
            }
        }

        // If the parameter has a default argument value, we may be able to infer its
        // type from this information.
        const paramValueExpr = functionNode.d.params[paramIndex].d.defaultValue;
        if (paramValueExpr) {
            return inferParamTypeFromDefaultValue(paramValueExpr);
        }

        return undefined;
    }

    function inferParamTypeFromDefaultValue(paramValueExpr: ExpressionNode) {
        const defaultValueType = getTypeOfExpression(paramValueExpr, EvalFlags.ConvertEllipsisToAny).type;

        let inferredParamType: Type | undefined;

        // Is the default value a "None", a sentinel, or an instance of some private
        // class (one whose name starts with an underscore)? If so, we will assume
        // that the value is a singleton sentinel. The actual supported type is
        // going to be a union of this type and Unknown.
        if (
            isNoneInstance(defaultValueType) ||
            isSentinelLiteral(defaultValueType) ||
            (isClassInstance(defaultValueType) && isPrivateOrProtectedName(defaultValueType.shared.name))
        ) {
            inferredParamType = combineTypes([defaultValueType, UnknownType.create()]);
        } else {
            let skipInference = false;

            if (isFunctionOrOverloaded(defaultValueType)) {
                // Do not infer parameter types that use a lambda or another function as a
                // default value. We're likely to generate false positives in this case.
                // It's not clear whether parameters should be positional-only or not.
                skipInference = true;
            } else if (
                isClassInstance(defaultValueType) &&
                ClassType.isBuiltIn(defaultValueType, ['tuple', 'list', 'set', 'dict'])
            ) {
                // Do not infer certain types like tuple because it's likely to be
                // more restrictive (narrower) than intended.
                skipInference = true;
            }

            if (!skipInference) {
                inferredParamType = convertSpecialFormToRuntimeValue(
                    defaultValueType,
                    EvalFlags.None,
                    /* convertModule */ true
                );
                inferredParamType = stripTypeForm(inferredParamType);
                inferredParamType = stripLiteralValue(inferredParamType);
            }
        }

        if (inferredParamType) {
            const fileInfo = AnalyzerNodeInfo.getFileInfo(paramValueExpr);
            if (fileInfo.isInPyTypedPackage && !fileInfo.isStubFile) {
                inferredParamType = TypeBase.cloneForAmbiguousType(inferredParamType);
            }
        }

        return inferredParamType;
    }

    // Transforms the parameter type based on its category. If it's a simple parameter,
    // no transform is applied. If it's a var-arg or keyword-arg parameter, the type
    // is wrapped in a List or Dict.
    function transformVariadicParamType(node: ParseNode, paramCategory: ParamCategory, type: Type): Type {
        switch (paramCategory) {
            case ParamCategory.Simple: {
                return type;
            }

            case ParamCategory.ArgsList: {
                if (isParamSpec(type) && type.priv.paramSpecAccess) {
                    return type;
                }

                if (isUnpackedClass(type)) {
                    return ClassType.cloneForPacked(type);
                }

                return makeTupleObject(evaluatorInterface, [{ type, isUnbounded: !isTypeVarTuple(type) }]);
            }

            case ParamCategory.KwargsDict: {
                // Leave a ParamSpec alone.
                if (isParamSpec(type) && type.priv.paramSpecAccess) {
                    return type;
                }

                // Is this an unpacked TypedDict? If so, return its packed version.
                if (isClassInstance(type) && ClassType.isTypedDictClass(type) && type.priv.isUnpacked) {
                    return ClassType.cloneForPacked(type);
                }

                // Wrap the type in a dict with str keys.
                const dictType = getBuiltInType(node, 'dict');
                const strType = getBuiltInObject(node, 'str');

                if (isInstantiableClass(dictType) && isClassInstance(strType)) {
                    return ClassType.cloneAsInstance(ClassType.specialize(dictType, [strType, type]));
                }

                return UnknownType.create();
            }
        }
    }

    function evaluateTypesForForStatement(node: ForNode): void {
        if (isTypeCached(node)) {
            return;
        }

        const iteratorTypeResult = getTypeOfExpression(node.d.iterableExpr);
        const iteratedType =
            getTypeOfIterator(iteratorTypeResult, !!node.d.isAsync, node.d.iterableExpr)?.type ?? UnknownType.create();

        assignTypeToExpression(
            node.d.targetExpr,
            { type: iteratedType, isIncomplete: iteratorTypeResult.isIncomplete },
            node.d.targetExpr
        );

        writeTypeCache(node, { type: iteratedType, isIncomplete: !!iteratorTypeResult.isIncomplete }, EvalFlags.None);
    }

    function evaluateTypesForExceptStatement(node: ExceptNode): void {
        // This should be called only if the except node has a target exception.
        assert(node.d.typeExpr !== undefined);

        if (isTypeCached(node)) {
            return;
        }

        const exceptionTypeResult = getTypeOfExpression(node.d.typeExpr!);
        const exceptionTypes = exceptionTypeResult.type;
        let includesBaseException = false;

        function getExceptionType(exceptionType: Type, errorNode: ExpressionNode) {
            exceptionType = makeTopLevelTypeVarsConcrete(exceptionType);

            if (isAnyOrUnknown(exceptionType)) {
                return exceptionType;
            }

            if (isInstantiableClass(exceptionType)) {
                if (ClassType.isBuiltIn(exceptionType, 'BaseException')) {
                    includesBaseException = true;
                }
                return ClassType.cloneAsInstance(exceptionType);
            }

            if (isClassInstance(exceptionType)) {
                const iterableType =
                    getTypeOfIterator(
                        { type: exceptionType, isIncomplete: exceptionTypeResult.isIncomplete },
                        /* isAsync */ false,
                        errorNode,
                        /* emitNotIterableError */ false
                    )?.type ?? UnknownType.create();

                return mapSubtypes(iterableType, (subtype) => {
                    if (isAnyOrUnknown(subtype)) {
                        return subtype;
                    }

                    return UnknownType.create();
                });
            }

            return UnknownType.create();
        }

        let targetType = mapSubtypes(exceptionTypes, (subType) => {
            // If more than one type was specified for the exception, we'll receive
            // a specialized tuple object here.
            const tupleType = getSpecializedTupleType(subType);
            if (tupleType && tupleType.priv.tupleTypeArgs) {
                const entryTypes = tupleType.priv.tupleTypeArgs.map((t) => {
                    return getExceptionType(t.type, node.d.typeExpr!);
                });
                return combineTypes(entryTypes);
            }

            return getExceptionType(subType, node.d.typeExpr!);
        });

        // If this is an except group, wrap the exception type in an ExceptionGroup
        // or BaseExceptionGroup depending on whether the target exception is
        // a BaseException.
        if (node.d.isExceptGroup) {
            targetType = getBuiltInObject(node, includesBaseException ? 'BaseExceptionGroup' : 'ExceptionGroup', [
                targetType,
            ]);
        }

        if (node.d.name) {
            assignTypeToExpression(node.d.name, { type: targetType }, node.d.name);
        }

        writeTypeCache(node, { type: targetType }, EvalFlags.None);
    }

    function evaluateTypesForWithStatement(node: WithItemNode): void {
        if (isTypeCached(node)) {
            return;
        }

        const exprTypeResult = getTypeOfExpression(node.d.expr);
        let isIncomplete = exprTypeResult.isIncomplete;
        let exprType = exprTypeResult.type;
        const isAsync = node.parent && node.parent.nodeType === ParseNodeType.With && !!node.parent.d.isAsync;

        if (isOptionalType(exprType)) {
            addDiagnostic(
                DiagnosticRule.reportOptionalContextManager,
                isAsync ? LocMessage.noneNotUsableWithAsync() : LocMessage.noneNotUsableWith(),
                node.d.expr
            );
            exprType = removeNoneFromUnion(exprType);
        }

        // Verify that the target has an __enter__ or __aenter__ method defined.
        const enterMethodName = isAsync ? '__aenter__' : '__enter__';
        const scopedType = mapSubtypes(exprType, (subtype) => {
            subtype = makeTopLevelTypeVarsConcrete(subtype);

            if (isAnyOrUnknown(subtype)) {
                return subtype;
            }

            const enterDiag = new DiagnosticAddendum();

            if (isClass(subtype)) {
                const enterTypeResult = getTypeOfMagicMethodCall(
                    subtype,
                    enterMethodName,
                    [],
                    node.d.expr,
                    /* inferenceContext */ undefined,
                    enterDiag.createAddendum()
                );

                if (enterTypeResult) {
                    if (isAsync) {
                        if (enterTypeResult.isIncomplete) {
                            isIncomplete = true;
                        }

                        const asyncResult = getTypeOfAwaitable({ type: enterTypeResult.type }, node.d.expr);
                        if (asyncResult.isIncomplete) {
                            isIncomplete = true;
                        }

                        return asyncResult.type;
                    }
                    return enterTypeResult.type;
                }

                if (!isAsync) {
                    if (
                        getTypeOfMagicMethodCall(
                            subtype,
                            '__aenter__',
                            [],
                            node.d.expr,
                            /* inferenceContext */ undefined
                        )?.type
                    ) {
                        enterDiag.addMessage(LocAddendum.asyncHelp());
                    }
                }
            }

            const message = isAsync ? LocMessage.typeNotUsableWithAsync() : LocMessage.typeNotUsableWith();
            addDiagnostic(
                DiagnosticRule.reportGeneralTypeIssues,
                message.format({ type: printType(subtype), method: enterMethodName }) + enterDiag.getString(),
                node.d.expr
            );
            return UnknownType.create();
        });

        // Verify that the target has an __exit__ or __aexit__ method defined.
        const exitMethodName = isAsync ? '__aexit__' : '__exit__';
        const exitDiag = new DiagnosticAddendum();

        doForEachSubtype(exprType, (subtype) => {
            subtype = makeTopLevelTypeVarsConcrete(subtype);

            if (isAnyOrUnknown(subtype)) {
                return;
            }

            if (isClass(subtype)) {
                const anyArg: TypeResult = { type: AnyType.create() };
                const exitTypeResult = getTypeOfMagicMethodCall(
                    subtype,
                    exitMethodName,
                    [anyArg, anyArg, anyArg],
                    node.d.expr,
                    /* inferenceContext */ undefined,
                    exitDiag
                );

                if (exitTypeResult) {
                    if (exitTypeResult.isIncomplete) {
                        isIncomplete = true;
                    }

                    if (isAsync) {
                        const asyncResult = getTypeOfAwaitable({ type: exitTypeResult.type }, node.d.expr);
                        if (asyncResult.isIncomplete) {
                            isIncomplete = true;
                        }

                        return asyncResult.type;
                    }

                    return exitTypeResult.type;
                }
            }

            addDiagnostic(
                DiagnosticRule.reportGeneralTypeIssues,
                LocMessage.typeNotUsableWith().format({ type: printType(subtype), method: exitMethodName }) +
                    exitDiag.getString(),
                node.d.expr
            );
            return UnknownType.create();
        });

        if (node.d.target) {
            assignTypeToExpression(node.d.target, { type: scopedType, isIncomplete }, node.d.target);
        }

        writeTypeCache(node, { type: scopedType, isIncomplete }, EvalFlags.None);
    }

    function evaluateTypesForImportAs(node: ImportAsNode): void {
        if (isTypeCached(node)) {
            return;
        }

        let symbolNameNode: NameNode;
        if (node.d.alias) {
            // The symbol name is defined by the alias.
            symbolNameNode = node.d.alias;
        } else {
            // There was no alias, so we need to use the first element of
            // the name parts as the symbol.
            symbolNameNode = node.d.module.d.nameParts[0];
        }

        if (!symbolNameNode) {
            // This can happen in certain cases where there are parse errors.
            return;
        }

        // Look up the symbol to find the alias declaration.
        let symbolType = getAliasedSymbolTypeForName(node, symbolNameNode.d.value) ?? UnknownType.create();

        // Is there a cached module type associated with this node? If so, use
        // it instead of the type we just created.
        const cachedModuleType = readTypeCache(node, EvalFlags.None) as ModuleType;
        if (cachedModuleType && isModule(cachedModuleType) && symbolType) {
            if (isTypeSame(symbolType, cachedModuleType)) {
                symbolType = cachedModuleType;
            }
        }

        assignTypeToNameNode(symbolNameNode, { type: symbolType }, /* ignoreEmptyContainers */ false);

        writeTypeCache(node, { type: symbolType }, EvalFlags.None);
    }

    function evaluateTypesForImportFromAs(node: ImportFromAsNode): void {
        if (isTypeCached(node)) {
            return;
        }

        const aliasNode = node.d.alias || node.d.name;
        const fileInfo = AnalyzerNodeInfo.getFileInfo(node);

        // If this is a redundant form of an import, assume it is an intentional
        // export and mark the symbol as accessed.
        if (node.d.alias?.d.value === node.d.name.d.value) {
            const symbolInScope = lookUpSymbolRecursive(node, node.d.name.d.value, /* honorCodeFlow */ true);
            if (symbolInScope) {
                setSymbolAccessed(fileInfo, symbolInScope.symbol, node);
            }
        }

        // If this is an import into a class scope, mark the symbol as accessed.
        const classNode = ParseTreeUtils.getEnclosingClass(node, /* stopAtFunction */ true);
        if (classNode) {
            const symbolInScope = lookUpSymbolRecursive(node, aliasNode.d.value, /* honorCodeFlow */ true);
            if (symbolInScope) {
                setSymbolAccessed(fileInfo, symbolInScope.symbol, node);
            }
        }

        let symbolType = getAliasedSymbolTypeForName(node, aliasNode.d.value);
        if (!symbolType) {
            const parentNode = node.parent as ImportFromNode;
            assert(parentNode && parentNode.nodeType === ParseNodeType.ImportFrom);
            assert(!parentNode.d.isWildcardImport);

            const importInfo = AnalyzerNodeInfo.getImportInfo(parentNode.d.module);
            if (importInfo && importInfo.isImportFound && !importInfo.isNativeLib) {
                const resolvedPath = importInfo.resolvedUris[importInfo.resolvedUris.length - 1];

                const importLookupInfo = importLookup(resolvedPath);
                let reportError = false;

                // If we were able to resolve the import, report the error as
                // an unresolved symbol.
                if (importLookupInfo) {
                    reportError = true;

                    // Handle PEP 562 support for module-level __getattr__ function,
                    // introduced in Python 3.7.
                    if (
                        PythonVersion.isGreaterOrEqualTo(
                            fileInfo.executionEnvironment.pythonVersion,
                            pythonVersion3_7
                        ) ||
                        fileInfo.isStubFile
                    ) {
                        const getAttrSymbol = importLookupInfo.symbolTable.get('__getattr__');
                        if (getAttrSymbol) {
                            const getAttrType = getEffectiveTypeOfSymbol(getAttrSymbol);
                            if (isFunction(getAttrType)) {
                                symbolType = getEffectiveReturnType(getAttrType);
                                reportError = false;
                            }
                        }
                    }
                } else if (resolvedPath.isEmpty()) {
                    // This corresponds to the "from . import a" form.
                    reportError = true;
                }

                if (reportError) {
                    addDiagnostic(
                        DiagnosticRule.reportAttributeAccessIssue,
                        LocMessage.importSymbolUnknown().format({ name: node.d.name.d.value }),
                        node.d.name
                    );
                }
            }

            if (!symbolType) {
                symbolType = UnknownType.create();
            }
        }

        assignTypeToNameNode(aliasNode, { type: symbolType }, /* ignoreEmptyContainers */ false);
        writeTypeCache(node, { type: symbolType }, EvalFlags.None);
    }

    function evaluateTypesForMatchStatement(node: MatchNode): void {
        if (isTypeCached(node)) {
            return;
        }

        const subjectTypeResult = getTypeOfExpression(node.d.expr);
        let subjectType = subjectTypeResult.type;

        // Apply negative narrowing for each of the cases that doesn't have a guard statement.
        for (const caseStatement of node.d.cases) {
            if (!caseStatement.d.guardExpr) {
                subjectType = narrowTypeBasedOnPattern(
                    evaluatorInterface,
                    subjectType,
                    caseStatement.d.pattern,
                    /* isPositiveTest */ false
                );
            }
        }

        writeTypeCache(node, { type: subjectType, isIncomplete: !!subjectTypeResult.isIncomplete }, EvalFlags.None);
    }

    function evaluateTypesForCaseStatement(node: CaseNode): void {
        if (isTypeCached(node)) {
            return;
        }

        if (!node.parent || node.parent.nodeType !== ParseNodeType.Match) {
            fail('Expected parent of case statement to be match statement');
        }

        const fileInfo = AnalyzerNodeInfo.getFileInfo(node);
        const subjectTypeResult = getTypeOfExpression(node.parent.d.expr);
        let subjectType = subjectTypeResult.type;

        // Apply negative narrowing for each of the cases prior to the current one
        // except for those that have a guard expression.
        for (const caseStatement of node.parent.d.cases) {
            if (caseStatement === node) {
                if (fileInfo.diagnosticRuleSet.reportUnnecessaryComparison !== 'none') {
                    if (!subjectTypeResult.isIncomplete) {
                        checkForUnusedPattern(evaluatorInterface, node.d.pattern, subjectType);
                    }
                }
                break;
            }

            if (!caseStatement.d.guardExpr) {
                subjectType = narrowTypeBasedOnPattern(
                    evaluatorInterface,
                    subjectType,
                    caseStatement.d.pattern,
                    /* isPositiveTest */ false
                );
            }
        }

        const narrowedSubjectType = assignTypeToPatternTargets(
            evaluatorInterface,
            subjectType,
            !!subjectTypeResult.isIncomplete,
            node.d.pattern
        );

        writeTypeCache(
            node,
            { type: narrowedSubjectType, isIncomplete: !!subjectTypeResult.isIncomplete },
            EvalFlags.None
        );
    }

    function evaluateTypesForImportFrom(node: ImportFromNode): void {
        if (isTypeCached(node)) {
            return;
        }

        if (node.d.isWildcardImport) {
            // Write back a dummy type so we don't evaluate this node again.
            writeTypeCache(node, { type: AnyType.create() }, EvalFlags.None);

            const flowNode = AnalyzerNodeInfo.getFlowNode(node);
            if (flowNode && (flowNode.flags & FlowFlags.WildcardImport) !== 0) {
                const wildcardFlowNode = flowNode as FlowWildcardImport;
                wildcardFlowNode.names.forEach((name) => {
                    const importedSymbolType = getAliasedSymbolTypeForName(node, name);

                    if (!importedSymbolType) {
                        return;
                    }

                    const symbolWithScope = lookUpSymbolRecursive(node, name, /* honorCodeFlow */ false);
                    if (!symbolWithScope) {
                        return;
                    }

                    const declaredType = getDeclaredTypeOfSymbol(symbolWithScope.symbol)?.type;
                    if (!declaredType) {
                        return;
                    }

                    const diagAddendum = new DiagnosticAddendum();

                    if (!assignType(declaredType, importedSymbolType, diagAddendum)) {
                        addDiagnostic(
                            DiagnosticRule.reportAssignmentType,
                            LocMessage.typeAssignmentMismatchWildcard().format({
                                ...printSrcDestTypes(importedSymbolType, declaredType),
                                name,
                            }) + diagAddendum.getString(),
                            node,
                            node.d.wildcardToken ?? node
                        );
                    }
                });
            }
        } else {
            // Use the first element of the name parts as the symbol.
            const symbolNameNode = node.d.module.d.nameParts[0];

            // Look up the symbol to find the alias declaration.
            let symbolType = getAliasedSymbolTypeForName(node, symbolNameNode.d.value);
            if (!symbolType) {
                return;
            }

            // Is there a cached module type associated with this node? If so, use
            // it instead of the type we just created.
            const cachedModuleType = readTypeCache(node, EvalFlags.None) as ModuleType;
            if (cachedModuleType && isModule(cachedModuleType) && symbolType) {
                if (isTypeSame(symbolType, cachedModuleType)) {
                    symbolType = cachedModuleType;
                }
            }

            assignTypeToNameNode(symbolNameNode, { type: symbolType }, /* ignoreEmptyContainers */ false);

            writeTypeCache(node, { type: symbolType }, EvalFlags.None);
        }
    }

    function evaluateTypesForTypeAnnotationNode(node: TypeAnnotationNode) {
        // If this node is part of an assignment statement, use specialized
        // logic that performs bidirectional inference and assignment
        // type narrowing.
        if (node.parent?.nodeType === ParseNodeType.Assignment) {
            evaluateTypesForAssignmentStatement(node.parent);
        } else {
            const annotationType = getTypeOfAnnotation(node.d.annotation, {
                varTypeAnnotation: true,
                allowFinal: isFinalAllowedForAssignmentTarget(node.d.valueExpr),
                allowClassVar: isClassVarAllowedForAssignmentTarget(node.d.valueExpr),
            });

            writeTypeCache(node.d.valueExpr, { type: annotationType }, EvalFlags.None);
        }
    }

    function getAliasedSymbolTypeForName(
        node: ImportAsNode | ImportFromAsNode | ImportFromNode,
        name: string
    ): Type | undefined {
        return symbolResolution.getAliasedSymbolTypeForName(evaluatorInterface, state, node, name);
    }

    // In some cases, an expression must be evaluated in the context of another
    // expression or statement that contains it. This contextual evaluation
    // allows for bidirectional type evaluation.
    function evaluateTypesForExpressionInContext(node: ExpressionNode): void {
        // Check for a couple of special cases where the node is a NameNode but
        // is technically not part of an expression. We'll handle these here so
        // callers don't need to include special-case logic.
        if (node.nodeType === ParseNodeType.Name && node.parent) {
            if (node.parent.nodeType === ParseNodeType.Function && node.parent.d.name === node) {
                getTypeOfFunction(node.parent);
                return;
            }

            if (node.parent.nodeType === ParseNodeType.Class && node.parent.d.name === node) {
                getTypeOfClass(node.parent);
                return;
            }

            if (node.parent.nodeType === ParseNodeType.ImportFromAs) {
                evaluateTypesForImportFromAs(node.parent);
                return;
            }

            if (node.parent.nodeType === ParseNodeType.ImportAs) {
                evaluateTypesForImportAs(node.parent);
                return;
            }

            if (node.parent.nodeType === ParseNodeType.TypeAlias && node.parent.d.name === node) {
                getTypeOfTypeAlias(node.parent);
                return;
            }

            if (node.parent.nodeType === ParseNodeType.Global || node.parent.nodeType === ParseNodeType.Nonlocal) {
                // For global and nonlocal statements, allow forward references so
                // we don't use code flow during symbol lookups.
                getTypeOfExpression(node, EvalFlags.ForwardRefs);
                return;
            }

            if (node.parent.nodeType === ParseNodeType.ModuleName) {
                // A name within a module name isn't an expression,
                // so there's nothing we can evaluate here.
                return;
            }
        }

        // If the expression is part of a type annotation, we need to evaluate
        // it with special evaluation flags.
        const annotationNode = ParseTreeUtils.getParentAnnotationNode(node);
        if (annotationNode) {
            // Annotations need to be evaluated with specialized evaluation flags.
            const annotationParent = annotationNode.parent;
            assert(annotationParent !== undefined);

            if (annotationParent.nodeType === ParseNodeType.Assignment) {
                if (annotationNode === annotationParent.d.annotationComment) {
                    getTypeOfAnnotation(annotationNode, {
                        varTypeAnnotation: true,
                        allowFinal: isFinalAllowedForAssignmentTarget(annotationParent.d.leftExpr),
                        allowClassVar: isClassVarAllowedForAssignmentTarget(annotationParent.d.leftExpr),
                    });
                } else {
                    evaluateTypesForAssignmentStatement(annotationParent);
                }
                return;
            }

            if (annotationParent.nodeType === ParseNodeType.TypeAnnotation) {
                evaluateTypesForTypeAnnotationNode(annotationParent);
                return;
            }

            if (
                annotationParent.nodeType === ParseNodeType.Function &&
                annotationNode === annotationParent.d.returnAnnotation
            ) {
                getTypeOfAnnotation(annotationNode, {
                    typeVarGetsCurScope: true,
                });
                return;
            }

            getTypeOfAnnotation(annotationNode, {
                varTypeAnnotation: annotationNode.parent?.nodeType === ParseNodeType.TypeAnnotation,
                allowUnpackedTuple:
                    annotationParent.nodeType === ParseNodeType.Parameter &&
                    annotationParent.d.category === ParamCategory.ArgsList,
                allowUnpackedTypedDict:
                    annotationParent.nodeType === ParseNodeType.Parameter &&
                    annotationParent.d.category === ParamCategory.KwargsDict,
            });
            return;
        }

        // See if the expression is part of a pattern used in a case statement.
        const possibleCaseNode = ParseTreeUtils.getParentNodeOfType<CaseNode>(node, ParseNodeType.Case);
        if (possibleCaseNode) {
            if (ParseTreeUtils.isNodeContainedWithin(node, possibleCaseNode.d.pattern)) {
                evaluateTypesForCaseStatement(possibleCaseNode);
                return;
            }
        }

        // Scan up the parse tree until we find a node that doesn't
        // require any context to be evaluated.
        let nodeToEvaluate: ExpressionNode = node;
        let flags = EvalFlags.None;

        while (true) {
            // If we're within an argument node in a call or index expression, skip
            // all of the nodes between because the entire argument expression
            // needs to be evaluated contextually.
            const argumentNode = ParseTreeUtils.getParentNodeOfType(nodeToEvaluate, ParseNodeType.Argument);
            if (argumentNode && argumentNode !== nodeToEvaluate) {
                assert(argumentNode.parent !== undefined);

                if (
                    argumentNode.parent.nodeType === ParseNodeType.Call ||
                    argumentNode.parent.nodeType === ParseNodeType.Index
                ) {
                    nodeToEvaluate = argumentNode.parent;
                    continue;
                }

                if (argumentNode.parent.nodeType === ParseNodeType.Class) {
                    // If this is an argument node within a class declaration,
                    // evaluate the full class declaration node.
                    getTypeOfClass(argumentNode.parent);
                    return;
                }
            }

            let parent = nodeToEvaluate.parent;
            if (!parent) {
                break;
            }

            // If this is the target of an assignment expression, evaluate the
            // assignment expression node instead.
            if (parent.nodeType === ParseNodeType.AssignmentExpression && nodeToEvaluate === parent.d.name) {
                nodeToEvaluate = parent;
                continue;
            }

            // Forward-declared type annotation expressions need to be be evaluated
            // in context so they have the appropriate flags set. Most of these cases
            // will have been detected above when calling getParentAnnotationNode,
            // but TypeAlias expressions are not handled there.
            const stringEnclosure = ParseTreeUtils.getParentNodeOfType(parent, ParseNodeType.StringList);
            if (stringEnclosure) {
                nodeToEvaluate = stringEnclosure as StringListNode;
                continue;
            }

            // The left expression of a call or member access expression is not generally contextual.
            if (parent.nodeType === ParseNodeType.Call || parent.nodeType === ParseNodeType.MemberAccess) {
                if (nodeToEvaluate === parent.d.leftExpr) {
                    // Handle the special case where the LHS is a call to super().
                    if (
                        nodeToEvaluate.nodeType === ParseNodeType.Call &&
                        nodeToEvaluate.d.leftExpr.nodeType === ParseNodeType.Name &&
                        nodeToEvaluate.d.leftExpr.d.value === 'super'
                    ) {
                        nodeToEvaluate = parent;
                        continue;
                    }

                    // Handle the special case where the LHS is a call to a lambda.
                    if (parent.nodeType === ParseNodeType.Call && nodeToEvaluate.nodeType === ParseNodeType.Lambda) {
                        nodeToEvaluate = parent;
                        continue;
                    }

                    flags = EvalFlags.CallBaseDefaults;
                    break;
                }
            } else if (parent.nodeType === ParseNodeType.Index) {
                // The base expression of an index expression is not contextual.
                if (nodeToEvaluate === parent.d.leftExpr) {
                    flags = EvalFlags.IndexBaseDefaults;
                }
            }

            if (!isExpressionNode(parent)) {
                // If we've hit a non-expression node, we generally want to
                // stop. However, there are a few special "pass through"
                // node types that we can skip over to get to a known
                // expression node.
                if (
                    parent.nodeType === ParseNodeType.DictionaryKeyEntry ||
                    parent.nodeType === ParseNodeType.DictionaryExpandEntry ||
                    parent.nodeType === ParseNodeType.ComprehensionFor ||
                    parent.nodeType === ParseNodeType.ComprehensionIf
                ) {
                    assert(parent.parent !== undefined && isExpressionNode(parent.parent));
                    parent = parent.parent;
                } else if (parent.nodeType === ParseNodeType.Parameter) {
                    assert(parent.parent !== undefined);

                    // Parameters are contextual for lambdas.
                    if (parent.parent.nodeType === ParseNodeType.Lambda) {
                        parent = parent.parent;
                    } else {
                        break;
                    }
                } else if (parent.nodeType === ParseNodeType.TypeParameter) {
                    // If this is a bound or default expression in a type parameter list,
                    // we need to evaluate it in the context of the type parameter.
                    if (node === parent.d.boundExpr || node === parent.d.defaultExpr) {
                        getTypeOfTypeParam(parent);
                        return;
                    }

                    break;
                } else {
                    break;
                }
            }

            nodeToEvaluate = parent;
        }

        const parent = nodeToEvaluate.parent!;
        assert(parent !== undefined);

        switch (parent.nodeType) {
            case ParseNodeType.Del: {
                verifyDeleteExpression(nodeToEvaluate);
                return;
            }

            case ParseNodeType.TypeParameter: {
                // If this is the name node within a type parameter list, see if it's a type alias
                // definition. If so, we need to evaluate the type alias contextually.
                if (
                    nodeToEvaluate === parent.d.name &&
                    parent.parent?.nodeType === ParseNodeType.TypeParameterList &&
                    parent.parent.parent?.nodeType === ParseNodeType.TypeAlias
                ) {
                    getTypeOfTypeAlias(parent.parent.parent);
                    return;
                }
                break;
            }

            case ParseNodeType.TypeAlias: {
                getTypeOfTypeAlias(parent);
                return;
            }

            case ParseNodeType.Decorator: {
                if (parent.parent?.nodeType === ParseNodeType.Class) {
                    getTypeOfClass(parent.parent);
                } else if (parent.parent?.nodeType === ParseNodeType.Function) {
                    getTypeOfFunction(parent.parent);
                }
                return;
            }

            case ParseNodeType.Parameter: {
                if (nodeToEvaluate !== parent.d.defaultValue) {
                    evaluateTypeOfParam(parent);
                    return;
                }
                break;
            }

            case ParseNodeType.Argument: {
                if (nodeToEvaluate === parent.d.name) {
                    // A name used to specify a named parameter in an argument isn't an
                    // expression, so there's nothing we can evaluate here.
                    return;
                }

                if (parent.parent?.nodeType === ParseNodeType.Class) {
                    // A class argument must be evaluated in the context of the class declaration.
                    getTypeOfClass(parent.parent);
                    return;
                }
                break;
            }

            case ParseNodeType.Return: {
                // Return expressions must be evaluated in the context of the expected return type.
                if (parent.d.expr) {
                    const enclosingFunctionNode = ParseTreeUtils.getEnclosingFunction(node);
                    let declaredReturnType = enclosingFunctionNode
                        ? getDeclaredReturnType(enclosingFunctionNode)
                        : undefined;
                    if (declaredReturnType) {
                        const liveScopeIds = ParseTreeUtils.getTypeVarScopesForNode(node);
                        declaredReturnType = makeTypeVarsBound(declaredReturnType, liveScopeIds);
                    }
                    getTypeOfExpression(parent.d.expr, EvalFlags.None, makeInferenceContext(declaredReturnType));
                    return;
                }
                break;
            }

            case ParseNodeType.TypeAnnotation: {
                evaluateTypesForTypeAnnotationNode(parent);
                return;
            }

            case ParseNodeType.Assignment: {
                evaluateTypesForAssignmentStatement(parent);
                return;
            }
        }

        if (nodeToEvaluate.nodeType === ParseNodeType.TypeAnnotation) {
            evaluateTypesForTypeAnnotationNode(nodeToEvaluate);
            return;
        }

        getTypeOfExpression(nodeToEvaluate, flags);
    }

    function evaluateTypeOfParam(node: ParameterNode): void {
        // If this parameter has no name, we have nothing to do.
        if (!node.d.name) {
            return;
        }

        // We need to handle lambdas differently from functions because
        // the former never have parameter type annotations but can
        // be inferred, whereas the latter sometimes have type annotations
        // but cannot be inferred.
        const parent = node.parent!;
        if (parent.nodeType === ParseNodeType.Lambda) {
            evaluateTypesForExpressionInContext(parent);
            return;
        }

        assert(parent.nodeType === ParseNodeType.Function);
        const functionNode = parent as FunctionNode;

        const paramIndex = functionNode.d.params.findIndex((param) => param === node);
        const typeAnnotation = ParseTreeUtils.getTypeAnnotationForParam(functionNode, paramIndex);

        if (typeAnnotation) {
            const param = functionNode.d.params[paramIndex];
            let annotatedType = getTypeOfParamAnnotation(typeAnnotation, functionNode.d.params[paramIndex].d.category);

            const liveTypeVarScopes = ParseTreeUtils.getTypeVarScopesForNode(param);
            annotatedType = makeTypeVarsBound(annotatedType, liveTypeVarScopes);

            const adjType = transformVariadicParamType(
                node,
                node.d.category,
                adjustParamAnnotatedType(param, annotatedType)
            );

            writeTypeCache(node.d.name, { type: adjType }, EvalFlags.None);
            return;
        }

        const containingClassNode = ParseTreeUtils.getEnclosingClass(functionNode, /* stopAtFunction */ true);
        const classInfo = containingClassNode ? getTypeOfClass(containingClassNode) : undefined;

        if (
            classInfo &&
            ClassType.isPseudoGenericClass(classInfo?.classType) &&
            functionNode.d.name.d.value === '__init__'
        ) {
            const typeParamName = getPseudoGenericTypeVarName(node.d.name.d.value);
            const paramType = classInfo.classType.shared.typeParams.find(
                (param) => param.shared.name === typeParamName
            );

            if (paramType) {
                writeTypeCache(node.d.name, { type: TypeVarType.cloneAsBound(paramType) }, EvalFlags.None);
                return;
            }
        }

        // See if the function is a method in a child class. We may be able to
        // infer the type of the parameter from a method of the same name in
        // a parent class if it has an annotated type.
        const functionFlags = getFunctionInfoFromDecorators(
            evaluatorInterface,
            functionNode,
            /* isInClass */ true
        ).flags;

        let inferredParamType =
            inferParamType(functionNode, functionFlags, paramIndex, classInfo?.classType) ?? UnknownType.create();
        const liveTypeVarScopes = ParseTreeUtils.getTypeVarScopesForNode(node);
        inferredParamType = makeTypeVarsBound(inferredParamType, liveTypeVarScopes);

        writeTypeCache(
            node.d.name,
            { type: transformVariadicParamType(node, node.d.category, inferredParamType) },
            EvalFlags.None
        );
    }

    // Evaluates the types that are assigned within the statement that contains
    // the specified parse node. In some cases, a broader statement may need to
    // be evaluated to provide sufficient context for the type. Evaluated types
    // are written back to the type cache for later retrieval.
    function evaluateTypesForStatement(node: ParseNode): void {
        ensureRegistryInitialized(node);

        let curNode: ParseNode | undefined = node;

        while (curNode) {
            switch (curNode.nodeType) {
                case ParseNodeType.Assignment: {
                    // See if the assignment is part of a chain of assignments. If so,
                    // evaluate the entire chain.
                    const isInAssignmentChain =
                        curNode.parent &&
                        (curNode.parent.nodeType === ParseNodeType.Assignment ||
                            curNode.parent.nodeType === ParseNodeType.AssignmentExpression ||
                            curNode.parent.nodeType === ParseNodeType.AugmentedAssignment) &&
                        curNode.parent.d.rightExpr === curNode;
                    if (!isInAssignmentChain) {
                        evaluateTypesForAssignmentStatement(curNode);
                        return;
                    }
                    break;
                }

                case ParseNodeType.TypeAlias: {
                    getTypeOfTypeAlias(curNode);
                    return;
                }

                case ParseNodeType.AssignmentExpression: {
                    evaluateTypesForExpressionInContext(curNode);
                    return;
                }

                case ParseNodeType.AugmentedAssignment: {
                    evaluateTypesForAugmentedAssignment(curNode);
                    return;
                }

                case ParseNodeType.Class: {
                    getTypeOfClass(curNode);
                    return;
                }

                case ParseNodeType.Parameter: {
                    evaluateTypeOfParam(curNode);
                    return;
                }

                case ParseNodeType.Lambda: {
                    evaluateTypesForExpressionInContext(curNode);
                    return;
                }

                case ParseNodeType.Function: {
                    getTypeOfFunction(curNode);
                    return;
                }

                case ParseNodeType.For: {
                    evaluateTypesForForStatement(curNode);
                    return;
                }

                case ParseNodeType.Except: {
                    evaluateTypesForExceptStatement(curNode);
                    return;
                }

                case ParseNodeType.WithItem: {
                    evaluateTypesForWithStatement(curNode);
                    return;
                }

                case ParseNodeType.ComprehensionFor: {
                    const comprehension = curNode.parent as ComprehensionNode;
                    assert(comprehension.nodeType === ParseNodeType.Comprehension);
                    if (curNode === comprehension.d.expr) {
                        evaluateTypesForExpressionInContext(comprehension);
                    } else {
                        // Evaluate the individual iterations starting with the first
                        // up to the curNode.
                        for (const forIfNode of comprehension.d.forIfNodes) {
                            evaluateComprehensionForIf(forIfNode);
                            if (forIfNode === curNode) {
                                break;
                            }
                        }
                    }
                    return;
                }

                case ParseNodeType.ImportAs: {
                    evaluateTypesForImportAs(curNode);
                    return;
                }

                case ParseNodeType.ImportFromAs: {
                    evaluateTypesForImportFromAs(curNode);
                    return;
                }

                case ParseNodeType.ImportFrom: {
                    evaluateTypesForImportFrom(curNode);
                    return;
                }

                case ParseNodeType.Case: {
                    evaluateTypesForCaseStatement(curNode);
                    return;
                }
            }

            curNode = curNode.parent;
        }

        fail('Unexpected statement');
    }

    // Helper function for cases where we need to evaluate the types
    // for a subtree so we can determine the type of one of the subnodes
    // within that tree. If the type cannot be determined (because it's part
    // of a cyclical dependency), the function returns undefined.
    function evaluateTypeForSubnode(subnode: ParseNode, callback: () => void): TypeResult | undefined {
        // If the type cache is already populated with a complete type,
        // don't bother doing additional work.
        let cacheEntry = readTypeCacheEntry(subnode);
        if (cacheEntry && !cacheEntry.typeResult.isIncomplete) {
            const typeResult = cacheEntry.typeResult;

            // Handle the special case where a function or class is partially evaluated.
            // Indicate that these are not complete types.
            if (isFunction(typeResult.type) && FunctionType.isPartiallyEvaluated(typeResult.type)) {
                return { ...typeResult, isIncomplete: true };
            }

            if (isClass(typeResult.type) && ClassType.isPartiallyEvaluated(typeResult.type)) {
                return { ...typeResult, isIncomplete: true };
            }

            return typeResult;
        }

        callback();
        cacheEntry = readTypeCacheEntry(subnode);
        if (cacheEntry) {
            return cacheEntry.typeResult;
        }

        return undefined;
    }

    function getCodeFlowAnalyzerForNode(
        node: ExecutionScopeNode,
        typeAtStart: TypeResult | undefined
    ): CodeFlowAnalyzer {
        let entries = state.codeFlowAnalyzerCache.get(node.id);

        if (entries) {
            const cachedEntry = entries.find((entry) => {
                if (!typeAtStart || !entry.typeAtStart) {
                    return !typeAtStart && !entry.typeAtStart;
                }

                if (!typeAtStart.isIncomplete !== !entry.typeAtStart.isIncomplete) {
                    return false;
                }

                return isTypeSame(typeAtStart.type, entry.typeAtStart.type);
            });

            if (cachedEntry) {
                return cachedEntry.codeFlowAnalyzer;
            }
        }

        // Allocate a new code flow analyzer.
        const analyzer = codeFlowEngine.createCodeFlowAnalyzer();
        if (entries) {
            entries.push({ typeAtStart, codeFlowAnalyzer: analyzer });
        } else {
            entries = [{ typeAtStart, codeFlowAnalyzer: analyzer }];
            state.codeFlowAnalyzerCache.set(node.id, entries);
        }

        return analyzer;
    }

    // Attempts to determine the type of the reference expression at the
    // point in the code. If the code flow analysis has nothing to say
    // about that expression, it returns un undefined type. Normally
    // flow analysis starts from the reference node, but startNode can be
    // specified to override this in a few special cases (functions and
    // lambdas) to support analysis of captured variables.
    function getFlowTypeOfReference(
        reference: CodeFlowReferenceExpressionNode,
        startNode?: ClassNode | FunctionNode | LambdaNode,
        options?: FlowNodeTypeOptions
    ): FlowNodeTypeResult {
        // See if this execution scope requires code flow for this reference expression.
        const referenceKey = createKeyForReference(reference);
        const executionNode = ParseTreeUtils.getExecutionScopeNode(startNode?.parent ?? reference);
        const codeFlowExpressions = AnalyzerNodeInfo.getCodeFlowExpressions(executionNode);

        if (
            !codeFlowExpressions ||
            (!codeFlowExpressions.has(referenceKey) && !codeFlowExpressions.has(wildcardImportReferenceKey))
        ) {
            return FlowNodeTypeResult.create(/* type */ undefined, /* isIncomplete */ false);
        }

        if (checkCodeFlowTooComplex(reference)) {
            return FlowNodeTypeResult.create(
                /* type */ options?.typeAtStart && isUnbound(options.typeAtStart.type)
                    ? UnknownType.create()
                    : undefined,
                /* isIncomplete */ true
            );
        }

        // Is there an code flow analyzer cached for this execution scope?
        let analyzer: CodeFlowAnalyzer | undefined;

        if (isNodeInReturnTypeInferenceContext(executionNode)) {
            // If we're performing the analysis within a temporary
            // context of a function for purposes of inferring its
            // return type for a specified set of arguments, use
            // a temporary analyzer that we'll use only for this context.
            analyzer = getCodeFlowAnalyzerForReturnTypeInferenceContext();
        } else {
            analyzer = getCodeFlowAnalyzerForNode(executionNode, options?.typeAtStart);
        }

        const flowNode = AnalyzerNodeInfo.getFlowNode(startNode ?? reference);
        if (flowNode === undefined) {
            return FlowNodeTypeResult.create(/* type */ undefined, /* isIncomplete */ false);
        }

        return analyzer.getTypeFromCodeFlow(flowNode!, reference, options);
    }

    function getTypeOfArg(arg: Arg, inferenceContext: InferenceContext | undefined): TypeResult {
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
        return getTypeOfExpression(arg.valueExpression, /* flags */ undefined, inferenceContext);
    }

    // This function is like getTypeOfArg except that it is
    // used in cases where the argument is expected to be a type
    // and therefore follows the normal rules of types (e.g. they
    // can be forward-declared in stubs, etc.).
    function getTypeOfArgExpectingType(arg: Arg, options?: ExpectedTypeOptions): TypeResult {
        if (arg.typeResult) {
            return { type: arg.typeResult.type, isIncomplete: arg.typeResult.isIncomplete };
        }

        // If there was no defined type provided, there should always
        // be a value expression from which we can retrieve the type.
        assert(arg.valueExpression !== undefined);
        return getTypeOfExpressionExpectingType(arg.valueExpression, options);
    }

    function getTypeOfExpressionExpectingType(node: ExpressionNode, options?: ExpectedTypeOptions): TypeResult {
        let flags = EvalFlags.InstantiableType | EvalFlags.StrLiteralAsType;

        if (options?.allowTypeVarsWithoutScopeId) {
            flags |= EvalFlags.AllowTypeVarWithoutScopeId;
        }

        if (options?.typeVarGetsCurScope) {
            flags |= EvalFlags.TypeVarGetsCurScope;
        }

        if (options?.enforceClassTypeVarScope) {
            flags |= EvalFlags.EnforceClassTypeVarScope;
        }

        const fileInfo = AnalyzerNodeInfo.getFileInfo(node);
        if ((isAnnotationEvaluationPostponed(fileInfo) || options?.forwardRefs) && !options?.runtimeTypeExpression) {
            flags |= EvalFlags.ForwardRefs;
        } else if (options?.parsesStringLiteral) {
            flags |= EvalFlags.ParsesStringLiteral;
        }

        if (!options?.allowFinal) {
            flags |= EvalFlags.NoFinal;
        }

        if (options?.allowRequired) {
            flags |= EvalFlags.AllowRequired | EvalFlags.TypeExpression;
        }

        if (options?.allowReadOnly) {
            flags |= EvalFlags.AllowReadOnly | EvalFlags.TypeExpression;
        }

        if (options?.allowUnpackedTuple) {
            flags |= EvalFlags.AllowUnpackedTuple;
        } else {
            flags |= EvalFlags.NoTypeVarTuple;
        }

        if (options?.allowUnpackedTypedDict) {
            flags |= EvalFlags.AllowUnpackedTypedDict;
        }

        if (!options?.allowParamSpec) {
            flags |= EvalFlags.NoParamSpec;
        }

        if (options?.typeExpression) {
            flags |= EvalFlags.TypeExpression;
        }

        if (options?.convertEllipsisToAny) {
            flags |= EvalFlags.ConvertEllipsisToAny;
        }

        if (options?.allowEllipsis) {
            flags |= EvalFlags.AllowEllipsis;
        }

        if (options?.noNonTypeSpecialForms) {
            flags |= EvalFlags.NoNonTypeSpecialForms;
        }

        if (!options?.allowClassVar) {
            flags |= EvalFlags.NoClassVar;
        }

        if (options?.varTypeAnnotation) {
            flags |= EvalFlags.VarTypeAnnotation;
        }

        if (options?.notParsed) {
            flags |= EvalFlags.NotParsed;
        }

        if (options?.typeFormArg) {
            flags |= EvalFlags.TypeFormArg;
        }

        return getTypeOfExpression(node, flags);
    }

    function getBuiltInType(node: ParseNode, name: string): Type {
        const scope = ScopeUtils.getScopeForNode(node);
        if (scope) {
            const builtInScope = ScopeUtils.getBuiltInScope(scope);
            const nameType = builtInScope.lookUpSymbol(name);
            if (nameType) {
                return getEffectiveTypeOfSymbol(nameType);
            }
        }

        return UnknownType.create();
    }

    function getBuiltInObject(node: ParseNode, name: string, typeArgs?: Type[]) {
        const nameType = getBuiltInType(node, name);
        if (isInstantiableClass(nameType)) {
            let classType = nameType;
            if (typeArgs) {
                classType = ClassType.specialize(classType, typeArgs);
            }

            return ClassType.cloneAsInstance(classType);
        }

        return nameType;
    }

    function lookUpSymbolRecursive(
        node: ParseNode,
        name: string,
        honorCodeFlow: boolean,
        preferGlobalScope = false
    ): SymbolWithScope | undefined {
        return symbolResolution.lookUpSymbolRecursive(evaluatorInterface, node, name, honorCodeFlow, preferGlobalScope);
    }

    function suppressDiagnostics<T>(
        node: ParseNode,
        callback: () => T,
        diagCallback?: (suppressedDiags: string[]) => void
    ) {
        return state.suppressDiagnostics(node, callback, diagCallback);
    }
    function useSignatureTracker<T>(node: ParseNode, callback: () => T) {
        return state.useSignatureTracker(node, callback);
    }
    function ensureSignatureIsUnique<T extends Type>(type: T, node: ParseNode) {
        return state.ensureSignatureIsUnique(type, node);
    }
    function useSpeculativeMode<T>(
        speculativeNode: ParseNode | undefined,
        callback: () => T,
        options?: SpeculativeModeOptions
    ) {
        return state.useSpeculativeMode(speculativeNode, callback, options);
    }
    function isSpeculativeModeInUse(node: ParseNode | undefined) {
        return state.isSpeculativeModeInUse(node);
    }

    function getDeclInfoForStringNode(node: StringNode): SymbolDeclInfo | undefined {
        return symbolResolution.getDeclInfoForStringNode(evaluatorInterface, node);
    }

    function getAliasFromImport(node: NameNode): NameNode | undefined {
        return symbolResolution.getAliasFromImport(node);
    }

    function getDeclInfoForNameNode(node: NameNode, skipUnreachableCode = true): SymbolDeclInfo | undefined {
        return symbolResolution.getDeclInfoForNameNode(evaluatorInterface, node, skipUnreachableCode);
    }

    function getTypeForDeclaration(declaration: Declaration): DeclaredSymbolTypeInfo {
        return symbolResolution.getTypeForDeclaration(evaluatorInterface, declaration);
    }

    function getTypeOfTypeParam(node: TypeParameterNode): TypeVarType {
        // Is this type already cached?
        const cachedTypeVarType = readTypeCache(node.d.name, EvalFlags.None) as FunctionType;
        if (cachedTypeVarType && isTypeVar(cachedTypeVarType)) {
            return cachedTypeVarType;
        }

        let runtimeClassName = 'TypeVar';
        let kind: TypeVarKind = TypeVarKind.TypeVar;
        if (node.d.typeParamKind === TypeParamKind.TypeVarTuple) {
            runtimeClassName = 'TypeVarTuple';
            kind = TypeVarKind.TypeVarTuple;
        } else if (node.d.typeParamKind === TypeParamKind.ParamSpec) {
            runtimeClassName = 'ParamSpec';
            kind = TypeVarKind.ParamSpec;
        }
        const runtimeType = getTypingType(node, runtimeClassName);
        const runtimeClass = runtimeType && isInstantiableClass(runtimeType) ? runtimeType : undefined;

        let typeVar = TypeVarType.createInstantiable(node.d.name.d.value, kind);
        if (runtimeClass) {
            typeVar = TypeBase.cloneAsSpecialForm(typeVar, ClassType.cloneAsInstance(runtimeClass));
        }
        typeVar.shared.isTypeParamSyntax = true;

        // Cache the value before we evaluate the bound or the default type in
        // case it refers to itself in a circular manner.
        writeTypeCache(node, { type: typeVar }, /* flags */ undefined);
        writeTypeCache(node.d.name, { type: typeVar }, /* flags */ undefined);

        if (node.d.boundExpr) {
            if (node.d.boundExpr.nodeType === ParseNodeType.Tuple) {
                const constraints = node.d.boundExpr.d.items.map((constraint) => {
                    const constraintType = getTypeOfExpressionExpectingType(constraint, {
                        noNonTypeSpecialForms: true,
                        forwardRefs: true,
                        typeExpression: true,
                    }).type;

                    if (
                        requiresSpecialization(constraintType, {
                            ignorePseudoGeneric: true,
                            ignoreImplicitTypeArgs: true,
                        })
                    ) {
                        addDiagnostic(
                            DiagnosticRule.reportGeneralTypeIssues,
                            LocMessage.typeVarBoundGeneric(),
                            constraint
                        );
                    }

                    return convertToInstance(constraintType);
                });

                if (constraints.length < 2) {
                    addDiagnostic(
                        DiagnosticRule.reportGeneralTypeIssues,
                        LocMessage.typeVarSingleConstraint(),
                        node.d.boundExpr
                    );
                } else if (node.d.typeParamKind === TypeParamKind.TypeVar) {
                    typeVar.shared.constraints = constraints;
                }
            } else {
                const boundType = getTypeOfExpressionExpectingType(node.d.boundExpr, {
                    noNonTypeSpecialForms: true,
                    forwardRefs: true,
                    typeExpression: true,
                }).type;

                if (requiresSpecialization(boundType, { ignorePseudoGeneric: true })) {
                    addDiagnostic(
                        DiagnosticRule.reportGeneralTypeIssues,
                        LocMessage.typeVarConstraintGeneric(),
                        node.d.boundExpr
                    );
                }

                if (node.d.typeParamKind === TypeParamKind.TypeVar) {
                    typeVar.shared.boundType = convertToInstance(boundType);
                }
            }
        }

        if (node.d.typeParamKind === TypeParamKind.ParamSpec) {
            const defaultType = node.d.defaultExpr
                ? specialForms.getParamSpecDefaultType(
                      evaluatorInterface,
                      node.d.defaultExpr,
                      /* isPep695Syntax */ true
                  )
                : undefined;

            if (defaultType) {
                typeVar.shared.defaultType = defaultType;
                typeVar.shared.isDefaultExplicit = true;
            } else {
                typeVar.shared.defaultType = ParamSpecType.getUnknown();
            }
        } else if (node.d.typeParamKind === TypeParamKind.TypeVarTuple) {
            const defaultType = node.d.defaultExpr
                ? specialForms.getTypeVarTupleDefaultType(
                      evaluatorInterface,
                      node.d.defaultExpr,
                      /* isPep695Syntax */ true
                  )
                : undefined;

            if (defaultType) {
                typeVar.shared.defaultType = defaultType;
                typeVar.shared.isDefaultExplicit = true;
            } else {
                typeVar.shared.defaultType = makeTupleObject(evaluatorInterface, [
                    { type: UnknownType.create(), isUnbounded: true },
                ]);
            }
        } else {
            const defaultType = node.d.defaultExpr
                ? convertToInstance(
                      getTypeOfExpressionExpectingType(node.d.defaultExpr, {
                          forwardRefs: true,
                          typeExpression: true,
                      }).type
                  )
                : undefined;

            if (defaultType) {
                typeVar.shared.defaultType = defaultType;
                typeVar.shared.isDefaultExplicit = true;
            } else {
                typeVar.shared.defaultType = UnknownType.create();
            }
        }

        // If a default is provided, make sure it is compatible with the bound
        // or constraint.
        if (typeVar.shared.isDefaultExplicit && node.d.defaultExpr) {
            specialForms.verifyTypeVarDefaultIsCompatible(evaluatorInterface, typeVar, node.d.defaultExpr);
        }

        // Associate the type variable with the owning scope.
        const scopeNode = ParseTreeUtils.getTypeVarScopeNode(node);
        if (scopeNode) {
            let scopeType: TypeVarScopeType;
            if (scopeNode.nodeType === ParseNodeType.Class) {
                scopeType = TypeVarScopeType.Class;

                // Set the variance to "auto" for class-scoped TypeVars.
                typeVar.shared.declaredVariance =
                    isParamSpec(typeVar) || isTypeVarTuple(typeVar) ? Variance.Invariant : Variance.Auto;
            } else if (scopeNode.nodeType === ParseNodeType.Function) {
                scopeType = TypeVarScopeType.Function;
            } else {
                assert(scopeNode.nodeType === ParseNodeType.TypeAlias);
                scopeType = TypeVarScopeType.TypeAlias;
                typeVar.shared.declaredVariance =
                    isParamSpec(typeVar) || isTypeVarTuple(typeVar) ? Variance.Invariant : Variance.Auto;
            }

            typeVar = TypeVarType.cloneForScopeId(
                typeVar,
                ParseTreeUtils.getScopeIdForNode(
                    scopeNode.nodeType === ParseNodeType.TypeAlias ? scopeNode.d.name : scopeNode
                ),
                scopeNode.d.name.d.value,
                scopeType
            );
        }

        writeTypeCache(node, { type: typeVar }, /* flags */ undefined);
        writeTypeCache(node.d.name, { type: typeVar }, /* flags */ undefined);

        return typeVar;
    }

    function getInferredTypeOfDeclaration(symbol: Symbol, decl: Declaration): Type | undefined {
        return symbolResolution.getInferredTypeOfDeclaration(evaluatorInterface, state, symbol, decl);
    }

    // If the specified declaration is an alias declaration that points to a symbol,
    // it resolves the alias and looks up the symbol, then returns the first declaration
    // associated with that symbol. It does this recursively if necessary. If a symbol
    // lookup fails, undefined is returned. If resolveLocalNames is true, the method
    // resolves aliases through local renames ("as" clauses found in import statements).
    function resolveAliasDeclaration(
        declaration: Declaration,
        resolveLocalNames: boolean,
        options?: ResolveAliasOptions
    ): Declaration | undefined {
        return symbolResolution.resolveAliasDeclaration(state, declaration, resolveLocalNames, options);
    }

    function resolveAliasDeclarationWithInfo(
        declaration: Declaration,
        resolveLocalNames: boolean,
        options?: ResolveAliasOptions
    ): ResolvedAliasInfo | undefined {
        return symbolResolution.resolveAliasDeclarationWithInfo(state, declaration, resolveLocalNames, options);
    }

    // Returns the type of the symbol. If the type is explicitly declared, that type
    // is returned. If not, the type is inferred from assignments to the symbol. All
    // assigned types are evaluated and combined into a union.
    function getEffectiveTypeOfSymbol(symbol: Symbol): Type {
        return symbolResolution.getEffectiveTypeOfSymbol(evaluatorInterface, state, symbol, getTypeOfSymbolForDecls);
    }

    // If a "usageNode" node is specified, only declarations that are outside
    // of the current execution scope or that are reachable (as determined by
    // code flow analysis) are considered. This helps in cases where there
    // are cyclical dependencies between symbols.
    function getEffectiveTypeOfSymbolForUsage(
        symbol: Symbol,
        usageNode?: NameNode,
        useLastDecl = false
    ): EffectiveTypeResult {
        return symbolResolution.getEffectiveTypeOfSymbolForUsage(
            evaluatorInterface,
            state,
            symbol,
            usageNode,
            useLastDecl,
            getTypeOfSymbolForDecls
        );
    }

    // Returns the type of a symbol based on a subset of its declarations.
    function getTypeOfSymbolForDecls(symbol: Symbol, decls: Declaration[], typeCacheKey: string): EffectiveTypeResult {
        const typesToCombine: Type[] = [];
        let isIncomplete = false;
        let sawPendingEvaluation = false;
        let includesSpeculativeResult = false;

        decls.forEach((decl) => {
            if (pushSymbolResolution(symbol, decl)) {
                try {
                    let type = getInferredTypeOfDeclaration(symbol, decl);

                    if (!popSymbolResolution(symbol)) {
                        isIncomplete = true;
                    }

                    if (type) {
                        if (decl.type === DeclarationType.Variable) {
                            let isConstant = false;
                            if (decl.type === DeclarationType.Variable) {
                                if (decl.isConstant || isFinalVariableDeclaration(decl)) {
                                    isConstant = true;
                                }
                            }

                            // Treat enum values declared within an enum class as though they are const even
                            // though they may not be named as such.
                            if (
                                isClassInstance(type) &&
                                ClassType.isEnumClass(type) &&
                                isDeclInEnumClass(evaluatorInterface, decl)
                            ) {
                                isConstant = true;
                            }

                            // If the symbol is constant, we can retain the literal
                            // value and TypeForm types. Otherwise, strip literal values
                            // and TypeForm types to widen.
                            if (TypeBase.isInstance(type) && !isConstant && !isExplicitTypeAliasDeclaration(decl)) {
                                type = stripTypeForm(stripLiteralValue(type));
                            }
                        }

                        typesToCombine.push(type);

                        if (isSpeculativeModeInUse(decl.node)) {
                            includesSpeculativeResult = true;
                        }
                    } else {
                        isIncomplete = true;
                    }
                } catch (e: any) {
                    // Clean up the stack before rethrowing.
                    popSymbolResolution(symbol);
                    throw e;
                }
            } else {
                if (decl.type === DeclarationType.Class) {
                    const classTypeInfo = getTypeOfClass(decl.node);
                    if (classTypeInfo?.decoratedType) {
                        typesToCombine.push(classTypeInfo.decoratedType);
                    }
                }

                isIncomplete = true;

                // Note that at least one decl could not be evaluated because
                // it was already in the process of being evaluated.
                sawPendingEvaluation = true;
            }
        });

        // How many times have we already attempted to evaluate this declaration already?
        const cacheEntries = state.effectiveTypeCache.get(symbol.id);
        const evaluationAttempts = (cacheEntries?.get(typeCacheKey)?.evaluationAttempts ?? 0) + 1;

        let type: Type;

        if (typesToCombine.length > 0) {
            // Ignore the pending evaluation flag if we've already attempted the
            // type evaluation many times because this probably means there's a
            // cyclical dependency that cannot be broken.
            isIncomplete = sawPendingEvaluation && evaluationAttempts < maxEffectiveTypeEvaluationAttempts;

            type = combineTypes(typesToCombine);
        } else {
            // We can encounter this situation in the case of a bare ClassVar annotation.
            if (symbol.isClassVar()) {
                type = UnknownType.create();
                isIncomplete = false;
            } else {
                type = UnboundType.create();
            }
        }

        return { type, isIncomplete, includesSpeculativeResult, evaluationAttempts };
    }

    // If a declaration has an explicit type (e.g. a variable with an annotation),
    // this function evaluates the type and returns it. If the symbol has no
    // explicit declared type, its type will need to be inferred instead. In some
    // cases, non-type information (such as Final or ClassVar attributes) may be
    // provided, but type inference is still required. In such cases, the attributes
    // are returned as flags.
    function getDeclaredTypeOfSymbol(symbol: Symbol, usageNode?: NameNode): DeclaredSymbolTypeInfo {
        return symbolResolution.getDeclaredTypeOfSymbol(evaluatorInterface, state, symbol, usageNode);
    }

    function inferReturnTypeIfNecessary(type: Type) {
        if (isFunction(type)) {
            getEffectiveReturnType(type);
        } else if (isOverloaded(type)) {
            OverloadedType.getOverloads(type).forEach((overload) => {
                getEffectiveReturnType(overload);
            });

            const impl = OverloadedType.getImplementation(type);
            if (impl && isFunction(impl)) {
                getEffectiveReturnType(impl);
            }
        }
    }

    function getEffectiveReturnType(type: FunctionType): Type {
        return getEffectiveReturnTypeResult(type).type;
    }

    function getInferredReturnType(type: FunctionType): Type {
        return getInferredReturnTypeResult(type).type;
    }

    // Returns the return type of the function. If the type is explicitly provided in
    // a type annotation, that type is returned. If not, an attempt is made to infer
    // the return type. If a list of args is provided, the inference logic may take
    // into account argument types to infer the return type.
    function getEffectiveReturnTypeResult(type: FunctionType, options?: EffectiveReturnTypeOptions): TypeResult {
        const specializedReturnType = FunctionType.getEffectiveReturnType(type, /* includeInferred */ false);
        if (specializedReturnType && !isUnknown(specializedReturnType)) {
            return { type: specializedReturnType };
        }

        return getInferredReturnTypeResult(type, options?.callSiteInfo);
    }

    function _getInferredReturnTypeResult(type: FunctionType, callSiteInfo?: CallSiteEvaluationInfo): TypeResult {
        return returnTypeInference.getInferredReturnTypeResultImpl(evaluatorInterface, state, type, callSiteInfo);
    }

    // If the function has an explicitly-declared return type, it is returned
    // unaltered unless the function is a generator, in which case it is
    // modified to return only the return type for the generator.
    function getDeclaredReturnType(node: FunctionNode): Type | undefined {
        return symbolResolution.getDeclaredReturnType(evaluatorInterface, node);
    }

    function getTypeOfMember(member: ClassMember): Type {
        return memberAccessModule.getTypeOfMember(evaluatorInterface, member);
    }

    function getTypeOfMemberInternal(
        errorNode: ExpressionNode | undefined,
        member: ClassMember,
        selfClass: ClassType | TypeVarType | undefined,
        flags: MemberAccessFlags
    ): TypeResult | undefined {
        if (isAnyOrUnknown(member.classType)) {
            return {
                type: member.classType,
                isIncomplete: false,
            };
        }

        if (!isInstantiableClass(member.classType)) {
            return undefined;
        }

        const typeResult = getEffectiveTypeOfSymbolForUsage(member.symbol);

        if (!typeResult) {
            return undefined;
        }

        // Report inappropriate use of variables in type expressions.
        if ((flags & MemberAccessFlags.TypeExpression) !== 0 && errorNode) {
            typeResult.type = validateSymbolIsTypeExpression(
                errorNode,
                typeResult.type,
                !!typeResult.includesVariableDecl
            );
        }

        // If the type is a function or overloaded function, infer
        // and cache the return type if necessary. This needs to be done
        // prior to specializing.
        inferReturnTypeIfNecessary(typeResult.type);

        // Check for ambiguous accesses to attributes with generic types?
        if (
            errorNode &&
            selfClass &&
            isClass(selfClass) &&
            member.isInstanceMember &&
            isClass(member.unspecializedClassType) &&
            (flags & MemberAccessFlags.DisallowGenericInstanceVariableAccess) !== 0 &&
            requiresSpecialization(typeResult.type, { ignoreSelf: true, ignoreImplicitTypeArgs: true })
        ) {
            const specializedType = partiallySpecializeType(
                typeResult.type,
                member.unspecializedClassType,
                getTypeClassType(),
                selfSpecializeClass(selfClass, { overrideTypeArgs: true })
            );

            if (
                findSubtype(
                    specializedType,
                    (subtype) =>
                        !isFunctionOrOverloaded(subtype) &&
                        requiresSpecialization(subtype, { ignoreSelf: true, ignoreImplicitTypeArgs: true })
                )
            ) {
                addDiagnostic(
                    DiagnosticRule.reportGeneralTypeIssues,
                    LocMessage.genericInstanceVariableAccess(),
                    errorNode
                );
            }
        }

        return {
            type: partiallySpecializeType(typeResult.type, member.classType, getTypeClassType(), selfClass),
            isIncomplete: !!typeResult.isIncomplete,
        };
    }

    function assignClassToSelf(
        destType: ClassType,
        srcType: ClassType,
        assumedVariance: Variance,
        ignoreBaseClassVariance = true,
        recursionCount = 0
    ): boolean {
        return typeAssignment.assignClassToSelf(
            evaluatorInterface,
            registry,
            state,
            destType,
            srcType,
            assumedVariance,
            ignoreBaseClassVariance,
            recursionCount
        );
    }

    function getGetterTypeFromProperty(propertyClass: ClassType): Type | undefined {
        return memberAccessModule.getGetterTypeFromProperty(evaluatorInterface, propertyClass);
    }

    function assignTypeArgs(
        destType: ClassType,
        srcType: ClassType,
        diag: DiagnosticAddendum | undefined,
        constraints: ConstraintTracker | undefined,
        flags: AssignTypeFlags,
        recursionCount: number
    ): boolean {
        return typeAssignment.assignTypeArgs(
            evaluatorInterface,
            registry,
            state,
            destType,
            srcType,
            diag,
            constraints,
            flags,
            recursionCount
        );
    }

    function assignType(
        destType: Type,
        srcType: Type,
        diag?: DiagnosticAddendum,
        constraints?: ConstraintTracker,
        flags = AssignTypeFlags.Default,
        recursionCount = 0
    ): boolean {
        return typeAssignment.assignType(
            evaluatorInterface,
            registry,
            state,
            destType,
            srcType,
            diag,
            constraints,
            flags,
            recursionCount
        );
    }

    function convertToTypeFormType(expectedType: Type, srcType: Type): Type {
        return typeAssignment.convertToTypeFormType(evaluatorInterface, registry, state, expectedType, srcType);
    }

    function isSpecialFormClass(classType: ClassType, flags: AssignTypeFlags): boolean {
        return typeAssignment.isSpecialFormClass(classType, flags);
    }

    // Determines whether a type is "subsumed by" (i.e. is a proper subtype of) another type.
    function isTypeSubsumedByOtherType(type: Type, otherType: Type, allowAnyToSubsume: boolean, recursionCount = 0) {
        return typeAssignment.isTypeSubsumedByOtherType(
            evaluatorInterface,
            registry,
            state,
            type,
            otherType,
            allowAnyToSubsume,
            recursionCount
        );
    }

    function isTypeComparable(leftType: Type, rightType: Type, assumeIsOperator = false) {
        return typeAssignment.isTypeComparable(
            evaluatorInterface,
            registry,
            state,
            leftType,
            rightType,
            assumeIsOperator
        );
    }

    // If the class is a protocol and it has a `__call__` method but no other methods
    // or attributes that would be incompatible with a function, this method returns
    // the signature of the call implied by the `__call__` method. Otherwise it returns
    // undefined.
    function getCallbackProtocolType(
        objType: ClassType,
        recursionCount = 0
    ): FunctionType | OverloadedType | undefined {
        if (!isClassInstance(objType) || !ClassType.isProtocolClass(objType)) {
            return undefined;
        }

        // Make sure that the protocol class doesn't define any fields that
        // a normal function wouldn't be compatible with.
        for (const mroClass of objType.shared.mro) {
            if (isClass(mroClass) && ClassType.isProtocolClass(mroClass)) {
                for (const field of ClassType.getSymbolTable(mroClass)) {
                    const fieldName = field[0];
                    const fieldSymbol = field[1];

                    // We're expecting a __call__ method. We will also ignore a
                    // __slots__ definition, which is (by convention) ignored for
                    // protocol matching.
                    if (fieldName === '__call__' || fieldName === '__slots__') {
                        continue;
                    }

                    if (fieldSymbol.isIgnoredForProtocolMatch()) {
                        continue;
                    }

                    let fieldIsPartOfFunction = false;

                    if (registry.functionClass && isClass(registry.functionClass)) {
                        if (ClassType.getSymbolTable(registry.functionClass).has(field[0])) {
                            fieldIsPartOfFunction = true;
                        }
                    }

                    if (!fieldIsPartOfFunction) {
                        return undefined;
                    }
                }
            }
        }

        const callType = getBoundMagicMethod(
            objType,
            '__call__',
            /* selfType */ undefined,
            /* errorNode */ undefined,
            /* diag */ undefined,
            recursionCount
        );

        if (!callType) {
            return undefined;
        }

        return makeFunctionTypeVarsBound(callType);
    }

    function narrowTypeBasedOnAssignment(declaredType: Type, assignedTypeResult: TypeResult): TypeResult {
        return typeAssignment.narrowTypeBasedOnAssignment(
            evaluatorInterface,
            registry,
            state,
            declaredType,
            assignedTypeResult
        );
    }

    function validateOverrideMethod(
        baseMethod: Type,
        overrideMethod: FunctionType | OverloadedType,
        baseClass: ClassType | undefined,
        diag: DiagnosticAddendum,
        enforceParamNames = true
    ): boolean {
        return typeAssignment.validateOverrideMethod(
            evaluatorInterface,
            registry,
            state,
            baseMethod,
            overrideMethod,
            baseClass,
            diag,
            enforceParamNames
        );
    }

    function getAbstractSymbols(classType: ClassType): AbstractSymbol[] {
        return symbolResolution.getAbstractSymbols(evaluatorInterface, classType);
    }

    // If the memberType is an instance or class method, creates a new
    // version of the function that has the "self" or "cls" parameter bound
    // to it. If treatConstructorAsClassMethod is true, the function is
    // treated like a class method even if it's not marked as such. That's
    // needed to special-case the __new__ magic method when it's invoked as
    // a constructor (as opposed to by name).
    function bindFunctionToClassOrObject(
        baseType: ClassType | undefined,
        memberType: FunctionType | OverloadedType,
        memberClass?: ClassType,
        treatConstructorAsClassMethod = false,
        selfType?: ClassType | TypeVarType,
        diag?: DiagnosticAddendum,
        recursionCount = 0
    ): FunctionType | OverloadedType | undefined {
        return memberAccessModule.bindFunctionToClassOrObject(
            evaluatorInterface,
            baseType,
            memberType,
            memberClass,
            treatConstructorAsClassMethod,
            selfType,
            diag,
            recursionCount
        );
    }

    function isFinalVariable(symbol: Symbol): boolean {
        return symbolResolution.isFinalVariable(symbol);
    }

    function isFinalVariableDeclaration(decl: Declaration): boolean {
        return symbolResolution.isFinalVariableDeclaration(decl);
    }

    function isExplicitTypeAliasDeclaration(decl: Declaration): boolean {
        return symbolResolution.isExplicitTypeAliasDeclaration(evaluatorInterface, decl);
    }

    function isPossibleTypeAliasDeclaration(decl: Declaration): boolean {
        return symbolResolution.isPossibleTypeAliasDeclaration(decl);
    }

    function isLegalTypeAliasExpressionForm(node: ExpressionNode, allowStrLiteral: boolean): boolean {
        return symbolResolution.isLegalTypeAliasExpressionForm(node, allowStrLiteral);
    }

    function isLegalImplicitTypeAliasType(type: Type) {
        return symbolResolution.isLegalImplicitTypeAliasType(type);
    }

    function isPossibleTypeDictFactoryCall(decl: Declaration) {
        return symbolResolution.isPossibleTypeDictFactoryCall(evaluatorInterface, decl);
    }

    function printObjectTypeForClass(type: ClassType): string {
        return TypePrinter.printObjectTypeForClass(type, evaluatorOptions.printTypeFlags, getEffectiveReturnType);
    }

    function printFunctionParts(type: FunctionType, extraFlags?: TypePrinter.PrintTypeFlags): [string[], string] {
        const flags = extraFlags ? evaluatorOptions.printTypeFlags | extraFlags : evaluatorOptions.printTypeFlags;
        return TypePrinter.printFunctionParts(type, flags, getEffectiveReturnType);
    }

    // Prints two types and determines whether they need to be output in
    // fully-qualified form for disambiguation.
    function printSrcDestTypes(
        srcType: Type,
        destType: Type,
        options?: PrintTypeOptions
    ): { sourceType: string; destType: string } {
        const simpleSrcType = printType(srcType, options);
        const simpleDestType = printType(destType, options);

        if (simpleSrcType !== simpleDestType) {
            return { sourceType: simpleSrcType, destType: simpleDestType };
        }

        const fullSrcType = printType(srcType, { ...(options ?? {}), useFullyQualifiedNames: true });
        const fullDestType = printType(destType, { ...(options ?? {}), useFullyQualifiedNames: true });

        if (fullSrcType !== fullDestType) {
            return { sourceType: fullSrcType, destType: fullDestType };
        }

        return { sourceType: simpleSrcType, destType: simpleDestType };
    }

    function printType(type: Type, options?: PrintTypeOptions): string {
        let flags = evaluatorOptions.printTypeFlags;

        if (options?.expandTypeAlias) {
            flags |= TypePrinter.PrintTypeFlags.ExpandTypeAlias;
        }
        if (options?.enforcePythonSyntax) {
            flags |= TypePrinter.PrintTypeFlags.PythonSyntax;
        }
        if (options?.useTypingUnpack) {
            flags |= TypePrinter.PrintTypeFlags.UseTypingUnpack;
        }
        if (options?.printUnknownWithAny) {
            flags |= TypePrinter.PrintTypeFlags.PrintUnknownWithAny;
        }
        if (options?.printTypeVarVariance) {
            flags |= TypePrinter.PrintTypeFlags.PrintTypeVarVariance;
        }
        if (options?.omitTypeArgsIfUnknown) {
            flags |= TypePrinter.PrintTypeFlags.OmitTypeArgsIfUnknown;
        }
        if (options?.useFullyQualifiedNames) {
            flags |= TypePrinter.PrintTypeFlags.UseFullyQualifiedNames;
        }

        return TypePrinter.printType(type, flags, getEffectiveReturnType);
    }

    // Calls back into the parser to parse the contents of a string literal.
    // This is unfortunately needed in some cases — specifically where the
    // parser couldn't determine that the string literal would be used in
    // a context where it should be treated as a forward-declared type. This
    // call produces an expression tree that is not attached to the main parse
    // expression tree because we don't want to mutate the latter; the
    // expression tree created by this function is therefore used only temporarily.
    function parseStringAsTypeAnnotation(node: StringListNode, reportErrors: boolean): ExpressionNode | undefined {
        const fileInfo = AnalyzerNodeInfo.getFileInfo(node);
        const parser = new Parser();
        const textValue = node.d.strings[0].d.value;

        // Determine the offset within the file where the string
        // literal's contents begin.
        let valueOffset = node.d.strings[0].start;
        if (node.d.strings[0].nodeType === ParseNodeType.String) {
            valueOffset += node.d.strings[0].d.token.prefixLength + node.d.strings[0].d.token.quoteMarkLength;
        }

        // Construct a temporary dummy string with the text value at the appropriate
        // offset so as to mimic the original file. This will keep all of the token
        // and diagnostic offsets correct.
        const dummyFileContents = ' '.repeat(valueOffset) + textValue;

        const parseOptions = new ParseOptions();
        parseOptions.isStubFile = fileInfo.isStubFile;
        parseOptions.pythonVersion = fileInfo.executionEnvironment.pythonVersion;
        parseOptions.reportErrorsForParsedStringContents = true;

        const parseResults = parser.parseTextExpression(
            dummyFileContents,
            valueOffset,
            textValue.length,
            parseOptions,
            ParseTextMode.Expression,
            /* initialParenDepth */ undefined,
            fileInfo.typingSymbolAliases
        );

        if (parseResults.parseTree) {
            // If there are errors but we are not reporting them, return
            // undefined to indicate that the parse failed.
            if (!reportErrors && parseResults.diagnostics.length > 0) {
                return undefined;
            }

            const fileInfo = AnalyzerNodeInfo.getFileInfo(node);
            parseResults.diagnostics.forEach((diag) => {
                fileInfo.diagnosticSink.addDiagnosticWithTextRange('error', diag.message, node);
            });

            parseResults.parseTree.parent = node;

            // Optionally add the new subtree to the parse tree so it can
            // participate in language server operations like find and replace.
            if (reportErrors) {
                node.d.annotation = parseResults.parseTree;
            }

            return parseResults.parseTree;
        }

        return undefined;
    }

    // Given a code flow node and a constrained TypeVar, determines whether that type
    // var can be "narrowed" to a single one of its constraints based on isinstance
    // checks within the code flow.
    function narrowConstrainedTypeVar(node: ParseNode, typeVar: TypeVarType): Type | undefined {
        const flowNode = AnalyzerNodeInfo.getFlowNode(node);

        if (!flowNode) {
            return undefined;
        }

        return codeFlowEngine.narrowConstrainedTypeVar(flowNode, typeVar);
    }

    function getPrintExpressionTypesSpaces() {
        return state.getPrintExpressionTypesSpaces();
    }

    function getLineNum(node: ParseNode) {
        const fileInfo = AnalyzerNodeInfo.getFileInfo(node);
        const range = convertOffsetsToRange(node.start, node.start + node.length, fileInfo.lines);
        return (range.start.line + 1).toString();
    }

    function printControlFlowGraph(
        flowNode: FlowNode,
        reference: CodeFlowReferenceExpressionNode | undefined,
        callName: string,
        logger: ConsoleInterface
    ) {
        return codeFlowEngine.printControlFlowGraph(flowNode, reference, callName, logger);
    }

    // Track these apis internal usages when logging is on. otherwise, it should be noop.
    const getInferredReturnTypeResult = wrapWithLogger(_getInferredReturnTypeResult);

    const evaluatorInterface: TypeEvaluator = {
        runWithCancellationToken,
        getType,
        getTypeResult,
        getTypeResultForDecorator,
        getCachedType,
        getTypeOfExpression,
        getTypeOfAnnotation,
        getTypeOfClass,
        createSubclass: (errorNode: ExpressionNode, type1: ClassType, type2: ClassType) =>
            specialForms.createSubclass(evaluatorInterface, errorNode, type1, type2),
        getTypeOfFunction,
        getTypeOfExpressionExpectingType,
        getExpectedType,
        evaluateTypeForSubnode,
        evaluateTypesForStatement,
        evaluateTypesForAssignmentStatement,
        evaluateTypesForMatchStatement,
        evaluateTypesForCaseStatement,
        evaluateTypeOfParam,
        canBeTruthy,
        canBeFalsy,
        stripLiteralValue,
        convertSpecialFormToRuntimeValue,
        removeTruthinessFromType,
        removeFalsinessFromType,
        stripTypeGuard,
        solveAndApplyConstraints,
        verifyRaiseExceptionType,
        verifyDeleteExpression,
        validateOverloadedArgTypes,
        validateInitSubclassArgs,
        isNodeReachable,
        isAfterNodeReachable,
        isFlowPathBetweenNodes,
        getNodeReachability,
        getAfterNodeReachability,
        isAsymmetricAccessorAssignment,
        suppressDiagnostics,
        isSpecialFormClass,
        getDeclInfoForStringNode,
        getDeclInfoForNameNode,
        getTypeForDeclaration,
        resolveAliasDeclaration,
        resolveAliasDeclarationWithInfo,
        getTypeOfIterable,
        getTypeOfIterator,
        getGetterTypeFromProperty,
        getTypeOfArg,
        convertNodeToArg,
        buildTupleTypesList,
        markNamesAccessed,
        expandPromotionTypes,
        makeTopLevelTypeVarsConcrete,
        mapSubtypesExpandTypeVars,
        isTypeSubsumedByOtherType,
        lookUpSymbolRecursive,
        getDeclaredTypeOfSymbol,
        getEffectiveTypeOfSymbol,
        getEffectiveTypeOfSymbolForUsage,
        getInferredTypeOfDeclaration,
        getDeclaredTypeForExpression,
        getDeclaredReturnType,
        getInferredReturnType,
        getBestOverloadForArgs,
        getBuiltInType,
        getTypeOfMember,
        getTypeOfBoundMember,
        getBoundMagicMethod,
        getTypeOfMagicMethodCall,
        bindFunctionToClassOrObject,
        getCallbackProtocolType,
        getCallSignatureInfo,
        getAbstractSymbols,
        narrowConstrainedTypeVar,
        isTypeComparable,
        assignType,
        validateOverrideMethod,
        validateCallArgs,
        validateTypeArg,
        assignTypeToExpression,
        assignClassToSelf,
        getTypedDictClassType,
        getTupleClassType,
        getDictClassType,
        getStrClassType,
        getObjectType,
        getNoneType,
        getUnionClassType,
        getTypeClassType,
        getBuiltInObject,
        getTypingType,
        getTypesType,
        getTypeOfModule,
        getTypeCheckerInternalsType,
        getTypeOfTypeAliasCommon,
        inferVarianceForTypeAlias,
        getTypeArgs,
        adjustTypeArgsForTypeVarTuple,
        assignTypeArgs,
        reportMissingTypeArgs,
        inferReturnTypeIfNecessary,
        inferVarianceForClass,
        isFinalVariable,
        isFinalVariableDeclaration,
        isExplicitTypeAliasDeclaration,
        getTypeOfTypeAlias,
        getTypeOfParamAnnotation,
        transformVariadicParamType,
        adjustParamAnnotatedType,
        getTypeOfTypeParam,
        isClassVarAllowedForAssignmentTarget,
        isFinalAllowedForAssignmentTarget,
        addInformation,
        addUnreachableCode,
        addDeprecated,
        addDiagnostic,
        addDiagnosticForTextRange,
        printType,
        printSrcDestTypes,
        printFunctionParts,
        getTypeCacheEntryCount,
        disposeEvaluator,
        useSpeculativeMode,
        isSpeculativeModeInUse,
        setTypeResultForNode,
        checkForCancellation,
        printControlFlowGraph,
    };

    // Wire post-construction dependency: addDiagnosticWithSuppressionCheck
    // needs isNodeReachable, which uses codeFlowEngine (created below).
    state.setIsNodeReachable(isNodeReachable);

    const codeFlowEngine = getCodeFlowEngine(evaluatorInterface, state.speculativeTypeTracker);
    state.setCodeFlowEngine(codeFlowEngine);

    return evaluatorInterface;
}
