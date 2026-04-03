/*
 * symbolResolution.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 *
 * Functions for symbol and declaration resolution extracted from
 * the createTypeEvaluator closure.
 */

import { appendArray } from '../common/collectionUtils';
import { assert } from '../common/debug';
import { DiagnosticAddendum } from '../common/diagnostic';
import { DiagnosticRule } from '../common/diagnosticRules';
import { LocAddendum, LocMessage } from '../localization/localize';
import {
    ClassNode,
    ExpressionNode,
    FunctionNode,
    ImportAsNode,
    ImportFromAsNode,
    ImportFromNode,
    NameNode,
    ParameterNode,
    ParseNode,
    ParseNodeType,
    StringNode,
    TypeAliasNode,
    TypeParameterNode,
} from '../parser/parseNodes';
import { isAnnotationEvaluationPostponed } from './analyzerFileInfo';
import * as AnalyzerNodeInfo from './analyzerNodeInfo';
import { getBoundInitMethod } from './constructors';
import { Declaration, DeclarationType, FunctionDeclaration } from './declaration';
import { getDeclarationsWithUsesLocalNameRemoved, synthesizeAliasDeclaration } from './declarationUtils';
import { getFunctionInfoFromDecorators } from './decorators';
import { getParamListDetails } from './parameterUtils';
import * as ParseTreeUtils from './parseTreeUtils';
import { ScopeType, SymbolWithScope } from './scope';
import * as ScopeUtils from './scopeUtils';
import { SynthesizedTypeInfo } from './symbol';
import { getLastTypedDeclarationForSymbol } from './symbolUtils';
import { TypeEvaluatorState } from './typeEvaluatorState';
import {
    AbstractSymbol,
    DeclaredSymbolTypeInfo,
    EvalFlags,
    EvaluatorUsage,
    Reachability,
    SymbolDeclInfo,
    TypeEvaluator,
} from './typeEvaluatorTypes';
import {
    AnyType,
    ClassType,
    combineTypes,
    FunctionType,
    FunctionTypeFlags,
    isAnyOrUnknown,
    isClassInstance,
    isFunction,
    isFunctionOrOverloaded,
    isInstantiableClass,
    isModule,
    isOverloaded,
    isParamSpec,
    isTypeVar,
    isTypeVarTuple,
    ModuleType,
    OverloadedType,
    Type,
    TypeVarType,
    UnboundType,
    UnknownType,
    Variance,
} from './types';
import {
    convertToInstance,
    derivesFromStdlibClass,
    doForEachSubtype,
    getDeclaredGeneratorReturnType,
    lookUpClassMember,
    lookUpObjectMember,
    makeTypeVarsBound,
    makeTypeVarsFree,
    MemberAccessFlags,
    partiallySpecializeType,
    specializeWithUnknownTypeArgs,
} from './typeUtils';
import { getTypeOfIndexedTypedDict } from './typedDicts';
import { makeTupleObject } from './tuples';
import { Uri } from '../common/uri/uri';

import type { Symbol } from './symbol';

export function isFinalVariableDeclaration(decl: Declaration): boolean {
    return decl.type === DeclarationType.Variable && !!decl.isFinal;
}

export function isFinalVariable(symbol: Symbol): boolean {
    return symbol.getDeclarations().some((decl) => isFinalVariableDeclaration(decl));
}

export function getAliasFromImport(node: NameNode): NameNode | undefined {
    if (
        node.parent &&
        node.parent.nodeType === ParseNodeType.ImportFromAs &&
        node.parent.d.alias &&
        node === node.parent.d.name
    ) {
        return node.parent.d.alias;
    }
    return undefined;
}

export function getDeclarationFromKeywordParam(type: FunctionType, paramName: string): Declaration | undefined {
    if (isFunction(type)) {
        if (type.shared.declaration) {
            const functionDecl = type.shared.declaration;
            if (functionDecl.type === DeclarationType.Function) {
                const functionNode = functionDecl.node;
                const functionScope = AnalyzerNodeInfo.getScope(functionNode);
                if (functionScope) {
                    const paramSymbol = functionScope.lookUpSymbol(paramName)!;
                    if (paramSymbol) {
                        return paramSymbol.getDeclarations().find((decl) => decl.type === DeclarationType.Param);
                    }

                    const parameterDetails = getParamListDetails(type);
                    if (parameterDetails.unpackedKwargsTypedDictType) {
                        const lookupResults = lookUpClassMember(
                            parameterDetails.unpackedKwargsTypedDictType,
                            paramName
                        );
                        if (lookupResults) {
                            return lookupResults.symbol
                                .getDeclarations()
                                .find((decl) => decl.type === DeclarationType.Variable);
                        }
                    }
                }
            }
        }
    }

    return undefined;
}

export function isExplicitTypeAliasDeclaration(evaluator: TypeEvaluator, decl: Declaration): boolean {
    if (decl.type !== DeclarationType.Variable || !decl.typeAnnotationNode) {
        return false;
    }

    if (
        decl.typeAnnotationNode.nodeType !== ParseNodeType.Name &&
        decl.typeAnnotationNode.nodeType !== ParseNodeType.MemberAccess &&
        decl.typeAnnotationNode.nodeType !== ParseNodeType.StringList
    ) {
        return false;
    }

    const type = evaluator.getTypeOfAnnotation(decl.typeAnnotationNode, { varTypeAnnotation: true, allowClassVar: true });
    return isClassInstance(type) && ClassType.isBuiltIn(type, 'TypeAlias');
}

export function getDeclInfoForStringNode(evaluator: TypeEvaluator, node: StringNode): SymbolDeclInfo | undefined {
    const decls: Declaration[] = [];
    const synthesizedTypes: SynthesizedTypeInfo[] = [];
    const expectedType = evaluator.getExpectedType(node)?.type;

    if (expectedType) {
        doForEachSubtype(expectedType, (subtype) => {
            if (isClassInstance(subtype) && ClassType.isTypedDictClass(subtype)) {
                const entry = subtype.shared.typedDictEntries?.knownItems.get(node.d.value);
                if (entry) {
                    const symbol = lookUpObjectMember(subtype, node.d.value)?.symbol;

                    if (symbol) {
                        appendArray(decls, symbol.getDeclarations());

                        const synthTypeInfo = symbol.getSynthesizedType();
                        if (synthTypeInfo) {
                            synthesizedTypes.push(synthTypeInfo);
                        }
                    }
                }
            }
        });
    }

    return decls.length === 0 ? undefined : { decls, synthesizedTypes };
}

