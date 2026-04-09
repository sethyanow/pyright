---
id: pyr-9m4
title: 'Phase 2 Acceptance: Type Hierarchy'
status: closed
type: task
owner: Seth
parent: pyr-lfw
---




## Context

Phase 2 (pyr-lfw) implementation is complete. All 7 success criteria checked. This acceptance task verifies the feature works end-to-end and demonstrates it to the user.

**Blocked by:** pyr-mal (closed)
**Unlocks:** pyr-lfw closure → unblocks pyr-mge (Phase 3: Semantic Tokens)

## Requirements

Two deliverables:
1. **Agent documentation** — update stale docs only (no new summaries or tutorials)
2. **User demo** — live demonstration of type hierarchy via MCP lsp() tool

## Demo

From the parent epic's Phase 2 demo requirement:
> Show me navigating supertypes and subtypes of a class through the type hierarchy via the MCP `lsp()` tool.

### Demo Script

Using the MCP pyright `lsp()` tool against a Python file in the workspace:

1. **Prepare:** Send `textDocument/prepareTypeHierarchy` with a class name position → show the TypeHierarchyItem returned
2. **Supertypes:** Send `typeHierarchy/supertypes` with the item → show base classes walking upward
3. **Subtypes:** Send `typeHierarchy/subtypes` with the item → show subclasses found across the workspace

Use a real Python file with a class hierarchy (e.g., a class from the pyright codebase itself, or create a small sample).

## Success Criteria

- [x] Demo presented to user in conversation (not buried in task body)
- [x] User closes this task (acceptance is a user decision)

## Log

- [2026-04-09T12:00:24Z] [Seth] Acceptance demo completed. Bug found: languageServerBase.ts supertypes/subtypes handlers used range.start instead of selectionRange.start. Fixed with regression test (typeHierarchy.roundTrip.fourslash.ts). Full MCP round-trip verified live: prepare→supertypes→subtypes all working. User approved.
