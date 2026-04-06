---
id: pyr-otr
title: Add missing LSP providers to Pyright
status: open
type: epic
priority: 1
depends_on: [pyr-lo0, pyr-lfw, pyr-mge, pyr-evw, pyr-yh8, pyr-rfu, pyr-nft, pyr-n3v]
---

















## Requirements (IMMUTABLE)

R1. `textDocument/implementation` — goToImplementation returns concrete classes implementing a Protocol/ABC, and overriding methods in subclasses.
R2. `workspace/symbol` returns results on empty query, matching every other major language server.
R3. `textDocument/prepareTypeHierarchy`, `typeHierarchy/supertypes`, `typeHierarchy/subtypes` — navigate class hierarchies both directions.
R4. `textDocument/semanticTokens/full` and `/range` — classify every resolved symbol (class, function, parameter, typeParameter, variable, property, decorator, etc.) for semantic highlighting.
R5. `textDocument/inlayHint` — show inferred return types, variable types, and parameter names at call sites.
R6. `textDocument/codeLens` — show reference counts and implementation counts inline.
R7. `textDocument/selectionRange` — AST-aware expand/shrink selection.
R8. `textDocument/foldingRange` — collapsible regions for functions, classes, imports, comments.
R9. `codeAction` with `refactor.extract` — extract method and extract variable from selection.
R10. `codeAction` with `refactor.rewrite` — move symbol to another file with import rewriting.
R11. Thin adapter layer (MCP + skill/scripts) exposing all providers to agents via LSP as the universal abstraction. Not Claude-only — supports any coding agent.
R12. All existing tests pass after every provider addition — zero behavior change to existing features.

## Success Criteria

- [ ] Every LSP method in R1-R10 registered in server capabilities and returning correct results
- [ ] Fourslash tests for each provider covering happy path + at least one edge case
- [ ] Full test suite passes: `cd packages/pyright-internal && npm run test:norebuild`
- [ ] Adapter layer operational — agents can access all new features through LSP
- [ ] Each provider follows existing Pyright patterns (provider class in languageService/, wired in languageServerBase.ts)

## Anti-Patterns (FORBIDDEN)

- **Don't build provider logic in the adapter layer.** The adapter is a protocol bridge — zero business logic. Intelligence lives in Pyright's LSP providers. REASON: adapter must be swappable without losing functionality.
- **Don't build providers that only work on open files.** workspace/symbol, type hierarchy, and references must work across the entire program. REASON: agents don't "open" files — they query cold.

## Approach

Build each LSP provider as a native Pyright feature, layered bottom-up so each provider establishes infrastructure the next one reuses. The type evaluator already has all the information — the work is writing the service layer that queries it and formats LSP responses.

Each provider follows the existing pattern: a provider class in `packages/pyright-internal/src/languageService/`, wired into `languageServerBase.ts` (connection handler + capability registration). The test harness already advertises client support for all missing features (`languageServerTestUtils.ts`), so fourslash tests work immediately.

A thin adapter layer (MCP + skill/scripts) grows incrementally alongside the providers. Phase 1 establishes the plugin (MCP bridge to dev-built Pyright), and each subsequent phase adds its new capabilities to the adapter. Full LSP registration comes later — the MCP is the dev-time interface while we add features beyond the standard LSP spec. The adapter is a protocol bridge — zero business logic. LSP is the universal abstraction. The MCP and skill/scripts are adapters for different agent tooling (not Claude-only). Wiring/polish happens at the end; the infrastructure exists from day one.

## Architecture

```
Agent / Editor / CLI
        │
   ┌────┴──────────────────┐
   │ Adapter (grows with   │  ← MCP + skill/scripts (established Phase 1,
   │ each phase)           │     each phase adds capabilities)
   └────┬──────────────────┘
        │ LSP protocol
   ┌────┴────────────────────────────┐
   │  languageServerBase.ts          │  ← connection handlers + capability registration
   │  ├─ implementationProvider.ts   │  Phase 1 (R1, R2)
   │  ├─ typeHierarchyProvider.ts    │  Phase 2 (R3)
   │  ├─ semanticTokensProvider.ts   │  Phase 3 (R4)
   │  ├─ inlayHintsProvider.ts       │  Phase 4 (R5)
   │  ├─ codeLensProvider.ts         │  Phase 5 (R6)
   │  ├─ selectionRangeProvider.ts   │  Phase 6 (R7)
   │  ├─ foldingRangeProvider.ts     │  Phase 6 (R8)
   │  └─ refactoringProvider.ts      │  Phase 7 (R9, R10)
   └────┬────────────────────────────┘
        │ queries
   ┌────┴────────────────┐
   │  TypeEvaluator       │
   │  Checker / Program   │
   │  Parser / Binder     │
   └─────────────────────┘
```

## Phases

