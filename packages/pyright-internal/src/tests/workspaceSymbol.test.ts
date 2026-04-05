/*
 * workspaceSymbol.test.ts
 *
 * Tests for workspace symbol provider, including empty-query behavior.
 */

import assert from 'assert';
import { CancellationToken } from 'vscode-languageserver';

import { AnalyzerService } from '../analyzer/service';
import { ConfigOptions } from '../common/configOptions';
import { NullConsole } from '../common/console';
import { normalizeSlashes } from '../common/pathUtils';
import { ServiceProvider } from '../common/serviceProvider';
import { UriEx } from '../common/uri/uriUtils';
import { WorkspaceSymbolProvider } from '../languageService/workspaceSymbolProvider';
import { Workspace, createInitStatus } from '../workspaceFactory';
import { TestAccessHost } from './harness/testAccessHost';
import * as host from './harness/testHost';
import { createFromFileSystem, libFolder } from './harness/vfs/factory';

function createWorkspaceWithTrackedFile(code: string): { workspace: Workspace; service: AnalyzerService } {
    const cwd = normalizeSlashes('/');
    const projectRoot = UriEx.file(cwd);
    const fs = createFromFileSystem(host.HOST, /* ignoreCase */ false, {
        cwd,
        files: {
            [normalizeSlashes('/test_module.py')]: code,
        },
        meta: {
            [libFolder.key]: '',
        },
    });

    const configOptions = new ConfigOptions(projectRoot);
    const service = new AnalyzerService('test service', new ServiceProvider(), {
        console: new NullConsole(),
        hostFactory: () => new TestAccessHost(UriEx.file(cwd), [libFolder]),
        importResolverFactory: AnalyzerService.createImportResolver,
        configOptions,
        fileSystem: fs,
        shouldRunAnalysis: () => true,
    });

    const fileUri = UriEx.file(normalizeSlashes('/test_module.py'));

    // Add file as tracked (isTracked must be true for isUserCode).
    service.test_program.addTrackedFile(fileUri);

    // Open file so contents are available.
    service.setFileOpened(fileUri, 1, code);

    // Run analysis.
    while (service.test_program.analyze()) {
        // Continue until analysis completes.
    }

    const initStatus = createInitStatus();
    initStatus.resolve();

    const workspace: Workspace = {
        workspaceName: 'test workspace',
        rootUri: projectRoot,
        kinds: ['test'],
        service,
        disableLanguageServices: false,
        disableTaggedHints: false,
        disableOrganizeImports: false,
        disableWorkspaceSymbol: false,
        isInitialized: initStatus,
        searchPathsToWatch: [],
    };

    return { workspace, service };
}

test('workspace symbol - empty query returns symbols from user code', () => {
    const { workspace, service } = createWorkspaceWithTrackedFile(`
class MyClass:
    def my_method(self):
        pass

def my_function():
    pass

MY_CONSTANT = 42
`);

    try {
        const provider = new WorkspaceSymbolProvider([workspace], undefined, '', CancellationToken.None);
        const results = provider.reportSymbols();

        // Empty query must return symbols, not an empty list.
        assert(results.length > 0, `Expected symbols from user code, got ${results.length}`);

        const names = results.map((s) => s.name);
        assert(names.includes('MyClass'), 'Expected MyClass in results');
        assert(names.includes('my_function'), 'Expected my_function in results');
        assert(names.includes('MY_CONSTANT'), 'Expected MY_CONSTANT in results');
    } finally {
        service.dispose();
    }
});

test('workspace symbol - non-empty query filters correctly', () => {
    const { workspace, service } = createWorkspaceWithTrackedFile(`
class MyClass:
    def my_method(self):
        pass

def my_function():
    pass

MY_CONSTANT = 42
`);

    try {
        const provider = new WorkspaceSymbolProvider([workspace], undefined, 'MyClass', CancellationToken.None);
        const results = provider.reportSymbols();

        assert(results.length > 0, 'Expected at least one result for MyClass query');

        const names = results.map((s) => s.name);
        assert(names.includes('MyClass'), 'Expected MyClass in filtered results');
        assert(!names.includes('my_function'), 'my_function should be filtered out by MyClass query');
        assert(!names.includes('MY_CONSTANT'), 'MY_CONSTANT should be filtered out by MyClass query');
    } finally {
        service.dispose();
    }
});

test('workspace symbol - empty query on empty file returns empty results', () => {
    const { workspace, service } = createWorkspaceWithTrackedFile('');

    try {
        const provider = new WorkspaceSymbolProvider([workspace], undefined, '', CancellationToken.None);
        const results = provider.reportSymbols();

        // Empty file has no symbols — provider should return empty, not crash.
        assert.strictEqual(results.length, 0, `Expected 0 symbols from empty file, got ${results.length}`);
    } finally {
        service.dispose();
    }
});

test('workspace symbol - empty query on single-symbol file', () => {
    const { workspace, service } = createWorkspaceWithTrackedFile('x = 1\n');

    try {
        const provider = new WorkspaceSymbolProvider([workspace], undefined, '', CancellationToken.None);
        const results = provider.reportSymbols();

        assert.strictEqual(results.length, 1, `Expected exactly 1 symbol, got ${results.length}`);
        assert.strictEqual(results[0].name, 'x');
    } finally {
        service.dispose();
    }
});

test('workspace symbol - empty query with unicode symbol names', () => {
    const { workspace, service } = createWorkspaceWithTrackedFile(`
café = 1
データ = 2
`);

    try {
        const provider = new WorkspaceSymbolProvider([workspace], undefined, '', CancellationToken.None);
        const results = provider.reportSymbols();

        const names = results.map((s) => s.name);
        assert(names.includes('café'), 'Expected unicode symbol café in results');
        assert(names.includes('データ'), 'Expected unicode symbol データ in results');
    } finally {
        service.dispose();
    }
});

test('workspace symbol - empty query excludes typeshed symbols', () => {
    const { workspace, service } = createWorkspaceWithTrackedFile(`
import os
x = 1
`);

    try {
        const provider = new WorkspaceSymbolProvider([workspace], undefined, '', CancellationToken.None);
        const results = provider.reportSymbols();

        // Should return user code symbols (at least 'x'), but not typeshed symbols.
        // The isUserCode filter in _reportSymbolsForProgram should exclude typeshed.
        const locations = results.map((s) => s.location.uri);
        const hasTypeshed = locations.some((uri) => uri.includes('typeshed'));
        assert(!hasTypeshed, 'Empty query must not return typeshed symbols');

        const names = results.map((s) => s.name);
        assert(names.includes('x'), 'Expected user code symbol x in results');
    } finally {
        service.dispose();
    }
});
