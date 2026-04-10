---
id: pyr-9uz
title: 'Phase 4 Acceptance: Inlay Hints'
status: open
type: task
priority: 1
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
