---
id: pyr-lfw
title: 'Phase 2: Type Hierarchy'
status: open
type: epic
priority: 1
depends_on: [pyr-lo0, pyr-mal, pyr-9m4]
parent: pyr-otr
---







## Context

Phase 2 of pyr-otr. Depends on Phase 1 (pyr-lo0) which delivers the subclass discovery machinery (`ImplementationProvider` pattern — walk source files, `derivesFromClassRecursive`). Phase 2 reuses this for the subtypes direction and adds the supertypes direction (walk MRO upward).

## Requirements

R3 from parent epic: `textDocument/prepareTypeHierarchy`, `typeHierarchy/supertypes`, `typeHierarchy/subtypes` — navigate class hierarchies both directions.

## Success Criteria

- [x] `textDocument/prepareTypeHierarchy` registered in capabilities, returns TypeHierarchyItem for class at cursor
- [x] `typeHierarchy/supertypes` returns base classes walking up the MRO
- [x] `typeHierarchy/subtypes` returns subclasses across workspace
- [x] Works across files — not limited to open files
- [x] Fourslash tests covering: single inheritance, multiple inheritance, diamond, Protocol/ABC
- [x] Full test suite passes
- [x] Adapter layer updated — new capabilities accessible through MCP + skill/scripts (generic lsp() tool forwards all LSP methods; typeHierarchyProvider: true registered in capabilities)

## Key Considerations

- Subtypes direction can reuse the workspace traversal pattern from Phase 1's `ImplementationProvider`
- Supertypes direction is simpler — `ClassType.shared.baseClasses` and `ClassType.shared.mro` already go upward
- `connection.languages.typeHierarchy` API in vscode-languageserver (similar pattern to `connection.languages.callHierarchy`)

## Gate

- `cd packages/pyright-internal && npx jest fourSlashRunner.test --forceExit` → type hierarchy tests pass
- `npm run typecheck` → clean

## Demo

Show me navigating supertypes and subtypes of a class through the type hierarchy via the MCP `lsp()` tool.
