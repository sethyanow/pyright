---
id: pyr-qqb
title: 'Adapter warmup: send didOpen before document-level queries'
status: closed
type: bug
priority: 1
owner: Seth
parent: pyr-evw
---





## Context

Both `lsp-client.ts` and `mcp-server.ts` warm up by polling `workspace/symbol` until results appear. This proves files are parsed and bound, but does NOT trigger full type checking. Document-level providers (`textDocument/inlayHint`, `textDocument/semanticTokens/*`, etc.) that call `evaluator.getType()` get `Unknown` for symbols Pyright hasn't fully evaluated yet.

Discovered during Phase 4 acceptance (pyr-9uz): return type hints on unannotated functions don't appear in MCP/CLI demo, despite fourslash tests proving the provider works. The fourslash harness sends `textDocument/didOpen` which forces full analysis.

Root cause traced to pyr-o4h failure catalog — "Temporal Betrayal: Pyright background analysis" — where the mitigation was "Document in the skill" instead of fixing.

## Requirements

R1. `lsp-client.ts`: send `textDocument/didOpen` for the target file before document-level requests
R2. `mcp-server.ts`: same — extract URI from params, send `didOpen` before forwarding
R3. Both paths must read file content from disk for the `didOpen` notification
R4. Existing tests must still pass; add regression test that return type hints appear via CLI/MCP

## Success Criteria

- [x] `def multiply(x: int, y: int):` in sample.py gets `: int` return type hint via lsp-client CLI
- [x] Same hint appears via MCP `lsp()` tool
- [x] All existing lsp-client and mcp-server tests pass
- [x] Regression test: lsp-client test asserts return type hint (kind 1) at line 27 (0-indexed, the `multiply` def)
- [x] Regression test: mcp-server test asserts same (return type hint at line 27)

## Implementation

1. **lsp-client.ts** — BEFORE the `workspace/symbol` warmup poll (line 84), check if `method.startsWith('textDocument/') && !method.startsWith('textDocument/did')`. If so: extract `params.textDocument?.uri`, guard it starts with `file://`, read content via `fs.readFileSync(decodeURIComponent(new URL(uri).pathname), 'utf-8')`, send `textDocument/didOpen` notification with `{ textDocument: { uri, languageId: 'python', version: 1, text } }`. The existing warmup poll then provides the wait window for analysis to complete.
2. **mcp-server.ts** — In the `lsp` tool handler, after the init gate and before `sendRequest`: same method check (`textDocument/*` excluding `textDocument/did*`). Extract URI, guard `file://` scheme. Track opened URIs in a `Set<string>` on the server instance — only send `didOpen` if not already tracked. Read file, send notification. Add a short retry (2-3 attempts, 200ms) on the actual `sendRequest` for the first-open case where analysis may still be running.
3. **Detecting document-level methods:** `method.startsWith('textDocument/') && !method.startsWith('textDocument/did')` — excludes `didOpen`, `didClose`, `didChange`, `didSave`.
4. **File reading:** `decodeURIComponent(new URL(uri).pathname)` → `fs.readFileSync(path, 'utf-8')`. Skip if URI is not `file://` scheme.
5. **Update existing tests:** Tighten inlay hint assertions in both test files to assert a return type hint (kind 1) specifically at line 28 (`multiply` def).

## Anti-Patterns

- Don't send `didOpen` for workspace-level queries (`workspace/symbol`) — they don't need it
- Don't cache opened documents across one-shot CLI invocations — each spawn is fresh
- Don't send `didOpen` for any `textDocument/did*` method (`didOpen`, `didClose`, `didChange`, `didSave`) — these are document sync notifications, not queries

## Edge Cases

- File URI points to a file that doesn't exist on disk — let `readFileSync` throw; the error propagates as an LSP error response (both paths already have try/catch)
- `textDocument/semanticTokens/full` and `textDocument/semanticTokens/range` also benefit from `didOpen` — the fix applies to ALL `textDocument/*` methods, not just inlay hints
- `params.textDocument` may be missing for malformed requests — guard with optional chaining before attempting to read URI

## Key Considerations

