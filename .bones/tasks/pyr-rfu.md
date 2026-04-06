---
id: pyr-rfu
title: 'Phase 6: Range Providers'
status: open
type: epic
priority: 1
depends_on: [pyr-yh8]
parent: pyr-otr
---

## Context

Phase 6 of pyr-otr. Two independent providers that both operate on AST structure: selection range (expand/shrink selection through AST levels) and folding range (collapsible regions). No dependency on prior phases' visitor pattern — these walk the AST directly.

## Requirements

R7 from parent epic: `textDocument/selectionRange` — AST-aware expand/shrink selection.
R8 from parent epic: `textDocument/foldingRange` — collapsible regions for functions, classes, imports, comments.

## Success Criteria

- [ ] `textDocument/selectionRange` registered in capabilities, returns nested SelectionRange
- [ ] Selection expands through AST levels: expression → statement → block → function → class → module
- [ ] `textDocument/foldingRange` registered in capabilities, returns FoldingRange[]
- [ ] Folding ranges for: functions, classes, imports, multi-line comments, decorators
- [ ] Fourslash tests for both providers covering nesting and edge cases
- [ ] Full test suite passes
- [ ] Adapter layer updated — both providers accessible through MCP + skill/scripts

## Key Considerations

- These two providers are independent — can be implemented in parallel or either order
- Both are pure AST operations, no type evaluation needed
- Selection range returns a linked list of ranges (each parent contains the child)

## Gate

- `cd packages/pyright-internal && npx jest fourSlashRunner.test --forceExit` → selection range + folding range tests pass
- `npm run typecheck` → clean

## Demo

Show me selection range expanding through AST levels, and folding ranges for a file with classes, functions, and imports.
