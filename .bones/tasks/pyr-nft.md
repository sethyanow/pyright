---
id: pyr-nft
title: 'Phase 7: Refactoring'
status: open
type: epic
priority: 1
depends_on: [pyr-rfu]
parent: pyr-otr
---

## Context

Phase 7 of pyr-otr. The heaviest phase. Consumes navigation providers from all prior phases — references, implementations, type info at position — to determine what to extract, what's captured, what imports to rewrite.

## Requirements

R9 from parent epic: `codeAction` with `refactor.extract` — extract method and extract variable from selection.
R10 from parent epic: `codeAction` with `refactor.rewrite` — move symbol to another file with import rewriting.

## Success Criteria

- [ ] `codeAction` returns `refactor.extract.method` and `refactor.extract.variable` for valid selections
- [ ] Extract method correctly identifies captured variables (taken as parameters) and return values
- [ ] Extract variable replaces expression with variable, inserts assignment
- [ ] `codeAction` returns `refactor.rewrite.moveSymbol` for classes/functions
- [ ] Move symbol rewrites imports in all files that reference the moved symbol
- [ ] Fourslash tests covering: extract with captured closure variables, extract with return value, move with import rewriting
- [ ] Full test suite passes
- [ ] Adapter layer updated — refactoring actions accessible through MCP + skill/scripts

## Key Considerations

- Extract method must do scope analysis — captured variables become parameters, not just cut-paste
- Move symbol must rewrite imports across the entire workspace
- Both operations produce WorkspaceEdits (multi-file changes)
- Existing `codeActionProvider.ts` only supports QuickFix (create type stub) — needs extension to support refactoring kinds

## Gate

- `cd packages/pyright-internal && npx jest fourSlashRunner.test --forceExit` → refactoring tests pass
- `npm run typecheck` → clean

## Demo

Show me extract method on a selection (correct captured variables, return type), and move symbol rewriting imports across files.
