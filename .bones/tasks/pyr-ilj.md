---
id: pyr-ilj
title: 'Phase 5.5b: Enrichment Hooks + File Intelligence'
status: open
type: epic
priority: 1
depends_on: [pyr-084, pyr-xi9, pyr-1fl]
parent: pyr-tcv
---










## Context

Second phase of Phase 5.5. Three sub-tasks organize the work:

A. Extend pyright-internal's `semanticTokensProvider` tokenModifiers to emit `abstract`, `protocol`, `override` (both explicit `@override` and implicit parent-shadowing).
B. Build a `file_intelligence` MCP tool that, given a `.py` path, fetches codeLens, inlayHint, and semanticTokens from shared Pyright via the warm `lsp-client.ts` MessageConnection and returns a formatted `<file-intelligence>` block.
C. Wire a PostToolUse hook on Read / Edit / Write for `.py` files that calls `file_intelligence` and injects the returned block into conversation context.

Strict ordering: A → B → C. The MCP tool consumes live tokenModifiers; the hook consumes the MCP tool.

## Requirements

R5, R6, R7 from parent epic pyr-tcv.

## Success Criteria

- [x] Sub-task A complete: `semanticTokensProvider` tokenModifiers legend includes `abstract`, `protocol`, `override`; walker emits them correctly
- [x] Sub-task B complete: `file_intelligence` MCP tool returns formatted `<file-intelligence>` block for a given `.py` path
- [ ] Sub-task C complete: PostToolUse hook on Read/Edit/Write for `.py` invokes the tool and injects the result
- [x] Block includes: codeLens reference/implementation counts, semantic classifications from `tokenModifiers`, inlay Type hints for unannotated variables/returns
- [x] Format is compact, line-anchored, scannable
- [x] Full test suite passes: `cd packages/pyright-internal && npm run test:norebuild`
- [x] `npm run typecheck` clean

## Gate

- All three sub-tasks closed
- End-to-end: reading a `.py` file in Claude Code produces a `<file-intelligence>` block with all three enrichment types
- Full test suite passes
- `npm run typecheck` clean

## Demo

Read a Python file with classes, functions, ABC inheritance, and unannotated variables. Show the `<file-intelligence>` block that appears with reference counts, implementation counts, semantic classifications, and inferred types.

## Key Considerations

- `semanticTokensProvider.ts` currently has `tokenLegend.tokenModifiers: []` — sub-task A extends the legend and updates `SemanticTokenWalker` to emit modifier bitsets
- `_pushToken` currently passes `0` as the modifier bitset; sub-task A changes the call sites to compute a bitset
- MCP tool uses the warm `lsp-client.ts` MessageConnection — no per-call initialize/didOpen, no separate Pyright connection
- codeLens requires a resolve step (unresolved lenses → resolved with counts) — the MCP tool handles it
- semanticTokens returns encoded deltas — existing `decodeSemanticTokens` in the MCP server handles decoding; new modifier bits must be read from the live legend, not hardcoded
- Inlay hints: only include inferred types for UNANNOTATED symbols — annotated types are noise
- Hook is a thin caller: invoke the MCP tool, inject returned block. No formatting, fetching, or decoding inside the hook

## Log

- [2026-04-19T21:04:49Z] [Seth] Adversarial stress test (pyr-1fl): 2 out-of-scope concerns surfaced. (1) UTF-16 vs utf-8 position encoding — we hardcode UTF-16 assumption; if an LSP client ever negotiates utf-8 via initialize.general.positionEncodings, our identifier-slicing breaks. Pyright hardcodes UTF-16 in the semantic tokens legend so this is latent. (2) File paths containing URL-reserved chars (#, ?, fragment/query delimiters) would break 'file://' + path URI construction — my handler concatenates raw paths. Neither blocks pyr-1fl; logging for Phase 5.5b acceptance + Phase 6+ if relevant.
