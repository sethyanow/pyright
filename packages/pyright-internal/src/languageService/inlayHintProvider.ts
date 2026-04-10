/*
 * inlayHintProvider.ts
 *
 * Implements LSP inlay hints:
 * - textDocument/inlayHint
 */

import { CancellationToken, InlayHint, InlayHintKind } from 'vscode-languageserver';

import { ParseTreeWalker } from '../analyzer/parseTreeWalker';
import { TypeEvaluator } from '../analyzer/typeEvaluatorTypes';
import { lookUpClassMember } from '../analyzer/typeUtils';
import {
    FunctionType,
    isFunction,
    isInstantiableClass,
    isNever,
    isOverloaded,
    isUnknown,
    OverloadedType,
} from '../analyzer/types';
import { throwIfCancellationRequested } from '../common/cancellationUtils';
import { ProgramView } from '../common/extensibility';
import { convertOffsetToPosition } from '../common/positionUtils';
import { TextRangeCollection } from '../common/textRangeCollection';
import { Uri } from '../common/uri/uri';
import { ArgCategory, AssignmentNode, CallNode, FunctionNode, ParamCategory, ParseNodeType } from '../parser/parseNodes';
import { ParseFileResults } from '../parser/parser';

export class InlayHintProvider {
    private readonly _parseResults: ParseFileResults | undefined;

    constructor(
        private _program: ProgramView,
        private _fileUri: Uri,
        private _token: CancellationToken
    ) {
        this._parseResults = this._program.getParseResults(this._fileUri);
    }

    private get _evaluator(): TypeEvaluator {
        return this._program.evaluator!;
    }

    getHints(): InlayHint[] {
        throwIfCancellationRequested(this._token);

        if (!this._parseResults) {
            return [];
        }

        const lines = this._parseResults.tokenizerOutput.lines;
        const walker = new InlayHintWalker(this._evaluator, lines, this._token);
        walker.walk(this._parseResults.parserOutput.parseTree);

        return walker.hints;
    }
}

class InlayHintWalker extends ParseTreeWalker {
    readonly hints: InlayHint[] = [];

    constructor(
        private _evaluator: TypeEvaluator,
        private _lines: TextRangeCollection<{ start: number; length: number }>,
        private _token: CancellationToken
    ) {
        super();
    }

    override visitFunction(node: FunctionNode): boolean {
        throwIfCancellationRequested(this._token);

        // Skip functions with return annotations
        if (node.d.returnAnnotation || node.d.funcAnnotationComment) {
            return true;
        }

        // Skip __init__ and __new__ — return type is always known
        const funcName = node.d.name.d.value;
        if (funcName === '__init__' || funcName === '__new__') {
            return true;
        }

        const type = this._evaluator.getType(node.d.name);
        if (!type || !isFunction(type)) {
            return true;
        }

        // Skip @overload decorated functions
        if (FunctionType.isOverloaded(type)) {
            return true;
        }

        const returnType = FunctionType.getEffectiveReturnType(type);
        if (!returnType || isUnknown(returnType) || isNever(returnType)) {
            return true;
        }

        const typeStr = this._evaluator.printType(returnType);

        // Suppress None return type hints — they add noise
        if (typeStr === 'None') {
            return true;
        }

        // Position hint after the closing paren of the parameter list
        // The colon after params is at node.d.suite.start - we want just before it
        const suiteStart = node.d.suite.start;
        const position = convertOffsetToPosition(suiteStart, this._lines);

        this.hints.push({
            position,
            label: `: ${typeStr}`,
            kind: InlayHintKind.Type,
            paddingLeft: true,
        });

        return true; // Continue walking into nested functions
    }

    override visitAssignment(node: AssignmentNode): boolean {
        throwIfCancellationRequested(this._token);

        // Only emit hints for simple name targets (not tuple unpacking, subscript, etc.)
        if (node.d.leftExpr.nodeType !== ParseNodeType.Name) {
            return true;
        }

        const type = this._evaluator.getType(node.d.leftExpr);
        if (!type || isUnknown(type) || isNever(type)) {
            return true;
        }

        const typeStr = this._evaluator.printType(type);

        // Position hint after the variable name
        const nameEnd = node.d.leftExpr.start + node.d.leftExpr.length;
        const position = convertOffsetToPosition(nameEnd, this._lines);

        this.hints.push({
            position,
            label: `: ${typeStr}`,
            kind: InlayHintKind.Type,
            paddingLeft: false,
        });

        return true;
    }

    override visitCall(node: CallNode): boolean {
        throwIfCancellationRequested(this._token);

        const funcType = this._getCallableFunctionType(node);
        if (!funcType) {
            return true;
        }

        const params = funcType.shared.parameters;

        // Determine starting param index — skip self/cls for bound methods
        // A bound method has already had self/cls stripped from the parameter list.
        // For unbound methods (from class lookup like __init__), the first param is self.
        const isBoundMethod = funcType.priv.strippedFirstParamType !== undefined;
        const isUnboundMethod = funcType.shared.methodClass !== undefined && !isBoundMethod;
        let paramIndex = isUnboundMethod ? 1 : 0;

        for (const arg of node.d.args) {
            // Skip keyword arguments — they're already named
            if (arg.d.name) {
                continue;
            }

            // Stop at *args or **kwargs in the call
            if (arg.d.argCategory !== ArgCategory.Simple) {
                break;
            }

            // Find the corresponding parameter
            if (paramIndex >= params.length) {
                break;
            }

            const param = params[paramIndex];

            // Stop at *args or **kwargs parameters
            if (param.category !== ParamCategory.Simple) {
                break;
            }

            if (param.name) {
                const position = convertOffsetToPosition(arg.d.valueExpr.start, this._lines);

                this.hints.push({
                    position,
                    label: `${param.name}=`,
                    kind: InlayHintKind.Parameter,
                    paddingRight: true,
                });
            }

            paramIndex++;
        }

        return true;
    }

    private _getCallableFunctionType(node: CallNode): FunctionType | undefined {
        const calleeType = this._evaluator.getType(node.d.leftExpr);
        if (!calleeType) {
            return undefined;
        }

        // Direct function call
        if (isFunction(calleeType)) {
            return calleeType;
        }

        // Constructor call — get __init__ params from the class
        if (isInstantiableClass(calleeType)) {
            const initMember = lookUpClassMember(calleeType, '__init__');
            if (initMember?.symbol) {
                const initType = this._evaluator.getEffectiveTypeOfSymbol(initMember.symbol);
                if (isFunction(initType)) {
                    return initType;
                }
            }
            return undefined;
        }

        // Overloaded function — use first overload
        if (isOverloaded(calleeType)) {
            const overloads = OverloadedType.getOverloads(calleeType);
            if (overloads.length > 0) {
                return overloads[0];
            }
        }

        return undefined;
    }
}
