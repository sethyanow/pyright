---
id: pyr-onu
title: Implement Code Lens provider with reference and implementation counts
status: open
type: task
priority: 1
parent: pyr-yh8
---



## Context

Phase 5 of pyr-otr, first task under pyr-yh8 (Code Lens sub-epic). No codeLens code exists anywhere in pyright-internal — greenfield. The LSP protocol has a two-phase model: `textDocument/codeLens` returns CodeLens[] with ranges (fast), `codeLens/resolve` fills in the command (expensive, called per-lens as user scrolls). The provider queries `ReferencesProvider.reportReferences()` for reference counts and `ImplementationProvider.getImplementations()` for implementation counts — both return arrays whose length is the count. `DocumentSymbolProvider.getHierarchicalSymbols()` enumerates file symbols for lens placement.

**Blocked by:** nothing (first task in phase)
**Unlocks:** pyr-yh8 progress toward code lens acceptance

## Requirements

R6 from parent epic: `textDocument/codeLens` — show reference counts and implementation counts inline.

Anti-pattern from epic failure catalog: "Hardcode counts instead of querying references provider" — counts must be live queries.

## Design

### Provider structure
`codeLensProvider.ts` in `packages/pyright-internal/src/languageService/`. Constructor: `(program: ProgramView, uri: Uri, token: CancellationToken)`.

- `getCodeLenses(): CodeLens[]` — enumerate file symbols via DocumentSymbolProvider, emit reference count lens at each class/function def. Emit implementation count lens for classes. Store `{ uri: string, position: Position, kind: 'references' | 'implementations' }` in `data` for resolve phase.
- `resolveCodeLens(lens: CodeLens): CodeLens` — based on `data.kind`: create ReferencesProvider/ImplementationProvider, query, set `lens.command = { title: "N references"/"N implementations", command: '' }`.

### Wiring
- `languageServerBase.ts`: capability `codeLensProvider: { resolveProvider: true }`, handlers `onCodeLens`/`onCodeLensResolve`, follow `onInlayHint` pattern.
- Adapter: `codeLens: { dynamicRegistration: false }` in both lsp-client.ts and mcp-server.ts client capabilities.

### Test approach
- Fourslash `verifyCodeLens` helper in testState.ts — instantiates CodeLensProvider directly, matches lenses to markers
- Three fourslash tests: reference counts, implementation counts, adversarial (count updates when reference added)

## Implementation

### Step 1: Write fourslash test — reference counts on class and function
Create `src/tests/fourslash/codeLens.references.fourslash.ts`. Python fixture with a class and function that have known reference counts. Markers at definition positions. Assert `helper.verifyCodeLens()` returns correct reference count labels.

### Step 2: Write `verifyCodeLens` fourslash helper
In `src/tests/harness/fourslash/testState.ts`, add `verifyCodeLens(map)`. Pattern follows `verifyInlayHints` — instantiate `CodeLensProvider`, call `getCodeLenses()`, match to markers, assert command titles. Import won't resolve until Step 3.

### Step 3: Create `codeLensProvider.ts`
`src/languageService/codeLensProvider.ts`. Constructor: `(program: ProgramView, uri: Uri, token: CancellationToken)`.
- `getCodeLenses()`: walk symbols via DocumentSymbolProvider, emit CodeLens with data payload for each class/function
- `resolveCodeLens()`: query ReferencesProvider or ImplementationProvider based on data.kind, set command title with count

### Step 4: Run fourslash test — verify reference count assertions pass
`cd packages/pyright-internal && npx jest fourSlashRunner.test --forceExit -t "codeLens"`

### Step 5: Write fourslash test — implementation counts on Protocol/ABC
Create `src/tests/fourslash/codeLens.implementations.fourslash.ts`. Protocol with concrete implementations, assert implementation count.

### Step 6: Run test — verify implementation count assertions pass

### Step 7: Write adversarial fourslash test — counts are live
Create `src/tests/fourslash/codeLens.adversarial.fourslash.ts`. Multi-file fixture: function referenced in one file. Verify count matches. Add second file with another reference. Verify count increases. Validates "live, not cached" pre-block.

### Step 8: Wire into languageServerBase.ts
- Capability: `codeLensProvider: { resolveProvider: true }` (after inlayHintProvider)
- Handlers: `connection.onCodeLens`, `connection.onCodeLensResolve` (after inlayHint handler)
- Methods: `onCodeLens`, `onCodeLensResolve` following `onInlayHint` pattern
- Imports: CodeLens, CodeLensParams from vscode-languageserver; CodeLensProvider from languageService

### Step 9: Run `npm run typecheck` — verify clean

### Step 10: Update adapter — add codeLens client capability
- lsp-client.ts: add `codeLens: { dynamicRegistration: false }` alongside inlayHint
- mcp-server.ts: same
- Rebuild: `npm run build:cli:dev && cd packages/pyright-mcp && npm run build`

### Step 11: Run full test suite
`cd packages/pyright-internal && npm run test:norebuild 2>&1 > /tmp/pyright-test-full.txt`

### Step 12: Commit and push

## Success Criteria

- [ ] `codeLensProvider.ts` created with `getCodeLenses()` and `resolveCodeLens()`
- [ ] `textDocument/codeLens` and `codeLens/resolve` wired in languageServerBase.ts with capability registration
- [ ] Fourslash test: reference counts on class and function definitions
- [ ] Fourslash test: implementation counts on Protocol/ABC
- [ ] Fourslash test: counts update when references added (adversarial — live not cached)
- [ ] `npm run typecheck` clean
- [ ] Full test suite passes
- [ ] Adapter updated with codeLens client capability in both lsp-client.ts and mcp-server.ts

## Anti-Patterns

- **Don't hardcode or cache counts.** Every resolve call must query ReferencesProvider/ImplementationProvider fresh. The adversarial test enforces this.
- **Don't walk the AST manually for symbol enumeration.** Use DocumentSymbolProvider — it already handles the symbol hierarchy.
- **Don't put resolve logic in getCodeLenses.** The two-phase model exists for performance — getCodeLenses returns ranges fast, resolve fills in counts lazily.
