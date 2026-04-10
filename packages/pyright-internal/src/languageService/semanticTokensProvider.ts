/*
 * semanticTokensProvider.ts
 *
 * Implements LSP semantic tokens:
 * - textDocument/semanticTokens/full
 * - textDocument/semanticTokens/range
 */

import {
    CancellationToken,
    SemanticTokens,
    SemanticTokensBuilder,
    SemanticTokenTypes,
} from 'vscode-languageserver';

import { DeclarationType } from '../analyzer/declaration';
import * as ParseTreeUtils from '../analyzer/parseTreeUtils';
import { ParseTreeWalker } from '../analyzer/parseTreeWalker';
import { TypeEvaluator } from '../analyzer/typeEvaluatorTypes';
import { ClassType, isClass, isModule } from '../analyzer/types';
import { throwIfCancellationRequested } from '../common/cancellationUtils';
import { ProgramView } from '../common/extensibility';
import { convertOffsetToPosition } from '../common/positionUtils';
import { Range as PositionRange } from '../common/textRange';
import { TextRangeCollection } from '../common/textRangeCollection';
import { Uri } from '../common/uri/uri';
import { MemberAccessNode, NameNode, ParseNodeType } from '../parser/parseNodes';
import { ParseFileResults } from '../parser/parser';

export const tokenLegend = {
    tokenTypes: [
        SemanticTokenTypes.namespace,
        SemanticTokenTypes.type,
        SemanticTokenTypes.class,
        SemanticTokenTypes.enum,
        SemanticTokenTypes.interface,
        SemanticTokenTypes.struct,
        SemanticTokenTypes.typeParameter,
        SemanticTokenTypes.parameter,
        SemanticTokenTypes.variable,
        SemanticTokenTypes.property,
        SemanticTokenTypes.enumMember,
        SemanticTokenTypes.event,
        SemanticTokenTypes.function,
        SemanticTokenTypes.method,
        SemanticTokenTypes.macro,
        SemanticTokenTypes.keyword,
        SemanticTokenTypes.modifier,
        SemanticTokenTypes.comment,
        SemanticTokenTypes.string,
        SemanticTokenTypes.number,
        SemanticTokenTypes.regexp,
        SemanticTokenTypes.operator,
        SemanticTokenTypes.decorator,
    ],
    tokenModifiers: [] as string[],
};

function _getTokenTypeIndex(tokenType: string): number {
    const index = tokenLegend.tokenTypes.indexOf(tokenType as SemanticTokenTypes);
    return index >= 0 ? index : -1;
}

export class SemanticTokensProvider {
    private readonly _parseResults: ParseFileResults | undefined;

    constructor(
        private _program: ProgramView,
        private _fileUri: Uri,
        private _token: CancellationToken,
        private _range?: PositionRange
    ) {
        this._parseResults = this._program.getParseResults(this._fileUri);
    }

    private get _evaluator(): TypeEvaluator {
        return this._program.evaluator!;
    }

    getTokens(): SemanticTokens | null {
        throwIfCancellationRequested(this._token);

        if (!this._parseResults) {
            return null;
        }

        const builder = new SemanticTokensBuilder();
        const lines = this._parseResults.tokenizerOutput.lines;
        const walker = new SemanticTokenWalker(this._evaluator, builder, lines, this._range, this._token);
        walker.walk(this._parseResults.parserOutput.parseTree);

        return builder.build();
    }
}

class SemanticTokenWalker extends ParseTreeWalker {
    constructor(
        private _evaluator: TypeEvaluator,
        private _builder: SemanticTokensBuilder,
        private _lines: TextRangeCollection<{ start: number; length: number }>,
        private _range: PositionRange | undefined,
        private _token: CancellationToken
    ) {
        super();
    }

    override visitName(node: NameNode): boolean {
        throwIfCancellationRequested(this._token);

        // Skip names inside import statements — they get syntax highlighting already
        if (this._isImportName(node)) {
            return false;
        }

        const tokenType = this._classifyName(node);
        if (tokenType) {
            this._pushToken(node, tokenType);
        }

        return false; // NameNode has no children
    }

