---
id: pyr-qqb
title: 'Adapter warmup: send didOpen before document-level queries'
status: open
type: bug
priority: 1
parent: pyr-evw
---


## Context

Both `lsp-client.ts` and `mcp-server.ts` warm up by polling `workspace/symbol` until results appear. This proves files are parsed and bound, but does NOT trigger full type checking. Document-level providers (`textDocument/inlayHint`, `textDocument/semanticTokens/*`, etc.) that call `evaluator.getType()` get `Unknown` for symbols Pyright hasn't fully evaluated yet.

Discovered during Phase 4 acceptance (pyr-9uz): return type hints on unannotated functions don't appear in MCP/CLI demo, despite fourslash tests proving the provider works. The fourslash harness sends `textDocument/didOpen` which forces full analysis.

Root cause traced to pyr-o4h failure catalog — "Temporal Betrayal: Pyright background analysis" — where the mitigation was "Document in the skill" instead of fixing.

## Requirements

R1. `lsp-client.ts`: send `textDocument/didOpen` for the target file before document-level requests
R2. `mcp-server.ts`: same — extract URI from params, send `didOpen` before forwarding
R3. Both paths must read file content from disk for the `didOpen` notification
R4. Existing tests must still pass; add regression test that return type hints appear via CLI/MCP

## Success Criteria

- [ ] `def multiply(x: int, y: int):` in sample.py gets `: int` return type hint via lsp-client CLI
- [ ] Same hint appears via MCP `lsp()` tool
- [ ] All existing lsp-client and mcp-server tests pass
- [ ] Regression test: inlay hint test asserts return type hint (kind 1) on a function with annotated params but no return annotation

## Anti-Patterns

- Don't send `didOpen` for workspace-level queries (`workspace/symbol`) — they don't need it
- Don't cache opened documents across one-shot CLI invocations — each spawn is fresh
