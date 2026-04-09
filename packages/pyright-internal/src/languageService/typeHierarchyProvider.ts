/*
 * typeHierarchyProvider.ts
 *
 * Implements the LSP type hierarchy protocol:
 * - textDocument/prepareTypeHierarchy
 * - typeHierarchy/supertypes
 * - typeHierarchy/subtypes
 */

import { CancellationToken, SymbolKind, TypeHierarchyItem } from 'vscode-languageserver';

import { DeclarationType } from '../analyzer/declaration';
import * as ParseTreeUtils from '../analyzer/parseTreeUtils';
import { isUserCode } from '../analyzer/sourceFileInfoUtils';
import { TypeEvaluator } from '../analyzer/typeEvaluatorTypes';
import { ClassType, isClass } from '../analyzer/types';
import { throwIfCancellationRequested } from '../common/cancellationUtils';
import { ProgramView } from '../common/extensibility';
import { ReadOnlyFileSystem } from '../common/fileSystem';
import { convertOffsetsToRange, convertPositionToOffset } from '../common/positionUtils';
import { Position } from '../common/textRange';
import { Uri } from '../common/uri/uri';
import { convertUriToLspUriString } from '../common/uri/uriUtils';
import { canNavigateToFile } from './navigationUtils';
import { ClassNode, ParseNodeType, StatementNode } from '../parser/parseNodes';
import { ParseFileResults } from '../parser/parser';

export class TypeHierarchyProvider {
    private readonly _parseResults: ParseFileResults | undefined;
    private _classType: ClassType | undefined;

    constructor(
        private _program: ProgramView,
        private _fileUri: Uri,
        private _position: Position,
        private _token: CancellationToken
    ) {
        this._parseResults = this._program.getParseResults(this._fileUri);
    }

    private get _evaluator(): TypeEvaluator {
        return this._program.evaluator!;
    }

    private get _fs(): ReadOnlyFileSystem {
        return this._program.fileSystem;
    }

    onPrepare(): TypeHierarchyItem[] | null {
        throwIfCancellationRequested(this._token);

        if (!this._parseResults) {
            return null;
        }

        const offset = convertPositionToOffset(this._position, this._parseResults.tokenizerOutput.lines);
        if (offset === undefined) {
            return null;
        }

        const node = ParseTreeUtils.findNodeByOffset(this._parseResults.parserOutput.parseTree, offset);
        if (!node || node.nodeType !== ParseNodeType.Name) {
            return null;
        }

        let classNode: ClassNode | undefined;

        // Case 1: Cursor is on the name of a class definition.
        const parent = node.parent;
        if (parent?.nodeType === ParseNodeType.Class && parent.d.name === node) {
            classNode = parent;
        } else {
            // Case 2: Cursor is on a name that resolves to a class (e.g., base class reference).
            const declInfo = this._evaluator.getDeclInfoForNameNode(node);
            if (!declInfo?.decls || declInfo.decls.length === 0) {
                return null;
            }

            for (const decl of declInfo.decls) {
                const resolvedDecl =
                    decl.type === DeclarationType.Alias
                        ? this._evaluator.resolveAliasDeclaration(decl, true)
                        : decl;
                if (resolvedDecl?.type === DeclarationType.Class) {
                    classNode = resolvedDecl.node as ClassNode;
                    break;
                }
            }
        }

        if (!classNode) {
            return null;
        }

        const classTypeResult = this._evaluator.getTypeOfClass(classNode);
        if (!classTypeResult) {
            return null;
        }

        this._classType = classTypeResult.classType;

        const item = this._buildItemForClassNode(classNode);
        if (!item) {
            return null;
        }

        return [item];
    }

    getSupertypes(): TypeHierarchyItem[] | null {
        throwIfCancellationRequested(this._token);

        if (!this._classType) {
            return null;
        }

        const items: TypeHierarchyItem[] = [];

        for (const baseClass of this._classType.shared.baseClasses) {
            if (!isClass(baseClass)) {
                continue;
            }

            const classDecl = baseClass.shared.declaration;
            if (!classDecl) {
                continue;
            }

            const classNode = classDecl.node as ClassNode;
            const item = this._buildItemForClassNode(classNode);
            if (item) {
                items.push(item);
            }
        }

        return items.length > 0 ? items : null;
    }

    getSubtypes(): TypeHierarchyItem[] | null {
        throwIfCancellationRequested(this._token);

        if (!this._classType) {
            return null;
        }

        const items: TypeHierarchyItem[] = [];
        const targetClass = this._classType;

        for (const sourceFileInfo of this._program.getSourceFileInfoList()) {
            throwIfCancellationRequested(this._token);

            if (!isUserCode(sourceFileInfo) && !sourceFileInfo.isOpenByClient) {
                continue;
            }

            const parseResults = this._program.getParseResults(sourceFileInfo.uri);
            if (!parseResults) {
                continue;
            }

            this._collectDirectSubclasses(
                parseResults.parserOutput.parseTree.d.statements,
                targetClass,
                parseResults,
                items
            );

            this._program.handleMemoryHighUsage();
        }

        return items.length > 0 ? items : null;
    }

    private _collectDirectSubclasses(
        statements: StatementNode[],
        targetClass: ClassType,
        parseResults: ParseFileResults,
        results: TypeHierarchyItem[]
    ) {
        for (const statement of statements) {
            if (statement.nodeType === ParseNodeType.Class) {
                const classTypeResult = this._evaluator.getTypeOfClass(statement);
                if (classTypeResult && !ClassType.isSameGenericClass(classTypeResult.classType, targetClass)) {
                    // Check if targetClass is a direct base class (not transitive).
                    const isDirectSubclass = classTypeResult.classType.shared.baseClasses.some(
                        (base) => isClass(base) && ClassType.isSameGenericClass(base, targetClass)
                    );

                    if (isDirectSubclass) {
                        const item = this._buildItemForClassNode(statement);
                        if (item) {
                            results.push(item);
                        }
                    }
                }

                // Recurse into nested classes.
                this._collectDirectSubclasses(
                    statement.d.suite.d.statements,
                    targetClass,
                    parseResults,
                    results
                );
            }
        }
    }

    private _buildItemForClassNode(classNode: ClassNode): TypeHierarchyItem | undefined {
        // Find the declaration to get the URI for the file containing this class.
        const nameNode = classNode.d.name;
        const declInfo = this._evaluator.getDeclInfoForNameNode(nameNode);
        const classDecl = declInfo?.decls?.find((d) => d.type === DeclarationType.Class);

        const fileUri = classDecl?.uri ?? this._fileUri;
        const parseResults = this._program.getParseResults(fileUri);
        if (!parseResults) {
            return undefined;
        }

        const lspUri = convertUriToLspUriString(this._fs, fileUri);
        if (!canNavigateToFile(this._fs, Uri.parse(lspUri, this._program.serviceProvider))) {
            return undefined;
        }

        return {
            name: nameNode.d.value,
            kind: SymbolKind.Class,
            uri: lspUri,
            range: convertOffsetsToRange(
                classNode.start,
                classNode.start + classNode.length,
                parseResults.tokenizerOutput.lines
            ),
            selectionRange: convertOffsetsToRange(
                nameNode.start,
                nameNode.start + nameNode.length,
                parseResults.tokenizerOutput.lines
            ),
        };
    }
}