function methodAlwaysRaisesNotImplemented(evaluator: TypeEvaluator, functionDecl?: FunctionDeclaration): boolean {
    if (
        !functionDecl ||
        !functionDecl.isMethod ||
        functionDecl.returnStatements ||
        functionDecl.yieldStatements ||
        !functionDecl.raiseStatements
    ) {
        return false;
    }

    const statements = functionDecl.node.d.suite.d.statements;
    if (statements.some((statement) => statement.nodeType !== ParseNodeType.StatementList)) {
        return false;
    }

    for (const raiseStatement of functionDecl.raiseStatements) {
        if (!raiseStatement.d.expr || raiseStatement.d.fromExpr) {
            return false;
        }
        const raiseType = evaluator.getTypeOfExpression(raiseStatement.d.expr).type;
        const classType = isInstantiableClass(raiseType)
            ? raiseType
            : isClassInstance(raiseType)
            ? raiseType
            : undefined;
        if (!classType || !derivesFromStdlibClass(classType, 'NotImplementedError')) {
            return false;
        }
    }

    return true;
}

export function getAbstractSymbolInfo(
    evaluator: TypeEvaluator,
    classType: ClassType,
    symbolName: string
): AbstractSymbol | undefined {
    const isProtocolClass = ClassType.isProtocolClass(classType);

    const symbol = ClassType.getSymbolTable(classType).get(symbolName);
    if (!symbol) {
        return undefined;
    }

    if (!symbol.isClassMember() && !symbol.isNamedTupleMemberMember()) {
        return undefined;
    }

    const lastDecl = getLastTypedDeclarationForSymbol(symbol);
    if (!lastDecl) {
        return undefined;
    }

    if (isProtocolClass && lastDecl.type === DeclarationType.Variable) {
        const allDecls = symbol.getDeclarations();
        if (!allDecls.some((decl) => decl.type === DeclarationType.Variable && !!decl.inferredTypeSource)) {
            return { symbol, symbolName, classType, hasImplementation: false };
        }
    }

    if (lastDecl.type !== DeclarationType.Function) {
        return undefined;
    }

    let isAbstract = false;
    const lastFunctionInfo = getFunctionInfoFromDecorators(evaluator, lastDecl.node, /* isInClass */ true);
    if ((lastFunctionInfo.flags & FunctionTypeFlags.AbstractMethod) !== 0) {
        isAbstract = true;
    }

    const isStubFile = AnalyzerNodeInfo.getFileInfo(lastDecl.node).isStubFile;

    const firstDecl = symbol.getDeclarations()[0];

    if (firstDecl !== lastDecl && firstDecl.type === DeclarationType.Function) {
        const firstFunctionInfo = getFunctionInfoFromDecorators(evaluator, firstDecl.node, /* isInClass */ true);
        if ((firstFunctionInfo.flags & FunctionTypeFlags.AbstractMethod) !== 0) {
            isAbstract = true;
        }

        if (isProtocolClass && (lastFunctionInfo.flags & FunctionTypeFlags.Overloaded) !== 0) {
            if (isProtocolClass && !isAbstract && isStubFile) {
                return undefined;
            }

            return { symbol, symbolName, classType, hasImplementation: false };
        }
    }

    if (!isProtocolClass && !isAbstract) {
        return undefined;
    }

    const hasImplementation =
        !ParseTreeUtils.isSuiteEmpty(lastDecl.node.d.suite) && !methodAlwaysRaisesNotImplemented(evaluator, lastDecl);

    if (isProtocolClass && !isAbstract) {
        if (hasImplementation || isStubFile) {
            return undefined;
        }
    }

    return { symbol, symbolName, classType, hasImplementation };
}

export function getAbstractSymbols(evaluator: TypeEvaluator, classType: ClassType): AbstractSymbol[] {
    const symbolTable = new Map<string, AbstractSymbol>();

    ClassType.getReverseMro(classType).forEach((mroClass) => {
        if (isInstantiableClass(mroClass)) {
            ClassType.getSymbolTable(mroClass).forEach((symbol, symbolName) => {
                const abstractSymbolInfo = getAbstractSymbolInfo(evaluator, mroClass, symbolName);

                if (abstractSymbolInfo) {
                    symbolTable.set(symbolName, abstractSymbolInfo);
                } else {
                    symbolTable.delete(symbolName);
                }
            });
        }
    });

    const symbolList: AbstractSymbol[] = [];
    symbolTable.forEach((method) => {
        symbolList.push(method);
    });

    return symbolList;
}

