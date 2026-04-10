---
id: pyr-7ds
title: Add inlay hint capability to MCP adapter
status: closed
type: task
priority: 1
owner: Seth
parent: pyr-evw
---



## Context

Phase 4 adapter wiring. The MCP adapter (`packages/pyright-mcp/src/mcp-server.ts`) exposes a generic `lsp()` tool that sends any LSP request to Pyright. The adapter must declare `inlayHint` in its client capabilities during initialization, or Pyright won't register the `inlayHintProvider` capability (LSP client capability gating).

The generic `lsp()` tool already passes through any LSP method — no tool changes needed. Only the capability declaration and a test are required.

**Blocked by:** pyr-zve (closed — provider exists)
**Unlocks:** Phase 4 acceptance → Phase 5

## Requirements

R1. Declare `inlayHint` client capability in both `mcp-server.ts` and `lsp-client.ts` init requests
R2. Verify `textDocument/inlayHint` works through the MCP `lsp()` tool
R3. Verify `textDocument/inlayHint` works through the `lsp-client.ts` CLI path

## Implementation

### Step 1: Add unannotated code to fixture
- File: `packages/pyright-mcp/src/tests/fixtures/sample.py`
- Current fixture has all type annotations — inlay hints only fire on unannotated code
- Append an unannotated function (e.g., `def add(x, y): return x + y`) and unannotated variable (e.g., `result = add(1, 2)`)

### Step 2: Write failing MCP test for inlayHint
- File: `packages/pyright-mcp/src/tests/mcp-server.test.ts`
- Add test that calls `textDocument/inlayHint` via the `lsp()` tool with range covering the unannotated code
- Assert: response is an array of InlayHint objects, each with `position`, `label`, `kind`
- Assert content: at least one hint with `kind: 1` (Type) for return type or variable type, and at least one with `kind: 2` (Parameter) for parameter names at call sites
- Will fail because the init request doesn't declare `inlayHint` capability yet

### Step 3: Write failing lsp-client test for inlayHint
- File: `packages/pyright-mcp/src/tests/lsp-client.test.ts`
- Add test calling `queryLsp` with `textDocument/inlayHint`
- Same assertions as Step 2

### Step 4: Add inlayHint client capability to both init requests
- File: `packages/pyright-mcp/src/mcp-server.ts` line 94 (after semanticTokens block, inside textDocument capabilities)
- File: `packages/pyright-mcp/src/lsp-client.ts` line 57 (after semanticTokens block, inside textDocument capabilities)
- Add `inlayHint: { dynamicRegistration: false }` in both

### Step 5: Rebuild and verify
- Rebuild: `npm run build:cli:dev && cd packages/pyright-mcp && npm run webpack`
- Run MCP tests: `cd packages/pyright-mcp && npx jest --forceExit`
- `npm run typecheck`

## Success Criteria

- [x] `inlayHint: { dynamicRegistration: false }` in `mcp-server.ts` client capabilities
- [x] `inlayHint: { dynamicRegistration: false }` in `lsp-client.ts` client capabilities
- [x] MCP test verifies `textDocument/inlayHint` returns hints through `lsp()` tool (asserts kind, position, label)
- [x] lsp-client test verifies `textDocument/inlayHint` returns hints through `queryLsp` (asserts kind, position, label)
- [x] Fixture has unannotated code that triggers inlay hints
- [x] `npm run typecheck` clean
- [x] Existing MCP + lsp-client tests still pass

## Key Considerations

**Dependency Treachery: Fixture content**
- Assumption: Unannotated Python code will produce inlay hints
- Betrayal: Trivial functions returning None implicitly may not emit return type hints. Parameter hints only appear at call sites — no call means no parameter hints.
- Consequence: Test passes with empty array or wrong hint kinds
- Mitigation: Fixture must include: (1) unannotated function with non-trivial return, (2) unannotated variable assignment, (3) call site with positional args to named-param function. Test asserts specific hint kinds (1=Type, 2=Parameter).

**Dependency Treachery: Stale webpack bundle**
- Assumption: Bundle includes the inlayHint provider from pyr-zve
- Betrayal: If bundle is stale, capability is declared but handler returns empty/error
- Consequence: Confusing test failure — capability present, no hints
- Mitigation: Step 5 explicitly rebuilds both CLI and MCP webpack. If tests fail after capability addition, check bundle date first.

**Temporal Betrayal: Analysis readiness**
- Assumption: beforeAll workspace/symbol polling guarantees document analysis is complete
- Betrayal: Workspace symbols may be ready before per-file type evaluation finishes
- Consequence: Flaky test — sometimes empty hints array
- Mitigation: Low risk (semantic tokens uses same pattern and works). If flaky, add retry within the inlayHint test.

## Anti-Patterns

- Do NOT add a separate MCP tool for inlay hints — the generic `lsp()` tool handles it
- Do NOT add client-side hint decoding — hints are JSON-friendly unlike semantic tokens
