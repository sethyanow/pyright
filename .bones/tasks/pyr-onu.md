---
id: pyr-onu
title: Implement Code Lens provider with reference and implementation counts
status: active
type: task
priority: 1
owner: Seth
parent: pyr-yh8
---




## Context

Phase 5 of pyr-otr, first task under pyr-yh8 (Code Lens sub-epic). No codeLens code exists anywhere in pyright-internal — greenfield. The LSP protocol has a two-phase model: `textDocument/codeLens` returns CodeLens[] with ranges (fast), `codeLens/resolve` fills in the command (expensive, called per-lens as user scrolls).

**Verified API signatures (SRE spot-check):**
- `ReferencesProvider(program, token, createDocumentRange?, convertToLocation?)` — file/position are passed to `reportReferences(fileUri, position, includeDeclaration)`, which returns `Location[]` (deduplicated). Count = `locations.length`.
- `ImplementationProvider(program, fileUri, position, token)` — `getImplementations()` returns `DocumentRange[] | undefined`. Count = `result.length`.
- `DocumentSymbolProvider(program, uri, supportHierarchicalDocumentSymbol, indexOptions, token)` — `getSymbols()` is public and returns `DocumentSymbol[]` (when hierarchical=true). `getHierarchicalSymbols()` is `protected` — use `getSymbols()` or `SymbolIndexer.indexSymbols()` directly.
- `InlayHintProvider(program, fileUri, token)` — the 3-arg pattern. CodeLensProvider should follow this.
- `CodeLens` type available from `vscode-languageserver` along with `CodeLensRequest`, `CodeLensResolveRequest`.
- Fourslash does NOT support adding files mid-test. The adversarial test must use a static multi-file fixture.

**Blocked by:** nothing (first task in phase)
**Unlocks:** pyr-yh8 progress toward code lens acceptance

## Requirements

R6 from parent epic: `textDocument/codeLens` — show reference counts and implementation counts inline.

Anti-pattern from epic failure catalog: "Hardcode counts instead of querying references provider" — counts must be live queries.

## Design

### Provider structure
`codeLensProvider.ts` in `packages/pyright-internal/src/languageService/`. Constructor: `(program: ProgramView, uri: Uri, token: CancellationToken)`.

- `getCodeLenses(): CodeLens[]` — enumerate file symbols via `SymbolIndexer.indexSymbols()` (or instantiate `DocumentSymbolProvider` with `supportHierarchicalDocumentSymbol=true` and call `getSymbols()`), emit reference count lens at each class/function def. Emit implementation count lens for classes. Store `{ uri: string, position: Position, kind: 'references' | 'implementations' }` in `data` for resolve phase.
- `resolveCodeLens(lens: CodeLens): CodeLens` — based on `data.kind`:
  - References: `new ReferencesProvider(program, token).reportReferences(uri, position, false)` → returns `Location[]`, count = `.length`.
  - Implementations: `new ImplementationProvider(program, uri, position, token).getImplementations()` → returns `DocumentRange[] | undefined`, count = `.length ?? 0`.
  - Set `lens.command = { title: "N references"/"N implementations", command: '' }`.

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
Create `src/tests/fourslash/codeLens.adversarial.fourslash.ts`. Multi-file fixture: function defined in file1, referenced in file2 and file3. Assert count = 2 (excluding declaration). This validates that counts query across the workspace (live), not just the current file. Fourslash cannot add files mid-test, so use a static multi-file fixture with known cross-file reference counts.

### Step 8: Wire into languageServerBase.ts
- Capability: `codeLensProvider: { resolveProvider: true }` in InitializeResult (after inlayHintProvider)
- Handlers: `this.connection.onCodeLens(async (params, token) => this.onCodeLens(params, token))` and `this.connection.onCodeLensResolve(async (params, token) => this.onCodeLensResolve(params, token))` — old-style API, NOT `connection.languages.codeLens`
- Methods: `onCodeLens(params: CodeLensParams, token: CancellationToken): Promise<CodeLens[] | null>` and `onCodeLensResolve(lens: CodeLens, token: CancellationToken): Promise<CodeLens>` following `onInlayHint` pattern (getWorkspaceForFile, service.run)
- Imports: `CodeLens`, `CodeLensParams` from vscode-languageserver; `CodeLensProvider` from languageService

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
- [ ] Fourslash test: cross-file reference counts are correct (adversarial — live workspace query, not single-file)
- [ ] `npm run typecheck` clean
- [ ] Full test suite passes
- [ ] Adapter updated with codeLens client capability in both lsp-client.ts and mcp-server.ts

