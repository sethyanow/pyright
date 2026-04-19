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
import { ClassType, FunctionType, isClass, isFunction, isModule } from '../analyzer/types';
import { lookUpClassMember, MemberAccessFlags } from '../analyzer/typeUtils';
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
    tokenModifiers: ['abstract', 'protocol', 'override'] as string[],
};

function _getTokenTypeIndex(tokenType: string): number {
    const index = tokenLegend.tokenTypes.indexOf(tokenType as SemanticTokenTypes);
    return index >= 0 ? index : -1;
}

function _getModifierBitset(...modifiers: string[]): number {
    let bitset = 0;
    for (const mod of modifiers) {
        const idx = tokenLegend.tokenModifiers.indexOf(mod);
        if (idx >= 0) {
            bitset |= 1 << idx;
        }
    }
    return bitset;
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

        const classification = this._classifyName(node);
        if (classification) {
            this._pushToken(node, classification.tokenType, classification.modifiers);
        }

        return false; // NameNode has no children
    }

    override visitMemberAccess(node: MemberAccessNode): boolean {
        throwIfCancellationRequested(this._token);

        // Walk leftExpr normally (it's the object)
        this.walk(node.d.leftExpr);

        // Classify the member name
        const classification = this._classifyName(node.d.member);
        if (classification) {
            this._pushToken(node.d.member, classification.tokenType, classification.modifiers);
        }

        return false; // We handled children manually
    }

    private _classifyName(node: NameNode): { tokenType: string; modifiers: number } | undefined {
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
                return { tokenType: SemanticTokenTypes.namespace, modifiers: 0 };
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
            return { tokenType: SemanticTokenTypes.decorator, modifiers: 0 };
        }

        switch (decl.type) {
            case DeclarationType.Class:
            case DeclarationType.SpecialBuiltInClass: {
                const classType = this._evaluator.getType(node);
                const mods: string[] = [];
                if (classType && isClass(classType)) {
                    if (ClassType.isProtocolClass(classType)) {
                        mods.push('protocol');
                    }
                    // Check if class declares any abstract methods (not just inherits ABCMeta)
                    if (this._classDeclaresAbstractMethods(classType)) {
                        mods.push('abstract');
                    }
                }
                return { tokenType: SemanticTokenTypes.class, modifiers: _getModifierBitset(...mods) };
            }

            case DeclarationType.Function: {
                const enclosingClass = ParseTreeUtils.getEnclosingClass(decl.node, /* stopAtFunction */ true);
                const tokenType = enclosingClass ? SemanticTokenTypes.method : SemanticTokenTypes.function;
                const mods: string[] = [];

                const funcType = this._evaluator.getType(node);
                if (funcType && isFunction(funcType)) {
                    // Check for @abstractmethod
                    if (FunctionType.isAbstractMethod(funcType)) {
                        mods.push('abstract');
                    }

                    // Check for explicit @override or implicit override
                    if (FunctionType.isOverridden(funcType)) {
                        mods.push('override');
                    } else if (enclosingClass) {
                        // Check for implicit override (method shadows parent without @override)
                        // Exclude dunder methods — they're expected to shadow built-in methods
                        const methodName = node.d.value;
                        const isDunder = methodName.startsWith('__') && methodName.endsWith('__');
                        if (!isDunder) {
                            const enclosingClassType = this._evaluator.getType(enclosingClass.d.name);
                            if (enclosingClassType && isClass(enclosingClassType)) {
                                // Look up in parent classes only (skip the declaring class)
                                const parentMember = lookUpClassMember(
                                    enclosingClassType,
                                    methodName,
                                    MemberAccessFlags.Default,
                                    enclosingClassType
                                );
                                if (parentMember) {
                                    mods.push('override');
                                }
                            }
                        }
                    }
                }

                return { tokenType, modifiers: _getModifierBitset(...mods) };
            }

            case DeclarationType.Param:
                return { tokenType: SemanticTokenTypes.parameter, modifiers: 0 };

            case DeclarationType.TypeParam:
                return { tokenType: SemanticTokenTypes.typeParameter, modifiers: 0 };

            case DeclarationType.TypeAlias:
                return { tokenType: SemanticTokenTypes.type, modifiers: 0 };

            case DeclarationType.Variable: {
                // Check for enum member or property: variable directly inside a class (not inside a method)
                const enclosingClass = ParseTreeUtils.getEnclosingClass(decl.node, /* stopAtFunction */ true);
                if (enclosingClass) {
                    const classType = this._evaluator.getType(enclosingClass.d.name);
                    if (classType && isClass(classType) && ClassType.isEnumClass(classType)) {
                        return { tokenType: SemanticTokenTypes.enumMember, modifiers: 0 };
                    }
                    return { tokenType: SemanticTokenTypes.property, modifiers: 0 };
                }
                return { tokenType: SemanticTokenTypes.variable, modifiers: 0 };
            }

            case DeclarationType.Intrinsic:
                return { tokenType: SemanticTokenTypes.variable, modifiers: 0 };

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

    private _classDeclaresAbstractMethods(classType: ClassType): boolean {
        // Check if this class directly declares any abstract methods
        // (not just inherited abstract status from ABCMeta)
        for (const [, symbol] of classType.shared.fields) {
            const decls = symbol.getDeclarations();
            for (const decl of decls) {
                if (decl.type === DeclarationType.Function) {
                    const funcType = this._evaluator.getTypeOfFunction(decl.node);
                    if (funcType && FunctionType.isAbstractMethod(funcType.functionType)) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    private _pushToken(node: NameNode, tokenType: string, modifiers: number = 0): void {
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

        this._builder.push(position.line, position.character, node.d.value.length, tokenTypeIndex, modifiers);
    }
}