export function getDeclInfoForNameNode(
    evaluator: TypeEvaluator,
    node: NameNode,
    skipUnreachableCode = true
): SymbolDeclInfo | undefined {
    if (skipUnreachableCode && AnalyzerNodeInfo.isCodeUnreachable(node)) {
        return undefined;
    }

    const decls: Declaration[] = [];
    const synthesizedTypes: SynthesizedTypeInfo[] = [];

    // If the node is part of a "from X import Y as Z" statement and the node
    // is the "Y" (non-aliased) name, we need to look up the alias symbol
    // since the non-aliased name is not in the symbol table.
    const alias = getAliasFromImport(node);
    if (alias) {
        const scope = ScopeUtils.getScopeForNode(node);
        if (scope) {
            // Look up the alias symbol.
            const symbolInScope = scope.lookUpSymbolRecursive(alias.d.value);
            if (symbolInScope) {
                // The alias could have more decls that don't refer to this import. Filter
                // out the one(s) that specifically associated with this import statement.
                const declsForThisImport = symbolInScope.symbol.getDeclarations().filter((decl) => {
                    return decl.type === DeclarationType.Alias && decl.node === node.parent;
                });

                appendArray(decls, getDeclarationsWithUsesLocalNameRemoved(declsForThisImport));
            }
        }
    } else if (
        node.parent &&
        node.parent.nodeType === ParseNodeType.MemberAccess &&
        node === node.parent.d.member
    ) {
        let baseType = evaluator.getType(node.parent.d.leftExpr);
        if (baseType) {
            baseType = evaluator.makeTopLevelTypeVarsConcrete(baseType);
            const memberName = node.parent.d.member.d.value;
            doForEachSubtype(baseType, (subtype) => {
                let symbol: Symbol | undefined;

                subtype = evaluator.makeTopLevelTypeVarsConcrete(subtype);

                if (isInstantiableClass(subtype)) {
                    // Try to find a member that has a declared type. If so, that
                    // overrides any inferred types.
                    let member = lookUpClassMember(subtype, memberName, MemberAccessFlags.DeclaredTypesOnly);
                    if (!member) {
                        member = lookUpClassMember(subtype, memberName);
                    }

                    if (!member) {
                        const metaclass = subtype.shared.effectiveMetaclass;
                        if (metaclass && isInstantiableClass(metaclass)) {
                            member = lookUpClassMember(metaclass, memberName);
                        }
                    }

                    if (member) {
                        symbol = member.symbol;
                    }
                } else if (isClassInstance(subtype)) {
                    // Try to find a member that has a declared type. If so, that
                    // overrides any inferred types.
                    let member = lookUpObjectMember(subtype, memberName, MemberAccessFlags.DeclaredTypesOnly);
                    if (!member) {
                        member = lookUpObjectMember(subtype, memberName);
                    }
                    if (member) {
                        symbol = member.symbol;
                    }
                } else if (isModule(subtype)) {
                    symbol = ModuleType.getField(subtype, memberName);
                }

                if (symbol) {
                    // By default, report only the declarations that have type annotations.
                    // If there are none, then report all of the unannotated declarations,
                    // which includes every assignment of that symbol.
                    const typedDecls = symbol.getTypedDeclarations();
                    if (typedDecls.length > 0) {
                        appendArray(decls, typedDecls);
                    } else {
                        appendArray(decls, symbol.getDeclarations());
                    }

                    const synthTypeInfo = symbol.getSynthesizedType();
                    if (synthTypeInfo) {
                        synthesizedTypes.push(synthTypeInfo);
                    }
                }
            });
        }
    } else if (node.parent && node.parent.nodeType === ParseNodeType.ModuleName) {
        const namePartIndex = node.parent.d.nameParts.findIndex((part) => part === node);
        const importInfo = AnalyzerNodeInfo.getImportInfo(node.parent);
        if (
            namePartIndex >= 0 &&
            importInfo &&
            !importInfo.isNativeLib &&
            namePartIndex < importInfo.resolvedUris.length
        ) {
            if (importInfo.resolvedUris[namePartIndex]) {
                evaluator.evaluateTypesForStatement(node);

                // Synthesize an alias declaration for this name part. The only
                // time this case is used is for IDE services such as
                // the find all references, hover provider and etc.
                decls.push(synthesizeAliasDeclaration(importInfo.resolvedUris[namePartIndex]));
            }
        }
    } else if (node.parent && node.parent.nodeType === ParseNodeType.Argument && node === node.parent.d.name) {
        // The target node is the name in a keyword argument. We need to determine whether
        // the corresponding keyword parameter can be determined from the context.
        const argNode = node.parent;
        const paramName = node.d.value;
        if (argNode.parent?.nodeType === ParseNodeType.Call) {
            const baseType = evaluator.getType(argNode.parent.d.leftExpr);

            if (baseType) {
                if (isFunction(baseType) && baseType.shared.declaration) {
                    const paramDecl = getDeclarationFromKeywordParam(baseType, paramName);
                    if (paramDecl) {
                        decls.push(paramDecl);
                    }
                } else if (isOverloaded(baseType)) {
                    OverloadedType.getOverloads(baseType).forEach((f) => {
                        const paramDecl = getDeclarationFromKeywordParam(f, paramName);
                        if (paramDecl) {
                            decls.push(paramDecl);
                        }
                    });
                } else if (isInstantiableClass(baseType)) {
                    const initMethodType = getBoundInitMethod(
                        evaluator,
                        argNode.parent.d.leftExpr,
                        ClassType.cloneAsInstance(baseType)
                    )?.type;

                    if (initMethodType && isFunction(initMethodType)) {
                        const paramDecl = getDeclarationFromKeywordParam(initMethodType, paramName);
                        if (paramDecl) {
                            decls.push(paramDecl);
                        } else if (
                            ClassType.isDataClass(baseType) ||
                            ClassType.isTypedDictClass(baseType) ||
                            ClassType.hasNamedTupleEntry(baseType, paramName)
                        ) {
                            const lookupResults = lookUpClassMember(baseType, paramName);

                            if (lookupResults) {
                                appendArray(decls, lookupResults.symbol.getDeclarations());

                                const synthTypeInfo = lookupResults.symbol.getSynthesizedType();
                                if (synthTypeInfo) {
                                    synthesizedTypes.push(synthTypeInfo);
                                }
                            }
                        }
                    } else if (
                        ClassType.isDataClass(baseType) ||
                        ClassType.isTypedDictClass(baseType) ||
                        ClassType.hasNamedTupleEntry(baseType, paramName)
                    ) {
                        // Some synthesized callables (notably TypedDict "constructors") don't have a
                        // meaningful __init__ signature we can map keyword arguments to. In these cases,
                        // treat the keyword as referring to the class entry so IDE features like
                        // go-to-definition and rename can bind to the field declaration.
                        const lookupResults = lookUpClassMember(baseType, paramName);

                        if (lookupResults) {
                            appendArray(decls, lookupResults.symbol.getDeclarations());

                            const synthTypeInfo = lookupResults.symbol.getSynthesizedType();
                            if (synthTypeInfo) {
                                synthesizedTypes.push(synthTypeInfo);
                            }
                        }
                    }
                }
            }
        } else if (argNode.parent?.nodeType === ParseNodeType.Class) {
            const classTypeResult = evaluator.getTypeOfClass(argNode.parent);

            // Validate the init subclass args for this class so we can properly
            // evaluate its custom keyword parameters.
            if (classTypeResult) {
                evaluator.validateInitSubclassArgs(argNode.parent, classTypeResult.classType);
            }
        }
    } else {
        const fileInfo = AnalyzerNodeInfo.getFileInfo(node);

        // Determine if this node is within a quoted type annotation.
        const isWithinTypeAnnotation = ParseTreeUtils.isWithinTypeAnnotation(
            node,
            !isAnnotationEvaluationPostponed(AnalyzerNodeInfo.getFileInfo(node))
        );

        // Determine if this is part of a "type" statement.
        const isWithinTypeAliasStatement = !!ParseTreeUtils.getParentNodeOfType(node, ParseNodeType.TypeAlias);
        const allowForwardReferences = isWithinTypeAnnotation || isWithinTypeAliasStatement || fileInfo.isStubFile;

        const symbolWithScope = evaluator.lookUpSymbolRecursive(
            node,
            node.d.value,
            !allowForwardReferences
        );

        if (symbolWithScope) {
            appendArray(decls, symbolWithScope.symbol.getDeclarations());

            const synthTypeInfo = symbolWithScope.symbol.getSynthesizedType();
            if (synthTypeInfo) {
                synthesizedTypes.push(synthTypeInfo);
            }
        }
    }

    return { decls, synthesizedTypes };
}

