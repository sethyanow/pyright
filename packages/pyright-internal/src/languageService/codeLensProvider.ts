/*
 * codeLensProvider.ts
 *
 * Implements the textDocument/codeLens and codeLens/resolve LSP requests.
 * Shows reference counts and implementation counts on classes, functions,
 * and methods.
 */

import { CancellationToken, CodeLens, Command } from 'vscode-languageserver';

import { throwIfCancellationRequested } from '../common/cancellationUtils';
import { ProgramView } from '../common/extensibility';
import { Uri } from '../common/uri/uri';
import { DocumentSymbolProvider } from './documentSymbolProvider';
import { ImplementationProvider } from './definitionProvider';
import { ReferencesProvider } from './referencesProvider';
import { DocumentSymbol, Position, SymbolKind } from 'vscode-languageserver-types';

export interface CodeLensData {
    uri: string;
    position: Position;
    kind: 'references' | 'implementations';
}

export class CodeLensProvider {
    constructor(
        private _program: ProgramView,
        private _fileUri: Uri,
        private _token: CancellationToken
    ) {}

    getCodeLenses(): CodeLens[] {
        throwIfCancellationRequested(this._token);

        const parseResults = this._program.getParseResults(this._fileUri);
        if (!parseResults) {
            return [];
        }

        const symbolProvider = new DocumentSymbolProvider(
            this._program,
            this._fileUri,
            true, // supportHierarchicalDocumentSymbol
            {}, // indexOptions
            this._token
        );

        const symbols = symbolProvider.getSymbols() as DocumentSymbol[];
        const lenses: CodeLens[] = [];
        this._collectLenses(symbols, lenses);

        return lenses;
    }

    resolveCodeLens(lens: CodeLens): CodeLens {
        throwIfCancellationRequested(this._token);

        const data = lens.data as CodeLensData | undefined;
        if (!data || !data.uri || !data.position || !data.kind) {
            return lens;
        }

        const uri = Uri.parse(data.uri, this._program.serviceProvider);

        if (data.kind === 'references') {
            const count = this._getReferenceCount(uri, data.position);
            lens.command = this._makeCommand(count, 'reference');
        } else if (data.kind === 'implementations') {
            const count = this._getImplementationCount(uri, data.position);
            lens.command = this._makeCommand(count, 'implementation');
        }

        return lens;
    }

    private _collectLenses(symbols: DocumentSymbol[], lenses: CodeLens[]): void {
        for (const symbol of symbols) {
            throwIfCancellationRequested(this._token);

            const isClassLike = symbol.kind === SymbolKind.Class;
            const isFunctionLike =
                symbol.kind === SymbolKind.Function || symbol.kind === SymbolKind.Method;

            if (isClassLike || isFunctionLike) {
                // Reference count lens for all classes, functions, and methods
                lenses.push({
                    range: symbol.selectionRange,
                    data: {
                        uri: this._fileUri.toString(),
                        position: symbol.selectionRange.start,
                        kind: 'references',
                    } satisfies CodeLensData,
                });

                // Implementation count lens for classes only
                if (isClassLike) {
                    lenses.push({
                        range: symbol.selectionRange,
                        data: {
                            uri: this._fileUri.toString(),
                            position: symbol.selectionRange.start,
                            kind: 'implementations',
                        } satisfies CodeLensData,
                    });
                }
            }

            // Recurse into children (e.g., methods inside classes)
            if (symbol.children) {
                this._collectLenses(symbol.children, lenses);
            }
        }
    }

    private _getReferenceCount(uri: Uri, position: Position): number {
        const provider = new ReferencesProvider(this._program, this._token);
        const locations = provider.reportReferences(uri, position, false);
        return locations?.length ?? 0;
    }

    private _getImplementationCount(uri: Uri, position: Position): number {
        const provider = new ImplementationProvider(this._program, uri, position, this._token);
        const implementations = provider.getImplementations();
        return implementations?.length ?? 0;
    }

    private _makeCommand(count: number, noun: string): Command {
        const label = count === 1 ? `1 ${noun}` : `${count} ${noun}s`;
        return {
            title: label,
            command: '',
        };
    }
}
