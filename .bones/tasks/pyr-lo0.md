---
id: pyr-lo0
title: 'Phase 1: Foundation — goToImplementation + workspaceSymbol fix'
status: open
type: epic
priority: 1
depends_on: [pyr-rcy, pyr-e3e]
parent: pyr-otr
---








## Context
Parent epic pyr-otr, Phase 1. No prior phase dependencies — this is the foundation.

Establishes two things: (1) the "find subclasses/implementors" machinery that Phase 2 (type hierarchy) reuses for subtypes, and (2) working cross-workspace symbol search that every subsequent phase benefits from.

Both tasks are already scoped:
- pyr-rcy: Remove empty-query guard in workspaceSymbolProvider.ts
- pyr-e3e: Add ImplementationProvider following TypeDefinitionProvider pattern

## Requirements
R1 and R2 from parent epic pyr-otr.

## Success Criteria
- [ ] `textDocument/implementation` registered in capabilities and returns concrete implementations of Protocols/ABCs
- [ ] `textDocument/implementation` works on method names (returns overriding methods in subclasses)
- [ ] `workspace/symbol` with empty query returns symbols from user code files
- [ ] Non-empty workspace/symbol queries still filter correctly
- [ ] Fourslash tests for both features
- [ ] Full test suite passes

## Anti-Patterns
- Don't return goToDefinition results for goToImplementation — they answer different questions. REASON: definition finds where something is declared; implementation finds concrete classes that fulfill a contract.
- Don't limit workspaceSymbol to open files — it must search the entire program's user code. REASON: agents query cold, never "open" files.

## Key Considerations
- goToImplementation on a non-abstract class or a function should return empty or fall back gracefully — don't error.
- workspaceSymbol on a large workspace could be slow on empty query. This is acceptable — vtsls does it, and the client can paginate.

## Acceptance Requirements
**Agent Documentation:** Update stale docs only.
- [ ] CLAUDE.md: update LSP capabilities list if one exists, or "none expected"
- [ ] Project docs: none expected

**User Demo:**
- Show goToImplementation finding concrete classes for a Protocol via the LSP tool
- Show goToImplementation finding overriding methods
- Show workspaceSymbol returning results on empty query via the LSP tool
- Edge case: goToImplementation on a concrete class (should return empty or itself)
