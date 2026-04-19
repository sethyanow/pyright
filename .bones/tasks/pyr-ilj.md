---
id: pyr-ilj
title: 'Phase 5.5b: Enrichment Hooks + File Intelligence'
status: open
type: epic
priority: 1
depends_on: [pyr-084, pyr-noe, pyr-bay]
parent: pyr-tcv
---





## Context

Second phase of Phase 5.5. With the proxy infrastructure in place, add PostToolUse hooks that fetch code lens, inlay hints, and semantic tokens when the agent reads a Python file, and inject a `<file-intelligence>` block into conversation context.

## Requirements

R5, R6, R7 from parent epic pyr-tcv.

## Success Criteria

- [ ] PostToolUse hook on Read fires for `.py` files
- [ ] Hook calls MCP `lsp()` tool for codeLens, inlayHint, semanticTokens
- [ ] `<file-intelligence>` block injected into agent context
- [ ] Block includes: reference counts, implementation counts, semantic classifications (ABC, Protocol, override), inferred types for unannotated variables/returns
- [ ] Format is compact, line-anchored, scannable (per the design conversation)
- [ ] Full test suite passes: `cd packages/pyright-internal && npm run test:norebuild`
- [ ] `npm run typecheck` clean

## Gate

- PostToolUse hook fires on Read for `.py`, `<file-intelligence>` block visible in agent context
- Block contains all three enrichment types
- Full test suite passes

## Demo

Read a Python file with classes, functions, ABC inheritance, and unannotated variables. Show the `<file-intelligence>` block that appears with reference counts, implementation counts, semantic classifications, and inferred types.

## Key Considerations

- Hook calls MCP which routes through the shared Pyright — no separate connection
- codeLens requires resolve step (unresolved lenses → resolved with counts)
- semanticTokens returns encoded deltas — existing `decodeSemanticTokens` in MCP server handles this
- Inlay hints: only include inferred types for UNANNOTATED symbols — annotated types are noise
- The hook script needs the MCP endpoint — the proxy architecture makes this available
