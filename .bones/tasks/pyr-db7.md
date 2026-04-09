---
id: pyr-db7
title: 'Phase 3 Acceptance: Semantic Tokens'
status: open
type: task
priority: 1
parent: pyr-mge
---



## Context

Phase 3 (Semantic Tokens) has all success criteria checked. This acceptance task delivers the demo and verifies the complete feature end-to-end.

## Deliverables

### User Demo

Show semantic token classifications for a Python file with diverse symbol kinds — demonstrate that the visitor correctly resolves each symbol through the type evaluator.

**Demo script:**
1. Use the existing fixture (`packages/pyright-mcp/src/tests/fixtures/sample.py`) and/or fourslash semantic token test samples already in the codebase
2. Request `textDocument/semanticTokens/full` via the MCP `lsp` tool on the fixture
3. Show decoded output with human-readable type names (class, function, parameter, decorator, etc.)
4. Request `textDocument/semanticTokens/range` for a subset — show it returns only tokens in range
5. Point to existing fourslash tests that demonstrate type-dependent classification

### Agent Documentation

Update stale docs only — no new summaries or tutorials needed. Check if any existing docs reference semantic tokens as "not supported" or "missing."

## Success Criteria

- [ ] Demo executed showing all token types (class, function, parameter, typeParameter, variable, property, decorator, method, namespace)
- [ ] Range request demonstrated returning subset
- [ ] Type-dependent classification demonstrated
- [ ] No stale docs claiming semantic tokens are missing
