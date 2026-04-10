---
id: pyr-evw
title: 'Phase 4: Inlay Hints'
status: closed
type: epic
priority: 1
depends_on: [pyr-mge, pyr-zve, pyr-7ds, pyr-9uz]
parent: pyr-otr
---









## Context

Phase 4 of pyr-otr. Depends on Phase 3's file-walking visitor pattern that resolves nodes through the evaluator. Reuses the visitor to emit hints at specific positions instead of classifying tokens.

## Requirements

R5 from parent epic: `textDocument/inlayHint` — show inferred return types, variable types, and parameter names at call sites.

## Success Criteria

- [x] `textDocument/inlayHint` registered in capabilities, returns InlayHint[]
- [x] Inferred return types shown on functions without return annotations
- [x] Inferred variable types shown on assignments without annotations
- [x] Parameter names shown at call sites
- [x] Fourslash tests covering: return type inference, variable type inference, parameter names
- [x] Full test suite passes
- [x] Adapter layer updated — inlay hints accessible through MCP + skill/scripts

## Key Considerations

- Reuses Phase 3's visitor pattern — emit hints at positions instead of classifying tokens
- If Phase 3's visitor doesn't generalize cleanly, build own walker — duplication, not catastrophic

## Gate

- `cd packages/pyright-internal && npx jest fourSlashRunner.test --forceExit` → inlay hint tests pass
- `npm run typecheck` → clean

## Demo

Show me inlay hints on a Python file — inferred return types, variable types, parameter names at call sites.

## Log

- [2026-04-10T17:05:06Z] [Seth] Phase 4 closed. All children (pyr-zve, pyr-7ds, pyr-qqb, pyr-9uz) closed. 7/7 criteria met. Acceptance demo showed all three hint types via both CLI and MCP. Next: Phase 5 (pyr-yh8, Code Lens) is unblocked.