### Phase 1: Foundation — goToImplementation + workspaceSymbol fix + plugin/adapter setup
**Scope:** R1, R2, R11 (initial)
**Gate:**
- `cd packages/pyright-internal && npx jest fourSlashRunner.test --forceExit` → implementation + workspace symbol tests pass
- `npm run typecheck` → clean
- Plugin installed: MCP adapter operational, thin bridge exposing LSP capabilities to agents
**Demo:** Show me goToImplementation finding concrete classes for a Protocol, and workspaceSymbol returning results on empty query — both via the MCP `lsp()` tool.

### Phase 2: Type Hierarchy
**Scope:** R3
**Gate:**
- `cd packages/pyright-internal && npx jest fourSlashRunner.test --forceExit` → type hierarchy tests pass
- `npm run typecheck` → clean
**Demo:** Show me navigating supertypes and subtypes of a class through the type hierarchy via the MCP `lsp()` tool.

### Phase 3: Semantic Tokens
**Scope:** R4
**Gate:**
- `cd packages/pyright-internal && npx jest fourSlashRunner.test --forceExit` → semantic tokens tests pass
- `npm run typecheck` → clean
**Demo:** Show me the token classifications for a Python file with classes, functions, decorators, type parameters — demonstrate that the visitor correctly resolves each symbol kind.

### Phase 4: Inlay Hints
**Scope:** R5
**Gate:**
- `cd packages/pyright-internal && npx jest fourSlashRunner.test --forceExit` → inlay hint tests pass
- `npm run typecheck` → clean
**Demo:** Show me inlay hints on a Python file — inferred return types, variable types, parameter names at call sites.

### Phase 5: Code Lens
**Scope:** R6
**Gate:**
- `cd packages/pyright-internal && npx jest fourSlashRunner.test --forceExit` → code lens tests pass
- `npm run typecheck` → clean
**Demo:** Show me reference and implementation counts appearing on classes and functions.

### Phase 6: Range Providers — Selection Range + Folding Range
**Scope:** R7, R8
**Gate:**
- `cd packages/pyright-internal && npx jest fourSlashRunner.test --forceExit` → selection range + folding range tests pass
- `npm run typecheck` → clean
**Demo:** Show me selection range expanding through AST levels, and folding ranges for a file with classes, functions, and imports.

### Phase 7: Refactoring — Extract + Move
**Scope:** R9, R10
**Gate:**
- `cd packages/pyright-internal && npx jest fourSlashRunner.test --forceExit` → refactoring tests pass
- `npm run typecheck` → clean
**Demo:** Show me extract method on a selection (correct captured variables, return type), and move symbol rewriting imports across files.

### Phase 8: Adapter
**Scope:** R11
**Gate:**
- Adapter starts, connects to Pyright, agents can invoke each provider through it
- `npm run typecheck` → clean
**Demo:** Show me an agent (or the LSP tool) using the adapter to hit each new provider.

## Agent Failure Mode Catalog

### Phase 1
| Shortcut | Rationalization | Pre-block |
|----------|----------------|-----------|
| Return goToDefinition results for goToImplementation | "They're similar enough" | Fourslash test with Protocol that has definition in one file and implementations in others — must return only implementations |
| Skip workspaceSymbol fix as "tool limitation" | "The tool doesn't pass a query" | Test that empty query returns symbols; verified this session that isPatternInSymbol('', x) returns true |

### Phase 3
| Shortcut | Rationalization | Pre-block |
|----------|----------------|-----------|
| Classify tokens by syntax only (keyword matching) | "Faster than querying the evaluator" | Fourslash test where a name is a class in one context and a variable in another — must resolve via type info |

### Phase 5
| Shortcut | Rationalization | Pre-block |
|----------|----------------|-----------|
| Hardcode counts instead of querying references provider | "More efficient" | Test that adding a reference updates the count — must be live, not cached |

### Phase 7
| Shortcut | Rationalization | Pre-block |
|----------|----------------|-----------|
| Extract method without scope analysis | "Just cut and paste the selection" | Test with captured closure variables — extracted method must take them as params |
| Move symbol without rewriting imports | "User can fix imports" | Test that all files importing the moved symbol get updated |

## Seam Contracts

### Phase 1 → Phase 2
**Delivers:** goToImplementation machinery (find subclasses/implementors of a class)
**Assumes:** Phase 2 uses this to build the subtypes direction of type hierarchy
**If wrong:** Type hierarchy subtypes must reimplement subclass discovery

### Phase 3 → Phase 4
**Delivers:** File-walking visitor pattern that resolves every node through the evaluator
**Assumes:** Phase 4 reuses the visitor to emit inlay hints at specific positions
**If wrong:** Inlay hints builds its own walker — duplication, not catastrophic

### Phase 3 → Phase 5
**Delivers:** Same visitor pattern
**Assumes:** Code lens aggregates reference/implementation counts per symbol found by the visitor
**If wrong:** Code lens builds its own symbol enumeration — duplication

### Phase 1-6 → Phase 7
**Delivers:** All navigation providers (references, implementations, type info at position, scope analysis)
**Assumes:** Refactoring consumes these to determine what to extract, what's captured, what imports to rewrite
**If wrong:** Refactoring reimplements discovery logic — significant rework