export function getDeclaredReturnType(evaluator: TypeEvaluator, node: FunctionNode): Type | undefined {
    const functionTypeInfo = evaluator.getTypeOfFunction(node);
    const returnType = functionTypeInfo?.functionType.shared.declaredReturnType;

    if (!returnType) {
        return undefined;
    }

    if (FunctionType.isGenerator(functionTypeInfo.functionType)) {
        return getDeclaredGeneratorReturnType(functionTypeInfo.functionType);
    }

    return returnType;
}

export function getAliasedSymbolTypeForName(
    evaluator: TypeEvaluator,
    state: TypeEvaluatorState,
    node: ImportAsNode | ImportFromAsNode | ImportFromNode,
    name: string
): Type | undefined {
    const symbolWithScope = evaluator.lookUpSymbolRecursive(node, name, /* honorCodeFlow */ true);
    if (!symbolWithScope) {
        return undefined;
    }

    // Normally there will be at most one decl associated with the import node, but
    // there can be multiple in the case of the "from .X import X" statement. In such
    // case, we want to choose the last declaration.
    const filteredDecls = symbolWithScope.symbol
        .getDeclarations()
        .filter(
            (decl) => ParseTreeUtils.isNodeContainedWithin(node, decl.node) && decl.type === DeclarationType.Alias
        );
    let aliasDecl = filteredDecls.length > 0 ? filteredDecls[filteredDecls.length - 1] : undefined;

    // If we didn't find an exact match, look for any alias associated with
    // this symbol. In cases where we have multiple ImportAs nodes that share
    // the same first-part name (e.g. "import asyncio" and "import asyncio.tasks"),
    // we may not find the declaration associated with this node.
    if (!aliasDecl) {
        aliasDecl = symbolWithScope.symbol.getDeclarations().find((decl) => decl.type === DeclarationType.Alias);
    }

    if (!aliasDecl) {
        return undefined;
    }

    assert(aliasDecl.type === DeclarationType.Alias);

    const fileInfo = AnalyzerNodeInfo.getFileInfo(node);

    // Try to resolve the alias while honoring external visibility.
    const resolvedAliasInfo = evaluator.resolveAliasDeclarationWithInfo(aliasDecl, /* resolveLocalNames */ true, {
        allowExternallyHiddenAccess: fileInfo.isStubFile,
    });

    if (!resolvedAliasInfo) {
        return undefined;
    }

    if (!resolvedAliasInfo.declaration) {
        return state.evaluatorOptions.evaluateUnknownImportsAsAny ? AnyType.create() : UnknownType.create();
    }

    if (node.nodeType === ParseNodeType.ImportFromAs) {
        if (resolvedAliasInfo.isPrivate) {
            evaluator.addDiagnostic(
                DiagnosticRule.reportPrivateUsage,
                LocMessage.privateUsedOutsideOfModule().format({
                    name: node.d.name.d.value,
                }),
                node.d.name
            );
        }

        if (resolvedAliasInfo.privatePyTypedImporter) {
            const diag = new DiagnosticAddendum();
            if (resolvedAliasInfo.privatePyTypedImported) {
                diag.addMessage(
                    LocAddendum.privateImportFromPyTypedSource().format({
                        module: resolvedAliasInfo.privatePyTypedImported,
                    })
                );
            }
            evaluator.addDiagnostic(
                DiagnosticRule.reportPrivateImportUsage,
                LocMessage.privateImportFromPyTypedModule().format({
                    name: node.d.name.d.value,
                    module: resolvedAliasInfo.privatePyTypedImporter,
                }) + diag.getString(),
                node.d.name
            );
        }
    }

    return evaluator.getInferredTypeOfDeclaration(symbolWithScope.symbol, aliasDecl);
}

const maxDeclarationsToUseForInference = 64;
const maxTypedDeclsPerSymbol = 16;

