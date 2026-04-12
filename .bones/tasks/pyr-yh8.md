---
id: pyr-yh8
title: 'Phase 5: Code Lens'
status: open
type: epic
priority: 1
depends_on: [pyr-evw, pyr-onu, pyr-21b]
parent: pyr-otr
---






## Context

Phase 5 of pyr-otr. Can reuse Phase 3's visitor pattern to enumerate symbols, then query the references provider and implementation provider for counts per symbol.

## Requirements

R6 from parent epic: `textDocument/codeLens` — show reference counts and implementation counts inline.

## Success Criteria

- [x] `textDocument/codeLens` registered in capabilities, returns CodeLens[]
- [x] Reference counts shown on classes and functions
- [x] Implementation counts shown on Protocols/ABCs/base classes
- [x] Counts are live — adding a reference updates the count
- [x] Fourslash tests covering: reference counts, implementation counts, count updates
- [x] Full test suite passes
- [x] Adapter layer updated — code lens accessible through MCP + skill/scripts

## Key Considerations

- Counts must be live queries, not cached — the pre-block in the parent epic's failure catalog tests this
- Performance on large workspaces may need lazy evaluation
- Can reuse Phase 3's visitor for symbol enumeration, references provider for counts

## Gate

- `cd packages/pyright-internal && npx jest fourSlashRunner.test --forceExit` → code lens tests pass
- `npm run typecheck` → clean

## Demo

Show me reference and implementation counts appearing on classes and functions.