### Timing: send didOpen BEFORE the workspace/symbol warmup poll

The `didOpen` notification is fire-and-forget — Pyright queues background analysis. If sent AFTER the warmup poll, there's a race: the subsequent request may execute before analysis completes. The structural fix: send `didOpen` BEFORE the `workspace/symbol` poll loop. Pyright then runs full type checking during the poll wait window, and by the time the poll succeeds, the document is fully evaluated. This avoids any need for extra delays or retry loops.

For lsp-client.ts: move `didOpen` before line 85 (the warmup poll). For mcp-server.ts: send `didOpen` before the `sendRequest`, but the server already waited for warmup during `beforeAll` — the race window is smaller but still present for files not previously opened. A short retry (2-3 attempts, 200ms delay) on the actual request handles this.

### Pyright handles duplicate didOpen gracefully

Verified: `languageServerBase.ts:1239-1242` — duplicate `didOpen` logs an error but updates the document and continues. Does not throw or reject. For mcp-server.ts (long-lived), track opened URIs in a `Set<string>` to avoid log noise. For lsp-client.ts (one-shot), no tracking needed.

### Method exclusion list

Anti-pattern says exclude `didOpen`/`didClose`. Also exclude `didChange` and `didSave` — these are document synchronization notifications the caller sends intentionally. Full exclusion check: `method.startsWith('textDocument/did')`.

### URI handling

Use `decodeURIComponent(new URL(uri).pathname)` — not just `new URL(uri).pathname`. URIs may contain encoded characters (`%20` for spaces). Skip `didOpen` entirely for non-`file://` URIs (e.g., `untitled:` for unsaved buffers).

### lsp-client.ts is one-shot — no didClose needed

Process dies after the query. No cleanup required.

## Failure Catalog

**Temporal Betrayal: didOpen timing (lsp-client.ts)**
- Assumption: After sending `didOpen`, the next `sendRequest` sees fully evaluated types
- Betrayal: `didOpen` is fire-and-forget — Pyright queues background analysis. Immediate request races with analysis.
- Consequence: Fix works in slow environments but fails in fast ones. Flaky tests.
- Mitigation: Send `didOpen` BEFORE the `workspace/symbol` warmup poll — analysis runs during poll wait.

**Temporal Betrayal: didOpen timing (mcp-server.ts)**
- Assumption: Same — `didOpen` → immediate request sees results
- Betrayal: mcp-server.ts is long-lived; first request for a new file races with analysis
- Consequence: First request returns incomplete results; subsequent requests work (file already open)
- Mitigation: Short retry loop (2-3 attempts, 200ms) on the actual request after `didOpen`. Or accept the warmup poll already provides sufficient wait time.

**Input Hostility: URI encoding**
- Assumption: `new URL(uri).pathname` returns a usable filesystem path
- Betrayal: URI contains `%20`, `%28`, etc. — `pathname` preserves encoding, `readFileSync` gets ENOENT
- Consequence: `didOpen` fails for files with spaces or special characters in path
- Mitigation: `decodeURIComponent()` after `new URL().pathname`. Guard non-`file://` schemes.

**State Corruption: duplicate didOpen (mcp-server.ts)**
- Assumption: Sending `didOpen` for every request is safe
- Betrayal: Pyright logs error on duplicate opens (`languageServerBase.ts:1240`) — functional but noisy
- Consequence: Pyright logs fill with redundant open errors
- Mitigation: Track opened URIs in `Set<string>`. Check before sending. Cheap and prevents log noise.

## Log

- [2026-04-10T16:16:20Z] [Seth] Debrief: Root cause was missing didOpen — Pyright only parses/binds without it, type evaluator skips return type inference. Fix: send didOpen before textDocument/* queries in both lsp-client.ts and mcp-server.ts. 500ms delay needed in mcp-server for background analysis. Reflections: Main surprise was 0-indexed line numbers — wasted cycles debugging a correct fix because test assertion used 1-indexed line 28 instead of 0-indexed line 27. Skeleton was accurate on root cause but specified wrong line number. New memory: LSP 0-indexed positions reference.