    override visitMemberAccess(node: MemberAccessNode): boolean {
        throwIfCancellationRequested(this._token);

        // Walk leftExpr normally (it's the object)
        this.walk(node.d.leftExpr);

        // Classify the member name
        const tokenType = this._classifyName(node.d.member);
        if (tokenType) {
            this._pushToken(node.d.member, tokenType);
        }

        return false; // We handled children manually
    }

    private _classifyName(node: NameNode): string | undefined {
        const declInfo = this._evaluator.getDeclInfoForNameNode(node);

        if (!declInfo || declInfo.decls.length === 0) {
            return undefined;
        }

        let decl = declInfo.decls[0];

        // Module references (e.g. `os` in `os.path.join`) should be classified
        // as namespace. Check the type before alias resolution since modules
        // don't have a DeclarationType — they're always reached through aliases.
        if (decl.type === DeclarationType.Alias) {
            const type = this._evaluator.getType(node);
            if (type && isModule(type)) {
                return SemanticTokenTypes.namespace;
            }

            const resolved = this._evaluator.resolveAliasDeclaration(decl, /* resolveLocalNames */ true);
            if (resolved) {
                decl = resolved;
            } else {
                return undefined;
            }
        }

        // Check for decorator context
        if (node.parent?.nodeType === ParseNodeType.Decorator) {
            return SemanticTokenTypes.decorator;
        }

        switch (decl.type) {
            case DeclarationType.Class:
            case DeclarationType.SpecialBuiltInClass:
                return SemanticTokenTypes.class;

            case DeclarationType.Function: {
                const enclosingClass = ParseTreeUtils.getEnclosingClass(decl.node, /* stopAtFunction */ true);
                return enclosingClass ? SemanticTokenTypes.method : SemanticTokenTypes.function;
            }

            case DeclarationType.Param:
                return SemanticTokenTypes.parameter;

            case DeclarationType.TypeParam:
                return SemanticTokenTypes.typeParameter;

            case DeclarationType.TypeAlias:
                return SemanticTokenTypes.type;

            case DeclarationType.Variable: {
                // Check for enum member or property: variable directly inside a class (not inside a method)
                const enclosingClass = ParseTreeUtils.getEnclosingClass(decl.node, /* stopAtFunction */ true);
                if (enclosingClass) {
                    const classType = this._evaluator.getType(enclosingClass.d.name);
                    if (classType && isClass(classType) && ClassType.isEnumClass(classType)) {
                        return SemanticTokenTypes.enumMember;
                    }
                    return SemanticTokenTypes.property;
                }
                return SemanticTokenTypes.variable;
            }

            case DeclarationType.Intrinsic:
                return SemanticTokenTypes.variable;

            default:
                return undefined;
        }
    }

    private _isImportName(node: NameNode): boolean {
        const parent = node.parent;
        if (!parent) {
            return false;
        }

        return (
            parent.nodeType === ParseNodeType.ImportAs ||
            parent.nodeType === ParseNodeType.ImportFromAs ||
            parent.nodeType === ParseNodeType.ModuleName
        );
    }

    private _pushToken(node: NameNode, tokenType: string): void {
        const position = convertOffsetToPosition(node.start, this._lines);

        // Range filtering
        if (this._range) {
            if (
                position.line < this._range.start.line ||
                (position.line === this._range.start.line && position.character < this._range.start.character) ||
                position.line > this._range.end.line ||
                (position.line === this._range.end.line && position.character >= this._range.end.character)
            ) {
                return;
            }
        }

        const tokenTypeIndex = _getTokenTypeIndex(tokenType);
        if (tokenTypeIndex < 0) {
            return;
        }

        this._builder.push(position.line, position.character, node.d.value.length, tokenTypeIndex, 0);
    }
}