export function getDeclaredTypeOfSymbol(
    evaluator: TypeEvaluator,
    state: TypeEvaluatorState,
    symbol: Symbol,
    usageNode?: NameNode
): DeclaredSymbolTypeInfo {
    const synthesizedType = symbol.getSynthesizedType()?.type;
    if (synthesizedType) {
        return { type: synthesizedType };
    }

    let typedDecls = symbol.getTypedDeclarations();

    if (typedDecls.length === 0) {
        // If the symbol has no type declaration but is assigned many times,
        // treat it as though it has an explicit type annotation of "Unknown".
        // This will avoid a pathological performance condition for unannotated
        // code that reassigns the same variable hundreds of times. If the symbol
        // effectively has an "Any" annotation, it won't be narrowed.
        if (symbol.getDeclarations().length > maxDeclarationsToUseForInference) {
            return { type: UnknownType.create() };
        }

        // There was no declaration with a defined type.
        return { type: undefined };
    }

    // If there is more than one typed decl, filter out any that are not
    // reachable from the usage node (if specified). This can happen in
    // cases where a property symbol is redefined to add a setter, deleter,
    // etc.
    let exceedsMaxDecls = false;
    if (usageNode && typedDecls.length > 1) {
        if (typedDecls.length > maxTypedDeclsPerSymbol) {
            // If there are too many typed decls, don't bother filtering them
            // because this can be very expensive. Simply use the last one
            // in this case.
            typedDecls = [typedDecls[typedDecls.length - 1]];
            exceedsMaxDecls = true;
        } else {
            const filteredTypedDecls = typedDecls.filter((decl) => {
                if (decl.type !== DeclarationType.Alias) {
                    // Is the declaration in the same execution scope as the "usageNode" node?
                    const usageScope = ParseTreeUtils.getExecutionScopeNode(usageNode);
                    const declScope = ParseTreeUtils.getExecutionScopeNode(decl.node);

                    if (usageScope === declScope) {
                        if (!evaluator.isFlowPathBetweenNodes(decl.node, usageNode, /* allowSelf */ false)) {
                            return false;
                        }
                    }
                }
                return true;
            });

            if (filteredTypedDecls.length === 0) {
                return { type: UnboundType.create() };
            }

            typedDecls = filteredTypedDecls;
        }
    }

    // Start with the last decl. If that's already being resolved,
    // use the next-to-last decl, etc. This can happen when resolving
    // property methods. Often the setter method is defined in reference to
    // the initial property, which defines the getter method with the same
    // symbol name.
    let declIndex = typedDecls.length - 1;
    while (declIndex >= 0) {
        const decl = typedDecls[declIndex];

        // If there's a partially-constructed type that is allowed
        // for recursive symbol resolution, return it as the resolved type.
        const partialType = state.getSymbolResolutionPartialType(symbol, decl);
        if (partialType) {
            return { type: partialType };
        }

        if (state.getIndexOfSymbolResolution(symbol, decl) < 0) {
            if (state.pushSymbolResolution(symbol, decl)) {
                try {
                    const declaredTypeInfo = evaluator.getTypeForDeclaration(decl);

                    // If there was recursion detected, don't use this declaration.
                    // The exception is it's a class declaration because getTypeOfClass
                    // handles recursion by populating a partially-created class type
                    // in the type cache. This exception is required to handle the
                    // circular dependency between the "type" and "object" classes in
                    // builtins.pyi (since "object" is a "type" and "type" is an "object").
                    if (state.popSymbolResolution(symbol) || decl.type === DeclarationType.Class) {
                        return declaredTypeInfo;
                    }
                } catch (e: any) {
                    // Clean up the stack before rethrowing.
                    state.popSymbolResolution(symbol);
                    throw e;
                }
            }
        }

        declIndex--;
    }

    return { type: undefined, exceedsMaxDecls };
}

export function lookUpSymbolRecursive(
    evaluator: TypeEvaluator,
    node: ParseNode,
    name: string,
    honorCodeFlow: boolean,
    preferGlobalScope = false
): SymbolWithScope | undefined {
    const scopeNodeInfo = ParseTreeUtils.getEvaluationScopeNode(node);
    const scope = AnalyzerNodeInfo.getScope(scopeNodeInfo.node);

    let symbolWithScope = scope?.lookUpSymbolRecursive(name, { useProxyScope: !!scopeNodeInfo.useProxyScope });
    const scopeType = scope?.type ?? ScopeType.Module;

    // Functions and list comprehensions don't allow access to implicitly
    // aliased symbols in outer scopes if they haven't yet been assigned
    // within the local scope.
    let scopeTypeHonorsCodeFlow = scopeType !== ScopeType.Function && scopeType !== ScopeType.Comprehension;

    // Type parameter scopes don't honor code flow.
    if (symbolWithScope?.scope.type === ScopeType.TypeParameter) {
        scopeTypeHonorsCodeFlow = false;
    }

    if (symbolWithScope && honorCodeFlow && scopeTypeHonorsCodeFlow) {
        // Filter the declarations based on flow reachability.
        const reachableDecl = symbolWithScope.symbol.getDeclarations().find((decl) => {
            if (decl.type !== DeclarationType.Alias && decl.type !== DeclarationType.Intrinsic) {
                // Determine if the declaration is in the same execution scope as the "usageNode" node.
                let usageScopeNode = ParseTreeUtils.getExecutionScopeNode(node);
                const declNode: ParseNode =
                    decl.type === DeclarationType.Class ||
                    decl.type === DeclarationType.Function ||
                    decl.type === DeclarationType.TypeAlias
                        ? decl.node.d.name
                        : decl.node;
                const declScopeNode = ParseTreeUtils.getExecutionScopeNode(declNode);

                // If this is a type parameter scope, it will be a proxy for its
                // containing scope, so we need to use that instead.
                const usageScope = AnalyzerNodeInfo.getScope(usageScopeNode);
                if (usageScope?.proxy) {
                    const typeParamScope = AnalyzerNodeInfo.getScope(usageScopeNode);
                    if (!typeParamScope?.symbolTable.has(name) && usageScopeNode.parent) {
                        usageScopeNode = ParseTreeUtils.getExecutionScopeNode(usageScopeNode.parent);
                    }
                }

                if (usageScopeNode === declScopeNode) {
                    if (!evaluator.isFlowPathBetweenNodes(declNode, node)) {
                        // If there was no control flow path from the usage back
                        // to the source, see if the usage node is reachable by
                        // any path.
                        const flowNode = AnalyzerNodeInfo.getFlowNode(node);
                        const isReachable =
                            flowNode &&
                            evaluator.getNodeReachability(
                                node,
                                /* sourceNode */ undefined,
                                /* ignoreNoReturn */ true
                            ) === Reachability.Reachable;
                        return !isReachable;
                    }
                }
            }
            return true;
        });

        // If none of the declarations are reachable from the current node,
        // search for the symbol in outer scopes.
        if (!reachableDecl) {
            if (symbolWithScope.scope.type !== ScopeType.Function) {
                let nextScopeToSearch = symbolWithScope.scope.parent;
                const isOutsideCallerModule =
                    symbolWithScope.isOutsideCallerModule || symbolWithScope.scope.type === ScopeType.Module;
                let isBeyondExecutionScope =
                    symbolWithScope.isBeyondExecutionScope || symbolWithScope.scope.isIndependentlyExecutable();

                if (symbolWithScope.scope.type === ScopeType.Class) {
                    // There is an odd documented behavior for classes in that
                    // symbol resolution skips to the global scope rather than
                    // the next scope in the chain.
                    const globalScopeResult = symbolWithScope.scope.getGlobalScope();
                    nextScopeToSearch = globalScopeResult.scope;
                    if (globalScopeResult.isBeyondExecutionScope) {
                        isBeyondExecutionScope = true;
                    }
                }

                if (nextScopeToSearch) {
                    symbolWithScope = nextScopeToSearch.lookUpSymbolRecursive(name, {
                        isOutsideCallerModule,
                        isBeyondExecutionScope,
                    });
                } else {
                    symbolWithScope = undefined;
                }
            } else {
                symbolWithScope = undefined;
            }
        }
    }

    // PEP 563 indicates that if a forward reference can be resolved in the module
    // scope (or, by implication, in the builtins scope), it should prefer that
    // resolution over local resolutions.
    if (symbolWithScope && preferGlobalScope) {
        let curSymbolWithScope: SymbolWithScope | undefined = symbolWithScope;
        while (
            curSymbolWithScope.scope.type !== ScopeType.Module &&
            curSymbolWithScope.scope.type !== ScopeType.Builtin &&
            curSymbolWithScope.scope.type !== ScopeType.TypeParameter &&
            curSymbolWithScope.scope.parent
        ) {
            curSymbolWithScope = curSymbolWithScope.scope.parent.lookUpSymbolRecursive(name, {
                isOutsideCallerModule: curSymbolWithScope.isOutsideCallerModule,
                isBeyondExecutionScope:
                    curSymbolWithScope.isBeyondExecutionScope ||
                    curSymbolWithScope.scope.isIndependentlyExecutable(),
            });
            if (!curSymbolWithScope) {
                break;
            }
        }

        if (
            curSymbolWithScope?.scope.type === ScopeType.Module ||
            curSymbolWithScope?.scope.type === ScopeType.Builtin
        ) {
            symbolWithScope = curSymbolWithScope;
        }
    }

    return symbolWithScope;
}

