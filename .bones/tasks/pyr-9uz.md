---
id: pyr-9uz
title: 'Phase 4 Acceptance: Inlay Hints'
status: closed
type: task
priority: 1
owner: Seth
depends_on: [pyr-qqb]
parent: pyr-evw
---








## Context

Phase 4 acceptance. All success criteria in pyr-evw are checked (7/7). This task delivers the user demo and any stale doc updates.

## Deliverables

### User Demo

Show inlay hints on a Python file through the MCP adapter — inferred return types, variable types, parameter names at call sites.

**Demo script:**
1. Call `textDocument/inlayHint` via the MCP `lsp()` tool on the fixture file, targeting the unannotated section (lines 22-27)
2. Show the returned hints — Type hints (kind 1) for `add`'s return type and `result`'s variable type, Parameter hints (kind 2) for `x` and `y` at the call site
3. Show the same query through the `lsp-client.ts` CLI path

### Documentation

Update stale docs only — no new summaries or tutorials.

## Success Criteria

- [ ] User demo presented in conversation
- [ ] User closes this task

## Log

- [2026-04-10T15:29:58Z] [Seth] Acceptance FAILED. Return type hints (kind 1 on function defs) don't appear in MCP/CLI demo — adapter doesn't send didOpen so Pyright never fully type-checks the file. Provider logic is correct (fourslash 4/4 pass). Created pyr-qqb to fix adapter warmup. Acceptance blocked until pyr-qqb lands and re-demo shows all three hint types.
- [2026-04-10T17:03:31Z] [Seth] Acceptance PASSED on re-try. Both lsp-client CLI and MCP lsp() tool return all three hint types: return type (kind 1) on multiply, variable type (kind 1) on result/product, parameter names (kind 2) on both call sites. didOpen fix (pyr-qqb) resolved the prior failure.
