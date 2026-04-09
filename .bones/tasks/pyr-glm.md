---
id: pyr-glm
title: Add semantic tokens to MCP adapter layer
status: closed
type: task
priority: 1
owner: Seth
parent: pyr-mge
---




## Context

SemanticTokensProvider is implemented and wired in languageServerBase.ts. The MCP adapter (pyright-mcp plugin) needs to expose `textDocument/semanticTokens/full` and `textDocument/semanticTokens/range` through the `lsp` tool so agents can request token classifications.

This is the remaining implementation work for the Phase 3 sub-epic criterion: "Adapter layer updated — semantic tokens accessible through MCP + skill/scripts."

**Blocked by:** pyr-tc8 (closed)
**Unlocks:** pyr-mge closure → pyr-evw (Phase 4: Inlay Hints)

## Requirements

The pyright-mcp plugin's `lsp` tool must support:
1. `textDocument/semanticTokens/full` — returns classified tokens for an entire file
2. `textDocument/semanticTokens/range` — returns classified tokens for a given range

The tool must decode the delta-encoded token array into human-readable output (token type names at line/char positions) — raw integer arrays are useless to agents.

## Design

The generic `lsp` tool in `mcp-server.ts` already forwards any LSP method to Pyright. Pyright unconditionally registers `semanticTokensProvider` with `full: true, range: true` (languageServerBase.ts:703-707) and handlers (lines 572-574). So raw protocol forwarding already works — the real work is:

1. **Client capabilities:** The MCP server's init handshake (`mcp-server.ts:81-93`) only declares `textDocument.implementation` and `workspace.symbol`. Add `textDocument.semanticTokens` so Pyright knows the client supports it.

2. **Decoding:** `textDocument/semanticTokens/full` returns `{ data: number[] }` — groups of 5 integers (deltaLine, deltaStartChar, length, tokenType, tokenModifiers) encoded relative to previous token. The MCP tool must detect semantic token responses and decode them using the token legend from `semanticTokensProvider.ts` (`tokenLegend.tokenTypes` maps index → type name).

3. **Same for lsp-client.ts:** The one-shot CLI client has its own init handshake that also needs the capability added.

**Decoded output format:** Array of `{ line, character, length, tokenType, tokenModifiers }` where `tokenType` is the human-readable name (e.g., "class", "function", "parameter") and `tokenModifiers` is a list of modifier names.

**Token legend source:** Exported `tokenLegend` from `semanticTokensProvider.ts`. The MCP layer cannot import from pyright-internal (separate package), so the legend must be either: (a) hardcoded in the adapter matching the server's legend, or (b) retrieved from the server's `initialize` response (`capabilities.semanticTokensProvider.legend`). Option (b) is correct — the legend comes from the initialize response.

**Where decoding lives:** In `mcp-server.ts`, post-process the `lsp` tool result when method matches `textDocument/semanticTokens/*`. This is formatting, not business logic — consistent with the anti-pattern.

## Implementation Steps

### Step 1: Write tests for semantic tokens via MCP lsp tool
Add test to `mcp-server.test.ts` that requests `textDocument/semanticTokens/full` on `sample.py` and asserts decoded token objects with type names (not raw integers). Add test for `/range` variant. Add test to `lsp-client.test.ts` for the CLI path.

### Step 2: Update client capabilities in both init handshakes
Add `textDocument.semanticTokens: { dynamicRegistration: false, requests: { full: true, range: true }, tokenTypes: [...], tokenModifiers: [...] }` to both `mcp-server.ts` and `lsp-client.ts` init params. Capture the server's `capabilities.semanticTokensProvider.legend` from the initialize response for decoding.

### Step 3: Add semantic token decoding to mcp-server.ts
In the `lsp` tool handler, after receiving the result, detect semantic token methods and decode: iterate `result.data` in groups of 5, accumulate absolute line/char, look up token type name from the captured legend.