export function getTypeForDeclaration(evaluator: TypeEvaluator, declaration: Declaration): DeclaredSymbolTypeInfo {
    switch (declaration.type) {
        case DeclarationType.Intrinsic: {
            if (declaration.intrinsicType === 'Any') {
                return { type: AnyType.create() };
            }

            if (declaration.intrinsicType === '__class__') {
                const classNode = ParseTreeUtils.getEnclosingClass(declaration.node) as ClassNode;
                const classTypeInfo = evaluator.getTypeOfClass(classNode);
                return {
                    type: classTypeInfo
                        ? specializeWithUnknownTypeArgs(classTypeInfo.classType, evaluator.getTupleClassType())
                        : UnknownType.create(),
                };
            }

            const strType = evaluator.getBuiltInObject(declaration.node, 'str');
            const intType = evaluator.getBuiltInObject(declaration.node, 'int');
            if (isClassInstance(intType) && isClassInstance(strType)) {
                if (declaration.intrinsicType === 'str') {
                    return { type: strType };
                }

                if (declaration.intrinsicType === 'str | None') {
                    return { type: combineTypes([strType, evaluator.getNoneType()]) };
                }

                if (declaration.intrinsicType === 'int') {
                    return { type: intType };
                }

                if (declaration.intrinsicType === 'MutableSequence[str]') {
                    const sequenceType = evaluator.getBuiltInType(declaration.node, 'MutableSequence');
                    if (isInstantiableClass(sequenceType)) {
                        return {
                            type: ClassType.cloneAsInstance(ClassType.specialize(sequenceType, [strType])),
                        };
                    }
                }

                if (declaration.intrinsicType === 'dict[str, Any]') {
                    const dictType = evaluator.getBuiltInType(declaration.node, 'dict');
                    if (isInstantiableClass(dictType)) {
                        return {
                            type: ClassType.cloneAsInstance(
                                ClassType.specialize(dictType, [strType, AnyType.create()])
                            ),
                        };
                    }
                }
            }

            return { type: UnknownType.create() };
        }

        case DeclarationType.Class: {
            const classTypeInfo = evaluator.getTypeOfClass(declaration.node);
            return { type: classTypeInfo?.decoratedType };
        }

        case DeclarationType.SpecialBuiltInClass: {
            return { type: evaluator.getTypeOfAnnotation(declaration.node.d.annotation) };
        }

        case DeclarationType.Function: {
            const functionTypeInfo = evaluator.getTypeOfFunction(declaration.node);
            return { type: functionTypeInfo?.decoratedType };
        }

        case DeclarationType.TypeAlias: {
            return { type: evaluator.getTypeOfTypeAlias(declaration.node) };
        }

        case DeclarationType.Param: {
            let typeAnnotationNode = declaration.node.d.annotation ?? declaration.node.d.annotationComment;

            // If there wasn't an annotation, see if the parent function
            // has a function-level annotation comment that provides
            // this parameter's annotation type.
            if (!typeAnnotationNode) {
                if (declaration.node.parent?.nodeType === ParseNodeType.Function) {
                    const functionNode = declaration.node.parent;
                    if (
                        functionNode.d.funcAnnotationComment &&
                        !functionNode.d.funcAnnotationComment.d.isEllipsis
                    ) {
                        const paramIndex = functionNode.d.params.findIndex((param) => param === declaration.node);
                        typeAnnotationNode = ParseTreeUtils.getTypeAnnotationForParam(functionNode, paramIndex);
                    }
                }
            }

            if (typeAnnotationNode) {
                let declaredType = evaluator.getTypeOfParamAnnotation(typeAnnotationNode, declaration.node.d.category);

                const liveTypeVarScopes = ParseTreeUtils.getTypeVarScopesForNode(declaration.node);
                declaredType = makeTypeVarsBound(declaredType, liveTypeVarScopes);

                return {
                    type: evaluator.transformVariadicParamType(
                        declaration.node,
                        declaration.node.d.category,
                        evaluator.adjustParamAnnotatedType(declaration.node, declaredType)
                    ),
                };
            }

            return { type: undefined };
        }

        case DeclarationType.TypeParam: {
            return { type: evaluator.getTypeOfTypeParam(declaration.node) };
        }

        case DeclarationType.Variable: {
            const typeAnnotationNode = declaration.typeAnnotationNode;

            if (typeAnnotationNode) {
                let declaredType: Type | undefined;

                if (declaration.isRuntimeTypeExpression) {
                    declaredType = convertToInstance(
                        evaluator.getTypeOfExpressionExpectingType(typeAnnotationNode, {
                            allowFinal: true,
                            allowRequired: true,
                            allowReadOnly: true,
                            runtimeTypeExpression: true,
                        }).type
                    );
                } else {
                    const declNode =
                        declaration.isDefinedByMemberAccess &&
                        declaration.node.parent?.nodeType === ParseNodeType.MemberAccess
                            ? declaration.node.parent
                            : declaration.node;
                    const allowClassVar = evaluator.isClassVarAllowedForAssignmentTarget(declNode);
                    const allowFinal = evaluator.isFinalAllowedForAssignmentTarget(declNode);
                    const allowRequired =
                        ParseTreeUtils.isRequiredAllowedForAssignmentTarget(declNode) ||
                        !!declaration.isInInlinedTypedDict;

                    declaredType = evaluator.getTypeOfAnnotation(typeAnnotationNode, {
                        varTypeAnnotation: true,
                        allowClassVar,
                        allowFinal,
                        allowRequired,
                        allowReadOnly: allowRequired,
                        enforceClassTypeVarScope: declaration.isDefinedByMemberAccess,
                    });
                }

                if (declaredType) {
                    // If this is a declaration for a member variable within a method,
                    // we need to convert any bound TypeVars associated with the
                    // class to their free counterparts.
                    if (declaration.isDefinedByMemberAccess) {
                        const enclosingClass = ParseTreeUtils.getEnclosingClass(declaration.node);

                        if (enclosingClass) {
                            declaredType = makeTypeVarsFree(declaredType, [
                                ParseTreeUtils.getScopeIdForNode(enclosingClass),
                            ]);
                        }
                    }

                    if (isClassInstance(declaredType) && ClassType.isBuiltIn(declaredType, 'TypeAlias')) {
                        return { type: undefined, isTypeAlias: true };
                    }

                    return { type: declaredType };
                }
            }

            return { type: undefined };
        }

        case DeclarationType.Alias: {
            return { type: undefined };
        }
    }
}