## Key Considerations

- **ReferencesProvider returns void-through-callback in some paths.** The `reportReferences` method returns `Location[]` (the deduplicated array at the end), but internally uses callback-based reporting. For code lens resolve, the simple return value suffices — just call `.reportReferences(uri, position, false)` and count the returned array.
- **ImplementationProvider takes position in constructor.** Unlike ReferencesProvider (which takes position in `reportReferences`), ImplementationProvider resolves the node in the constructor. For resolve, construct fresh with the stored position.
- **DocumentSymbol.range vs selectionRange.** `DocumentSymbol` has both `range` (full body) and `selectionRange` (name/identifier). CodeLens should be placed at `selectionRange.start` (the name), not `range.start` (which may be a decorator line).
- **Handler registration uses old-style API.** CodeLens uses `connection.onCodeLens()` and `connection.onCodeLensResolve()` (like `onCompletion`, `onHover`) — NOT the newer `connection.languages.X.on()` pattern used by typeHierarchy/semanticTokens/inlayHint. Verified in vscode-languageserver `server.d.ts:675-682`.
- **Empty command string is valid.** CodeLens commands with `command: ''` are display-only lenses (no click action). This is the correct pattern for reference/implementation counts.

### Failure Catalog (Adversarial Planning)

**Dependency Treachery: resolveCodeLens — ReferencesProvider**
- Assumption: `reportReferences()` returns `Location[]` at the stored position
- Betrayal: File changed since `getCodeLenses`; position no longer points to a name node. `getDeclarationForPosition` returns undefined → `reportReferences` returns `undefined`
- Consequence: `undefined.length` → runtime crash in the language server
- Mitigation: Null-check the return value. If undefined, return lens with "0 references". Graceful degradation, not crash.

**Dependency Treachery: resolveCodeLens — ImplementationProvider**
- Assumption: `getImplementations()` returns `DocumentRange[]`
- Betrayal: Returns `undefined` when node is not a class/method name (constructor gates on node type)
- Consequence: `undefined.length` → crash
- Mitigation: Use `result?.length ?? 0`, not `result.length ?? 0`.

**Input Hostility: getCodeLenses — symbol kind filtering**
- Assumption: DocumentSymbol list contains only classes and functions
- Betrayal: `getSymbols()` returns ALL document symbols — variables, constants, enums, properties
- Consequence: Lenses on every variable assignment — noisy, wrong
- Mitigation: Filter by `SymbolKind.Class`, `SymbolKind.Function`, `SymbolKind.Method` only.

**Input Hostility: onCodeLensResolve — malformed data**
- Assumption: `lens.data` contains `{ uri, position, kind }` payload from our `getCodeLenses`
- Betrayal: Client sends malformed or missing data (spec says opaque+preserved, but bugs happen)
- Consequence: Destructuring crash in resolve handler
- Mitigation: Validate `data` fields exist. Return unresolved lens if invalid.

## Anti-Patterns

- **Don't hardcode or cache counts.** Every resolve call must query ReferencesProvider/ImplementationProvider fresh. The adversarial test enforces this.
- **Don't walk the AST manually for symbol enumeration.** Use `SymbolIndexer.indexSymbols()` or `DocumentSymbolProvider.getSymbols()` — they already handle the symbol hierarchy. Note: `getHierarchicalSymbols()` is protected.
- **Don't put resolve logic in getCodeLenses.** The two-phase model exists for performance — getCodeLenses returns ranges fast, resolve fills in counts lazily.