### Step 4: Add semantic token decoding to lsp-client.ts
Same decoding for the CLI path — apply after receiving the raw result.

### Step 5: Run tests, typecheck, commit

## Success Criteria

- [x] `textDocument/semanticTokens/full` accessible through MCP `lsp` tool, returning decoded tokens
- [x] `textDocument/semanticTokens/range` accessible through MCP `lsp` tool, returning decoded tokens
- [x] Token output decoded into readable format: `{ line, character, length, tokenType: "class"|"function"|..., tokenModifiers: [] }` — not raw delta-encoded integers
- [x] Client capabilities include `textDocument.semanticTokens` in both `mcp-server.ts` and `lsp-client.ts`
- [x] Legend captured from server's initialize response, not hardcoded
- [x] MCP tests: full tokens on sample.py returns decoded objects with correct type names; range tokens returns subset
- [x] CLI tests: `queryLsp` for semantic tokens returns decoded objects

## Edge Cases

- Empty file: `textDocument/semanticTokens/full` should return `{ data: [] }` → decoded to empty array
- Range with no tokens: `/range` returns empty decoded array
- Unknown token type index: if index exceeds legend length, fall back to `"unknown"` — don't crash

## Key Considerations (Failure Catalog)

**Legend Capture**
- Assumption: Initialize response is available for extracting the token legend
- Betrayal: Both `mcp-server.ts` and `lsp-client.ts` currently discard the init response — `.then(() => ...)` ignores the result
- Consequence: No legend available for decoding unless the init flow is restructured
- Mitigation: Capture init result: store `initResult.capabilities.semanticTokensProvider.legend` in a closure variable. In mcp-server.ts this happens before `resolve()` so the `initPromise` gate ensures legend is ready before any tool call.

**Delta Decoding Arithmetic**
- Assumption: deltaStartChar resets to absolute when deltaLine > 0
- Betrayal: LSP spec: when deltaLine > 0, deltaStartChar is absolute (from column 0); when deltaLine === 0, deltaStartChar is relative to previous token. Mixing these up silently produces wrong positions.
- Consequence: Every token after a line break has incorrect character offset
- Mitigation: Standard pattern: `if (deltaLine > 0) char = deltaStartChar; else char += deltaStartChar;`. Test must include tokens on consecutive lines to catch this.

**Null/Empty Results**
- Assumption: `result.data` is always a non-empty array of integers divisible by 5
- Betrayal: Empty file → `{ data: [] }`. Pyright could return `null`. Non-5-aligned data shouldn't happen but would corrupt decode.
- Consequence: Decode loop crashes or produces garbage
- Mitigation: Guard on null/undefined/empty. If `data.length % 5 !== 0`, return raw with warning.

**Token Index Out of Range**
- Assumption: Every tokenType/tokenModifiers index maps to a legend entry
- Betrayal: Index exceeds legend array length
- Consequence: `undefined` serialized as `null` in JSON output
- Mitigation: Fallback to `"unknown"` for out-of-range type indices. Decode modifier bitmask only up to legend length.

## Anti-Patterns

- **Business logic in the adapter** — the adapter decodes/formats but does not classify. Classification lives in SemanticTokensProvider.
- **Hardcoded token legend** — must come from server's initialize response, not duplicated from pyright-internal source.
- **Modifying the generic lsp tool's core logic** — decoding is post-processing on the result for specific methods, not a change to how requests are forwarded.

## Log

- [2026-04-09T14:41:07Z] [Seth] Debrief: Implemented semantic token decoding in MCP adapter and CLI. Shared decode-semantic-tokens.ts extracts delta-encoded arrays into readable objects. Legend captured from init response. Fixed ERR_STREAM_DESTROYED race in CLI cleanup. Reflections: Stale dist bundle was root blocker (built before SemanticTokensProvider commit). vscode-languageserver capability gating was a surprise — handlers exist but don't route without client capability. Both saved as reference memories.