export function getDeclaredTypeForExpression(
    evaluator: TypeEvaluator,
    expression: ExpressionNode,
    usage?: EvaluatorUsage
): Type | undefined {
    let symbol: Symbol | undefined;
    let selfType: ClassType | TypeVarType | undefined;
    let classOrObjectBase: ClassType | undefined;
    let memberAccessClass: Type | undefined;
    let bindFunction = true;
    let useDescriptorSetterType = false;

    switch (expression.nodeType) {
        case ParseNodeType.Name: {
            const symbolWithScope = evaluator.lookUpSymbolRecursive(
                expression,
                expression.d.value,
                /* honorCodeFlow */ true
            );
            if (symbolWithScope) {
                symbol = symbolWithScope.symbol;

                if (
                    !evaluator.getDeclaredTypeOfSymbol(symbol, expression)?.type &&
                    symbolWithScope.scope.type === ScopeType.Class
                ) {
                    const enclosingClass = ParseTreeUtils.getEnclosingClassOrFunction(expression);
                    if (enclosingClass && enclosingClass.nodeType === ParseNodeType.Class) {
                        const classTypeInfo = evaluator.getTypeOfClass(enclosingClass);
                        if (classTypeInfo) {
                            const classMemberInfo = lookUpClassMember(
                                classTypeInfo.classType,
                                expression.d.value,
                                MemberAccessFlags.SkipInstanceMembers | MemberAccessFlags.DeclaredTypesOnly
                            );
                            if (classMemberInfo) {
                                symbol = classMemberInfo.symbol;
                            }
                        }
                    }
                }
            }
            break;
        }

        case ParseNodeType.TypeAnnotation: {
            return getDeclaredTypeForExpression(evaluator, expression.d.valueExpr, usage);
        }

        case ParseNodeType.MemberAccess: {
            const baseType = evaluator.getTypeOfExpression(
                expression.d.leftExpr,
                EvalFlags.MemberAccessBaseDefaults
            ).type;
            const baseTypeConcrete = evaluator.makeTopLevelTypeVarsConcrete(baseType);
            const memberName = expression.d.member.d.value;

            doForEachSubtype(
                baseTypeConcrete,
                (baseSubtype) => {
                    if (isClassInstance(baseSubtype)) {
                        const classMemberInfo = lookUpObjectMember(
                            baseSubtype,
                            memberName,
                            MemberAccessFlags.DeclaredTypesOnly
                        );

                        classOrObjectBase = baseSubtype;
                        memberAccessClass = classMemberInfo?.classType;
                        symbol = classMemberInfo?.symbol;
                        useDescriptorSetterType = true;
                        bindFunction = !classMemberInfo?.isInstanceMember;
                    } else if (isInstantiableClass(baseSubtype)) {
                        const classMemberInfo = lookUpClassMember(
                            baseSubtype,
                            memberName,
                            MemberAccessFlags.SkipInstanceMembers | MemberAccessFlags.DeclaredTypesOnly
                        );

                        classOrObjectBase = baseSubtype;
                        memberAccessClass = classMemberInfo?.classType;
                        symbol = classMemberInfo?.symbol;
                        useDescriptorSetterType = false;
                        bindFunction = true;
                    } else if (isModule(baseSubtype)) {
                        classOrObjectBase = undefined;
                        memberAccessClass = undefined;
                        symbol = ModuleType.getField(baseSubtype, memberName);
                        if (symbol && !symbol.hasTypedDeclarations()) {
                            symbol = undefined;
                        }
                        useDescriptorSetterType = false;
                        bindFunction = false;
                    }
                },
                /* sortSubtypes */ true
            );

            if (isTypeVar(baseType)) {
                selfType = baseType;
            }
            break;
        }

        case ParseNodeType.Index: {
            const baseType = evaluator.makeTopLevelTypeVarsConcrete(
                evaluator.getTypeOfExpression(expression.d.leftExpr, EvalFlags.IndexBaseDefaults).type
            );

            if (baseType && isClassInstance(baseType)) {
                if (ClassType.isTypedDictClass(baseType)) {
                    const typeFromTypedDict = getTypeOfIndexedTypedDict(
                        evaluator,
                        expression,
                        baseType,
                        usage || { method: 'get' }
                    );
                    if (typeFromTypedDict) {
                        return typeFromTypedDict.type;
                    }
                }

                let setItemType = evaluator.getBoundMagicMethod(baseType, '__setitem__');
                if (!setItemType) {
                    break;
                }

                if (isOverloaded(setItemType)) {
                    const expectsSlice =
                        expression.d.items.length === 1 &&
                        expression.d.items[0].d.valueExpr.nodeType === ParseNodeType.Slice;
                    const overloads = OverloadedType.getOverloads(setItemType);
                    setItemType = overloads.find((overload) => {
                        if (overload.shared.parameters.length < 2) {
                            return false;
                        }

                        const keyType = FunctionType.getParamType(overload, 0);
                        const isSlice = isClassInstance(keyType) && ClassType.isBuiltIn(keyType, 'slice');
                        return expectsSlice === isSlice;
                    });

                    if (!setItemType) {
                        break;
                    }
                }

                if (isFunction(setItemType) && setItemType.shared.parameters.length >= 2) {
                    const paramType = FunctionType.getParamType(setItemType, 1);
                    if (!isAnyOrUnknown(paramType)) {
                        return paramType;
                    }
                }
            }
            break;
        }

        case ParseNodeType.Tuple: {
            if (
                expression.d.items.length > 0 &&
                !expression.d.items.some((item) => item.nodeType === ParseNodeType.Unpack)
            ) {
                const itemTypes: Type[] = [];
                expression.d.items.forEach((expr) => {
                    const itemType = getDeclaredTypeForExpression(evaluator, expr, usage);
                    if (itemType) {
                        itemTypes.push(itemType);
                    }
                });

                if (itemTypes.length === expression.d.items.length) {
                    return makeTupleObject(
                        evaluator,
                        itemTypes.map((t) => {
                            return { type: t, isUnbounded: false };
                        })
                    );
                }
            }
            break;
        }
    }

    if (symbol) {
        let declaredType = evaluator.getDeclaredTypeOfSymbol(symbol)?.type;
        if (declaredType) {
            if (useDescriptorSetterType && isClassInstance(declaredType)) {
                const setter = evaluator.getBoundMagicMethod(declaredType, '__set__');
                if (setter && isFunction(setter) && setter.shared.parameters.length >= 2) {
                    declaredType = FunctionType.getParamType(setter, 1);

                    if (isAnyOrUnknown(declaredType)) {
                        return undefined;
                    }
                }
            }

            if (classOrObjectBase) {
                if (memberAccessClass && isInstantiableClass(memberAccessClass)) {
                    declaredType = partiallySpecializeType(
                        declaredType,
                        memberAccessClass,
                        evaluator.getTypeClassType(),
                        selfType
                    );
                }

                if (isFunctionOrOverloaded(declaredType)) {
                    if (bindFunction) {
                        declaredType = evaluator.bindFunctionToClassOrObject(
                            classOrObjectBase,
                            declaredType,
                            /* memberClass */ undefined,
                            /* treatConstructorAsClassMethod */ undefined,
                            selfType
                        );
                    }
                }
            }

            return declaredType;
        }
    }

    return undefined;
}

