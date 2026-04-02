/*
 * symbolResolution.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 *
 * Functions for symbol and declaration resolution extracted from
 * the createTypeEvaluator closure.
 */

import { NameNode, ParseNodeType } from '../parser/parseNodes';
import * as AnalyzerNodeInfo from './analyzerNodeInfo';
import { Declaration, DeclarationType } from './declaration';
import { getParamListDetails } from './parameterUtils';
import { ClassType, FunctionType, isClassInstance, isFunction } from './types';
import { TypeEvaluator } from './typeEvaluatorTypes';
import { lookUpClassMember } from './typeUtils';

import { appendArray } from '../common/collectionUtils';
import { StringNode } from '../parser/parseNodes';
import { SynthesizedTypeInfo } from './symbol';
import { SymbolDeclInfo } from './typeEvaluatorTypes';
import { doForEachSubtype, lookUpObjectMember } from './typeUtils';

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