### Each Phase → Adapter
**Delivers:** Each phase registers new LSP handlers and adds corresponding MCP/skill capabilities to the adapter
**Assumes:** Adapter is established in Phase 1 and grows incrementally
**If wrong:** Demo can't happen — adapter must exist for acceptance

## Design Rationale

### Problem
Open-source Pyright implements 14 of 24+ LSP features. Pylance adds the rest but is proprietary and VS Code-only. Every other Python tool (mypy, ty, pylsp) is either a pure checker or a duct-tape aggregator. No open-source Python language server provides the full IDE feature set. Agents doing refactoring work (like the decomposition effort on this repo) need these features — extract, move, navigate hierarchies, see inferred types.

### Research Findings
**Codebase:** `languageServerBase.ts:642-684` — InitializeResult registers 14 capabilities, missing implementation/typeHierarchy/inlayHint/semanticTokens/foldingRange/selectionRange/codeLens/refactoring [VERIFIED this session via Read]
**Codebase:** `languageServerTestUtils.ts:1001-1134` — test harness client capabilities already declare support for all missing features [VERIFIED this session via ChunkHound search]
**Codebase:** `codeActionProvider.ts` — only supports QuickFix (create type stub). No refactoring code actions [VERIFIED this session via ChunkHound search]
**Codebase:** `definitionProvider.ts:260-314` — TypeDefinitionProvider pattern: constructor takes program/fileUri/position, getDefinitions resolves types and returns DocumentRange[] [VERIFIED this session via Read]
**Codebase:** `workspaceSymbolProvider.ts:132-134` — empty query guard `if (!this._query) return;` [VERIFIED this session via Read]
**External:** vtsls returns 27,748 symbols on empty workspace/symbol query [VERIFIED this session via LSP tool]

### Approaches Considered

#### 1. Native Pyright LSP providers (selected)
**Chosen because:** LSP is the universal abstraction. Every editor and agent framework speaks it. Building features natively means all consumers benefit. The type evaluator already has the information — only the service layer is missing. Existing provider patterns (DefinitionProvider, CallHierarchyProvider) provide clear templates.

#### 2. Build everything in the MCP/adapter layer
**Why explored:** Faster to prototype — don't need to modify Pyright internals.
**REJECTED BECAUSE:** Duplicates work the evaluator already does, couples agent tooling to a specific protocol, and other LSP clients (VS Code, Neovim) get nothing.
**DO NOT REVISIT UNLESS:** Pyright's architecture makes a specific provider impossible to implement natively (hasn't happened yet).

#### 3. Contribute to pylsp instead
**Why explored:** Existing open-source Python language server with plugin architecture.
**REJECTED BECAUSE:** pylsp delegates to rope/mypy/pyflakes — none of which have Pyright's type intelligence. Would mean building the type evaluator capabilities from scratch or wrapping Pyright anyway.
**DO NOT REVISIT UNLESS:** pylsp adds a Pyright backend plugin.

### Scope Boundaries
**In scope:** All LSP providers listed in R1-R10, adapter layer (R11), fourslash tests for each.
**Out of scope:** Upstream contribution to microsoft/pyright (personal fork). Jupyter notebook-specific features. AI-powered completions (IntelliCode-style). Formatting providers (black/ruff handle this).

### Open Questions
- Refactoring scope analysis (R9/R10): How deep does extract method go? Does it handle async, generators, yield? Resolve during Phase 7 scoping.
- Code lens performance: Reference counting across a large workspace could be slow. May need lazy evaluation or caching. Resolve during Phase 5.

## Design Discovery

### Key Decisions Made
| Question | Answer | Implication |
|----------|--------|-------------|
| What features in scope? | Full Pylance gap — all of them | 8 phases, comprehensive effort |
| Priority order? | Most logical build order — what builds on what | Foundation (+ adapter) → hierarchy → visitor → hints → lens → ranges → refactoring |
| Refactoring scope? | Both extract and move symbol | Phase 7 is the heaviest phase |
| Acceptance format? | Show it off, no ceremony | Demo is live demonstration, not test output |
| Adapter timing? | Build incrementally, wire/polish at end | Phase 1 establishes plugin + MCP, each phase adds capabilities |
| Why Pyright? | Only tool with the type intelligence AND open source | mypy can't, ty isn't trying, pylsp is duct tape, Pylance is locked |

### Dead-End Paths
- **ty as target:** Rejected — we saw it reject implementation, call hierarchy, workspace symbol. Not trying to be an IDE backend.
- **mypy as target:** No language server features at all. Pure checker.
- **pylsp as target:** Delegates to weaker tools. Would need to wrap Pyright anyway.

### Open Concerns
- Performance of cross-workspace features (code lens, workspace symbol) on large codebases — addressed by lazy evaluation if needed, not a blocker for implementation.
- Semantic tokens visitor pattern reuse — if Phase 3's visitor doesn't generalize well, Phases 4 and 5 build their own. Duplication, not catastrophic.
