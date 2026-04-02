/*
 * symbolResolution.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 *
 * Functions for symbol and declaration resolution extracted from
 * the createTypeEvaluator closure.
 */

import { appendArray } from '../common/collectionUtils';
import { NameNode, ParseNodeType, StringNode } from '../parser/parseNodes';
import * as AnalyzerNodeInfo from './analyzerNodeInfo';
import { Declaration, DeclarationType, FunctionDeclaration } from './declaration';
import { getFunctionInfoFromDecorators } from './decorators';
import { getParamListDetails } from './parameterUtils';
import * as ParseTreeUtils from './parseTreeUtils';
import { SynthesizedTypeInfo } from './symbol';
import { getLastTypedDeclarationForSymbol } from './symbolUtils';
import {
    AbstractSymbol,
    SymbolDeclInfo,
    TypeEvaluator,
} from './typeEvaluatorTypes';
import {
    ClassType,
    FunctionType,
    FunctionTypeFlags,
    isClassInstance,
    isFunction,
    isInstantiableClass,
} from './types';
import {
    derivesFromStdlibClass,
    doForEachSubtype,
    lookUpClassMember,
    lookUpObjectMember,
} from './typeUtils';

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
