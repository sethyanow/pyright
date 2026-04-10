---
id: pyr-7ds
title: Add inlay hint capability to MCP adapter
status: open
type: task
priority: 1
parent: pyr-evw
---

## Context

Phase 4 adapter wiring. The MCP adapter (`packages/pyright-mcp/src/mcp-server.ts`) exposes a generic `lsp()` tool that sends any LSP request to Pyright. The adapter must declare `inlayHint` in its client capabilities during initialization, or Pyright won't register the `inlayHintProvider` capability (LSP client capability gating).

The generic `lsp()` tool already passes through any LSP method — no tool changes needed. Only the capability declaration and a test are required.

**Blocked by:** pyr-zve (closed — provider exists)
**Unlocks:** Phase 4 acceptance → Phase 5

## Requirements

R1. Declare `inlayHint` client capability in the MCP adapter's LSP init request
R2. Verify `textDocument/inlayHint` works through the MCP `lsp()` tool

## Implementation

### Step 1: Write failing MCP test for inlayHint
- File: `packages/pyright-mcp/src/tests/mcp-server.test.ts`
- Add test that calls `textDocument/inlayHint` via the `lsp()` tool on a Python file with an unannotated function
- Pattern: follow existing semantic tokens test structure
- Expected: response contains hints array with a return type hint
- Will fail because the init request doesn't declare `inlayHint` capability yet

### Step 2: Add inlayHint client capability
- File: `packages/pyright-mcp/src/mcp-server.ts` lines 83-101 (textDocument capabilities block)
- Add `inlayHint: { dynamicRegistration: false }` alongside existing `implementation` and `semanticTokens`

### Step 3: Rebuild and verify
- Rebuild: `npm run build:cli:dev && cd packages/pyright-mcp && npm run webpack`
- Run MCP tests
- `npm run typecheck`

## Success Criteria

- [ ] `inlayHint: { dynamicRegistration: false }` in client capabilities init request
- [ ] MCP test verifies `textDocument/inlayHint` returns hints through `lsp()` tool
- [ ] `npm run typecheck` clean
- [ ] Existing MCP tests still pass

## Anti-Patterns

- Do NOT add a separate MCP tool for inlay hints — the generic `lsp()` tool handles it
- Do NOT add client-side hint decoding — hints are JSON-friendly unlike semantic tokens