export function inferVarianceForClass(evaluator: TypeEvaluator, classType: ClassType): void {
    if (!classType.shared.requiresVarianceInference) {
        return;
    }

    classType.shared.requiresVarianceInference = false;

    classType.shared.typeParams.forEach((param) => {
        if (param.shared.declaredVariance === Variance.Auto) {
            param.priv.computedVariance = Variance.Unknown;
        }
    });

    const dummyTypeObject = ClassType.createInstantiable(
        '__varianceDummy',
        '',
        '',
        Uri.empty(),
        0,
        0,
        undefined,
        undefined
    );

    classType.shared.typeParams.forEach((param, paramIndex) => {
        if (isTypeVarTuple(param) || isParamSpec(param)) {
            return;
        }

        if (param.shared.declaredVariance !== Variance.Auto) {
            return;
        }

        const srcTypeArgs = classType.shared.typeParams.map((p, i) => {
            if (isTypeVarTuple(p)) {
                return p;
            }
            return i === paramIndex ? evaluator.getObjectType() : dummyTypeObject;
        });

        const destTypeArgs = classType.shared.typeParams.map((p, i) => {
            return i === paramIndex || isTypeVarTuple(p) ? p : dummyTypeObject;
        });

        const srcType = ClassType.specialize(classType, srcTypeArgs);
        const destType = ClassType.specialize(classType, destTypeArgs);

        const isDestSubtypeOfSrc = evaluator.assignClassToSelf(srcType, destType, Variance.Covariant);

        let inferredVariance: Variance;
        if (isDestSubtypeOfSrc) {
            inferredVariance = Variance.Covariant;
        } else {
            const isSrcSubtypeOfDest = evaluator.assignClassToSelf(destType, srcType, Variance.Contravariant);
            if (isSrcSubtypeOfDest) {
                inferredVariance = Variance.Contravariant;
            } else {
                inferredVariance = Variance.Invariant;
            }
        }

        classType.shared.typeParams[paramIndex].priv.computedVariance = inferredVariance;
    });
}
