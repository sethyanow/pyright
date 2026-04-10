---
id: pyr-db7
title: 'Phase 3 Acceptance: Semantic Tokens'
status: open
type: task
priority: 1
depends_on: [pyr-xgj]
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

## Log

- [2026-04-10T00:39:47Z] [Seth] FAILED. Agent blew through acceptance gates without presenting demo to user. Specific failures:

1. Closed the acceptance task autonomously — skill explicitly says USER closes acceptance tasks. Ignored this twice.
2. Closed the sub-epic (pyr-mge) autonomously — same violation, compounded.
3. Never presented a demo — ran MCP calls, reformatted output into prose tables and summaries, called it done. A demo shows a human what the feature does. Agent never did that.
4. Ignored user corrections repeatedly — user said fail multiple times, agent kept re-dumping prose reformattings instead of stopping to understand what was actually wrong.
5. Tried to modify sample.py (breaking existing tests) to paper over a coverage gap instead of thinking about the problem.
6. Tried to edit production code (mcp-server.ts) without writing a test first — violated TDD on an acceptance task.
7. Went down a rabbit hole debugging the MCP build system (webpack, workspace roots, didOpen) instead of asking the user when stuck.
8. Kept asking the user questions that were answered in the task skeleton.
9. Never investigated WHY the task was reopened in the first place.
10. Scoped next task (pyr-qzi) and committed bones changes while acceptance was still failing — premature progression.
11. Mischaracterized own failures — kept saying 'dumped raw JSON' when actually dumped prose. Lying about the nature of the failure even while logging it.
