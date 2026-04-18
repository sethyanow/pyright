---
id: pyr-noe
title: 'Phase 5.5b Task 1: PostToolUse hook scaffold + codeLens file-intelligence'
status: closed
type: task
priority: 1
parent: pyr-ilj
---







## Context

First task of Phase 5.5b (pyr-ilj). Build the walking skeleton for the PostToolUse enrichment pipeline: when the agent Reads a Python file, a hook fetches codeLens for that file from the shared Pyright and injects a `<file-intelligence>` block into the agent's context. This task ships codeLens only — subsequent Phase 5.5b tasks extend with inlayHint, semanticTokens, and classification.

**Blocked by:** pyr-084 (closed — proxy infrastructure exists and shared Pyright is accessible via Unix socket)
**Unlocks:** Task 2 (inlayHint enrichment), Task 3 (semanticTokens + classifications), Phase 5.5b acceptance demo

## Requirements

From pyr-tcv parent epic:
- R5 (partial): PostToolUse hook on Read for `.py` files calls the MCP / shared Pyright to fetch codeLens and injects `<file-intelligence>` into context
- R6 (partial): block is compact, line-anchored, scannable — codeLens portion only in this task
- R7: all existing tests pass, MCP tool behavior unchanged, fourslash unaffected

## Design

### Hook flow

```
Claude Code Read(_demo_codelens.py)
    ↓
PostToolUse hook fires (matcher: tool_name=Read, file_path=*.py|*.pyi)
    ↓
hooks/scripts/enrich-file.ts (compiled to .js)
    ↓
Connect to ${CLAUDE_PLUGIN_DATA}/pyright.sock (shared Pyright via proxy)
    ↓
LSP initialize + didOpen + textDocument/codeLens + codeLens/resolve per item
    ↓
Format as <file-intelligence> block → stdout JSON with additionalContext
    ↓
Claude Code injects into next agent turn
```

### Why direct socket, not MCP-over-stdio

The hook is a transient process (spawned per Read). Speaking MCP means spawning `dist/proxy.js --mcp` as a child, doing the MCP handshake, calling the `lsp()` tool, parsing the response — heavy for a per-Read hook. Direct socket connection makes the hook another LSP client of the shared Pyright, reusing the multiplexing already in place (see `createSocketBridge` in `proxy.ts:88`). No new infrastructure, one less protocol layer.

The epic's R5 language ("calls the MCP") is about routing through the shared Pyright backend — which direct-socket access also achieves. If the user intended strict MCP-over-stdio invocation, that's a design correction to surface, not an unstated constraint to infer.

### Block format (codeLens-only slice)

```
<file-intelligence path="packages/pyright-internal/src/analyzer/types.ts">
L23  class Foo         refs=12 impls=3
L45  class Bar         refs=0  impls=0
L89  def helper        refs=7
</file-intelligence>
```

One line per resolved codeLens, columns line-anchored. `refs=` and `impls=` come from the resolve step (Phase 5 `codeLens/resolve` with `kind: "references"` / `kind: "implementations"`).

### Files

- New: `packages/pyright-mcp/src/hooks/enrich-file.ts` — hook entry point (bundles to `dist/hooks/enrich-file.js` via webpack)
- New: `packages/pyright-mcp/src/hooks/socket-lsp-client.ts` — minimal LSP client over Unix socket (reusable by subsequent tasks for inlayHint/semanticTokens)
- New: `packages/pyright-mcp/src/hooks/format-block.ts` — `<file-intelligence>` formatter (takes LSP results, produces block string)
- New: `packages/pyright-mcp/src/tests/hooks/enrich-file.test.ts` — unit test
- Modified: `packages/pyright-mcp/hooks/hooks.json` — add PostToolUse entry
- Modified: `packages/pyright-mcp/webpack.config.js` — add `hooks/enrich-file` entry point

## Implementation

### Step 1: Write failing unit test for format-block

File: `packages/pyright-mcp/src/tests/hooks/format-block.test.ts`

Test intent: `formatFileIntelligence(filePath, codeLenses)` takes an absolute path and an array of resolved LSP CodeLens items (each with `range.start.line`, a `command.title` like "12 references", plus parsed category) and returns the `<file-intelligence>` block string.

Key assertions:
- Block wrapped in `<file-intelligence path="..."></file-intelligence>`
- One line per lens with format `L{line}  {symbol}  refs={n} impls={m}` (columns may be space-padded for alignment)
- Missing counts omitted (e.g., a lens with only references → no `impls=` field)
- Empty lens list → empty body (just open/close tags with path)

Run: `cd packages/pyright-mcp && npx jest format-block --forceExit` — expect file-not-found failure.

### Step 2: Implement format-block to pass the test

File: `packages/pyright-mcp/src/hooks/format-block.ts`

Export `formatFileIntelligence(path: string, lenses: ResolvedLens[]): string`. `ResolvedLens` shape: `{ line: number; symbol: string; references?: number; implementations?: number }`.

The parsing of LSP CodeLens `command.title` (e.g., "12 references", "3 implementations") into `references` / `implementations` happens in the caller, not in format-block — keep the formatter pure over the parsed shape.

Run: `cd packages/pyright-mcp && npx jest format-block --forceExit` — expect pass.

### Step 3: Write failing test for socket-lsp-client

File: `packages/pyright-mcp/src/tests/hooks/socket-lsp-client.test.ts`

Test intent: `fetchCodeLenses(socketPath, filePath)` connects to a Unix socket speaking LSP, runs `initialize` + `initialized` + `textDocument/didOpen` + `textDocument/codeLens` + resolves each lens, returns `ResolvedLens[]`.

Test setup: spawn a real Pyright via the existing test helper pattern from `mcp-server.test.ts` (`spawnAndInitPyright`), bridge it to a temp Unix socket in a `PYRIGHT_PROXY_STATE_DIR`. Call `fetchCodeLenses` against that socket path on a fixture Python file with known classes (reuse `_demo_codelens.py` or create a fixture in `src/tests/fixtures/`).

Key assertions: returns non-empty array; each item has `line` (number), `symbol` (string); at least one item has `implementations` ≥ 2 (the ABC in the fixture has two concrete subclasses).

**Fixture:** Use the existing committed fixture `packages/pyright-mcp/src/tests/fixtures/sample.py` (ABC `Greeter` + `EnglishGreeter`/`SpanishGreeter`). **Do not** use `_demo_codelens.py` at repo root — it is untracked and unavailable to CI. If an isolated fixture is preferred (so adding tests in other phases doesn't conflict), create `packages/pyright-mcp/src/tests/fixtures/codelens/` with a `pyrightconfig.json` + `demo.py` mirroring the existing per-test fixture layout.

**Test setup pattern:** Reuse `spawnProxy('lsp', stateDir)` from `proxy.test.ts:21` (via import or copy the helper). That helper spawns the built `dist/proxy.js --lsp`, which handles Pyright spawn + socket creation inside `PYRIGHT_PROXY_STATE_DIR`. Simpler than manually bridging `spawnAndInitPyright` to a socket. Resolve `socketPath = path.join(stateDir, 'pyright.sock')` and wait for it to exist (`fs.existsSync` poll) before calling `fetchCodeLenses`. This requires the proxy to be built (`dist/proxy.js`) before the test runs — the existing `package.json`'s `pretest` script already handles this.

Run: `cd packages/pyright-mcp && npx jest socket-lsp-client --forceExit` — expect file-not-found failure.

### Step 4: Implement socket-lsp-client

File: `packages/pyright-mcp/src/hooks/socket-lsp-client.ts`

Export `fetchCodeLenses(socketPath: string, filePath: string): Promise<ResolvedLens[]>`. Uses `net.createConnection` + `vscode-jsonrpc` `StreamMessageReader`/`StreamMessageWriter` + `createMessageConnection` — same pattern as the MCP-mode handshake at `proxy.ts:288-331` (socket connect + MessageConnection + initialize + initialized). Parses `command.title` strings to extract `references`/`implementations` counts.

**Title format** (from `codeLensProvider.ts:127-133`): `"${count} ${noun}"` for count==1, `"${count} ${noun}s"` otherwise, where `noun` is `reference` or `implementation`. Regex: `/^(\d+)\s+(reference|implementation)s?$/`.

**Populating `ResolvedLens.symbol`:** `textDocument/codeLens` does NOT return symbol names — only `range` + opaque `data`. To get names, send `textDocument/documentSymbol` for the same URI and correlate by `selectionRange.start` (codeLens data's `position` is exactly the symbol's `selectionRange.start` — see `codeLensProvider.ts:87-104`). Build a map `position → name` from the documentSymbol tree (flatten children), then look up each lens's position. If no match is found, fall back to empty string or skip — do not invent a name.

Key decisions:
- workspace root for `initialize`: pass `process.cwd()` — hooks run from the editor's cwd
- `didOpen` content: read file from disk (the hook fires AFTER the Read, file is on disk)
- timeout: reuse the 30s pattern from `mcp-server.ts:66-72`
- connection teardown: explicit `connection.dispose()` + `socket.end()` after response — do NOT send `shutdown`/`exit` (those terminate the shared Pyright)

Run: `cd packages/pyright-mcp && npx jest socket-lsp-client --forceExit` — expect pass.

### Step 5: Write failing integration test for enrich-file entry

File: `packages/pyright-mcp/src/tests/hooks/enrich-file.test.ts`

Test intent: invoke `enrichFile` (the exported handler inside `enrich-file.ts`) with a fake `PostToolUseInput` for a `Read` of a `.py` fixture, with `PYRIGHT_PROXY_STATE_DIR` pointing to a temp dir where a test Pyright is listening. Assert the returned object matches Claude Code's `{ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "<file-intelligence ..." } }` shape.

Skip cases to assert: non-`.py` file path → returns no-op (empty object or `{ decision: "approve" }` per hook spec).

Run: `cd packages/pyright-mcp && npx jest enrich-file --forceExit` — expect file-not-found failure.

### Step 6: Implement enrich-file entry point

File: `packages/pyright-mcp/src/hooks/enrich-file.ts`

Export `enrichFile(input: PostToolUseInput): Promise<HookOutput>`. Flow:
1. Parse `input.tool_input.file_path`; return no-op if not `.py`/`.pyi`
2. Resolve socket path from `PYRIGHT_PROXY_STATE_DIR` or `CLAUDE_PLUGIN_DATA`
3. Call `fetchCodeLenses(socketPath, filePath)`
4. Call `formatFileIntelligence(filePath, lenses)`
5. Return Claude Code hook output JSON

CLI entry at bottom:
```ts
if (require.main === module) {
    readStdinJson().then(enrichFile).then(output => {
        process.stdout.write(JSON.stringify(output));
    }).catch(err => {
        process.stderr.write(`enrich-file error: ${err.message}\n`);
        process.exit(0); // don't block the Read, just log
    });
}
```

**Decision to verify against Claude Code hook docs during implementation:** the exact JSON shape for additionalContext injection. Check `plugin-dev:hook-development` skill or existing hook examples in the codebase for canonical shape. Adjust `HookOutput` type accordingly.

Run: `cd packages/pyright-mcp && npx jest enrich-file --forceExit` — expect pass.

### Step 7: Add webpack entry point

File: `packages/pyright-mcp/webpack.config.js`

Add `'hooks/enrich-file': './src/hooks/enrich-file.ts'` to entries. Verify `npm run webpack` produces `dist/hooks/enrich-file.js`.

### Step 8: Register PostToolUse hook in hooks.json

File: `packages/pyright-mcp/hooks/hooks.json`

Add entry:
```json
"PostToolUse": [
    {
        "matcher": "Read",
        "hooks": [
            {
                "type": "command",
                "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/hooks/enrich-file.js",
                "timeout": 10
            }
        ]
    }
]
```

Verify the matcher format against Claude Code plugin docs — the exact matcher schema (string vs object, event-level vs hook-level file-path filter) must be confirmed.

### Step 9: Manual verification

1. `npm run webpack` in `packages/pyright-mcp`
2. Restart Claude Code (hook registration requires reload)
3. Read a Python file with classes + ABC inheritance (e.g., `packages/pyright-mcp/src/tests/fixtures/sample.py` — committed — or the untracked `_demo_codelens.py` at repo root if it still exists)
4. Confirm `<file-intelligence>` block appears in next turn's context with class/function rows + refs/impls counts
5. Read a non-Python file — confirm no block

### Step 10: Full verification

- `cd packages/pyright-mcp && npx jest --forceExit` — all tests pass (existing + new hook tests)
- `cd packages/pyright-internal && npm run test:norebuild` — all pass, no regressions
- `npm run typecheck` — clean

## Success Criteria

- [x] `src/hooks/enrich-file.ts` created and bundles to `dist/hooks/enrich-file.js`
- [x] `src/hooks/socket-lsp-client.ts` connects to shared Pyright via Unix socket and fetches resolved codeLens
- [x] `src/hooks/format-block.ts` produces `<file-intelligence>` block with line-anchored refs/impls counts
- [x] `format-block` escapes `"` and `<` in paths and symbol names (HTML entities)
- [x] `format-block` caps output at 100 lines and appends `… N more symbols omitted` when truncated
- [x] `fetchCodeLenses` resolves with `[]` (not reject) when its internal timeout trips — verified by test with a non-responsive socket
- [x] `hooks.json` registers PostToolUse on Read alongside existing `SessionStart` hook (does not overwrite)
- [x] Manual verification: Reading a Python file produces a visible `<file-intelligence>` block in agent context (scripted end-to-end via /tmp/verify-enrich.sh against compiled bundle — sample.py produces block with Greeter refs=3 impls=2; /etc/hosts returns `{}`)
- [x] Unit tests for format-block and socket-lsp-client pass
- [x] Integration test for enrich-file entry passes
- [x] `cd packages/pyright-internal && npm run test:norebuild` — all pass (2392/2392)
- [x] `npm run typecheck` — clean

## Anti-Patterns

- **Don't make the hook spawn its own Pyright.** Use the shared socket. REASON: defeats the proxy architecture from Phase 5.5a.
- **Don't speak MCP-over-stdio from the hook.** Direct LSP via socket is simpler. REASON: MCP handshake + tool-call round-trip is overhead the transient hook doesn't need.
- **Don't block the Read on hook failure.** `process.exit(0)` on any error inside the hook. REASON: a broken enrichment hook must not break file reading.
- **Don't resolve all codeLens types in this task.** `implementations` + `references` only. REASON: scope kept tight; semantic classifications (ABC/Protocol) come in Task 3.

## Key Considerations

- **Socket race:** the hook assumes the shared Pyright is already running (Claude Code started the MCP/LSP plugins). If `pyright.sock` doesn't exist, the hook should no-op silently, not spawn Pyright — spawning would create an orphan if Claude Code didn't already spawn one. Error path: log to stderr, exit 0.
- **didOpen duplication:** the MCP server + LSP plugin may have already sent `didOpen` for this file to the shared Pyright. Sending a second `didOpen` from the hook is a no-op for Pyright (it ignores repeats for the same URI), but the hook should not send `didClose` after — that would affect other clients.
- **Large file policy:** pyr-tcv's Open Questions section flags whether to skip enrichment for files >5000 lines. This task's scope is the scaffold — skip that heuristic for now, surface as a follow-up if codeLens resolution is slow on big files during manual verification.
- **Hook output schema:** Claude Code's exact hook output JSON format for context injection — verify against `plugin-dev:hook-development` docs or an existing example before finalizing `HookOutput` type. If the canonical shape isn't immediately findable, STOP and surface the question to the user.
- **Third concurrent client on shared Pyright:** the hook adds a third socket client alongside `--lsp` (Claude Code's LSP) and `--mcp` (the MCP tool). `createSocketBridge` broadcasts Pyright stdout to all clients; each client's `MessageConnection` filters by its own request IDs. Existing LSP+MCP tests exercise this pattern, but not at three-way concurrency. If flakiness shows up during manual verification (e.g., cross-talk, stuck requests), that's a proxy-layer concern to escalate — do not paper over with retries in the hook.
- **Cold-cache codeLens performance:** prior session note (handoff 2026-04-12) observed `codeLens/resolve` with `kind: "implementations"` timing out on cold cache in large workspaces. Phase 5 (pyr-yh8) is closed, so presumably this was addressed — but manual verification should watch for hook timeouts on the first Read after a fresh Pyright spawn. The hook's 10s timeout (per `hooks.json` entry) means Pyright must resolve within 10s of the Read completing. If it doesn't, the hook exits 0 silently; surface the performance gap as a follow-up, do not extend the timeout.

## Failure Catalog

### socket-lsp-client.ts

**Dependency Treachery: Request ID collision on shared Pyright**
- Assumption: LSP request IDs are unique enough that each `MessageConnection` correctly correlates its responses.
- Betrayal: `createSocketBridge` broadcasts Pyright's stdout to every socket client. `vscode-jsonrpc`'s `MessageConnection` starts IDs at 0 and increments locally — if the MCP client, LSP plugin, and hook all send ID 1 within overlapping windows, Pyright sees duplicate IDs on its stdin, and each client filters responses by its own ID. In the worst case, a response parsed by the wrong client's connection is dropped or misattributed.
- Consequence: Hook receives silence (response consumed by another client's connection filter) or cross-talk (decodes another client's payload). Hook times out or returns garbage lenses.
- Mitigation: Start request IDs at a large random offset (`Math.floor(Math.random() * 1_000_000)`) when creating the hook's `MessageConnection`, reducing collision probability. Structural fix (proper fan-out/fan-in in the proxy) is proxy-layer scope — escalate if cross-talk is observed, do not paper over in the hook.

**Dependency Treachery: Inner timeout longer than hook timeout**
- Assumption: The 30s default timeout (copied from `mcp-server.ts`) is safe for the hook.
- Betrayal: `hooks.json` gives the hook process 10s total. If the LSP request waits 30s, Claude Code kills the hook mid-request and the next turn gets no context.
- Consequence: Silent failure — partial work done, no output delivered.
- Mitigation: Use a SHORTER internal timeout (e.g., 7s) so `fetchCodeLenses` can return an empty array cleanly before Claude Code kills the process. On internal timeout, resolve with `[]` rather than rejecting — the formatter handles empty input.

**Temporal Betrayal: File content drift between Read and hook fire**
- Assumption: File on disk at hook time matches what Claude Code's Read tool returned.
- Betrayal: External process modifies the file in the race window (small but nonzero). Or hook reads from disk while agent already has a stale view.
- Consequence: codeLens positions reference a version of the file the agent doesn't have in context.
- Mitigation: If PostToolUse input's `tool_response` carries the actual read content, use that for `didOpen` instead of re-reading disk. Verify during implementation which Claude Code passes. Otherwise, accept the race — document it.

### format-block.ts

**Input Hostility: Special characters in symbol names or paths**
- Assumption: Symbol names and paths are simple text that won't conflict with the `<file-intelligence path="...">` wrapper.
- Betrayal: Python allows Unicode identifiers and quoted string literals in some syntactic positions. Absolute paths can contain spaces, quotes, or non-ASCII characters.
- Consequence: A path containing `"` or a symbol containing `<` corrupts the block's XML-like framing, potentially confusing the context parser.
- Mitigation: Escape `"` and `<` in the `path="..."` attribute and in the `symbol` column — replace with `&quot;` and `&lt;` (minimal HTML-entity subset). This is structural: the formatter owns the escaping; callers pass raw strings.

**Resource Exhaustion: Unbounded output for large files**
- Assumption: Files have tens to low-hundreds of symbols.
- Betrayal: A generated or typeshed-adjacent file may have thousands of classes/functions, producing thousands of lens lines.
- Consequence: Context window pollution — the enrichment block dominates the turn.
- Mitigation: Cap output at 100 lines, sorted by `refs + impls` descending. On truncation, append a final line `… N more symbols omitted`. Walking skeleton ships with cap in place — do not defer.

### enrich-file.ts

**Input Hostility: Non-absolute or malformed file paths**
- Assumption: `input.tool_input.file_path` is an absolute POSIX path.
- Betrayal: Claude Code may pass a cwd-relative path, a `~`-prefixed path, or a URI (`file://...`). On macOS, case-insensitive filesystems can return paths with different casing than expected.
- Consequence: `readFileSync` throws ENOENT or opens the wrong file; `pathToFileURL` conversion produces an invalid URI for Pyright.
- Mitigation: Normalize with `path.resolve(process.cwd(), filePath)` then `pathToFileURL()` for the LSP URI. Reject non-existent paths early — return no-op. Do not expand `~` manually.

**State Corruption: Concurrent hook invocations**
- Assumption: One Read → one hook process.
- Betrayal: Two fast-fire Reads → two parallel hook processes, both connecting to the same shared Pyright. Combines with request-ID collision concern above.
- Consequence: Cross-talk amplified — two hooks racing for responses.
- Mitigation: Each hook has its own connection and own ID space with random offset. Accept that parallel hooks may both degrade gracefully to empty blocks rather than produce corrupt output. No serialization required in the hook itself.

### hooks.json

**State Corruption: Overwriting existing hook registrations**
- Assumption: Adding a `PostToolUse` key is additive.
- Betrayal: JSON merge rewrites the entire `hooks` object if the edit is naive — existing `SessionStart` hook for `check-build.sh` could be lost.
- Consequence: Build-check warning disappears; users don't get build-staleness feedback.
- Mitigation: When editing `hooks.json`, add the `PostToolUse` key alongside `SessionStart` — do not replace the whole `hooks` object. Verify `SessionStart.check-build.sh` still fires after the edit.

### Categories skipped

- **format-block encoding boundaries:** Node string → UTF-8 stdout is the default; no FFI or serialization boundary beyond what `JSON.stringify` handles for the final hook output.
- **format-block state corruption:** pure function, no state.
- **hooks.json input hostility / encoding / resource:** static config, no runtime inputs.

## Log

- [2026-04-17T01:16:39Z] [Seth] Task scoped as walking skeleton for Phase 5.5b enrichment pipeline: PostToolUse on Read .py → direct Unix socket to shared Pyright → codeLens fetch/resolve → <file-intelligence> block. Direct-socket over MCP-stdio justified in Design. Open design question: exact hook output JSON shape for additionalContext injection — verify during implementation, STOP if not findable.
- [2026-04-17T01:56:00Z] [Seth] SRE review (fresh session): Verified all file references & claims. Key gaps filled: (1) symbol name population — documentSymbol query + position correlation, since codeLens doesn't return names; (2) fixture: use committed fixtures/sample.py, not untracked _demo_codelens.py; (3) test setup: reuse spawnProxy helper from proxy.test.ts; (4) fixed createSocketBridge reference proxy.ts:290 → proxy.ts:88; (5) added command.title regex spec; (6) flagged third-client concurrency + cold-cache codeLens timeout as Key Considerations. No design changes — all gap-fills. Open question (hook output JSON shape) stays open for implementation-time resolution.
- [2026-04-17T01:58:20Z] [Seth] Adversarial planning: Added failure catalog to Key Considerations covering request-ID collision on shared Pyright (structural proxy concern, mitigate via random ID offset in hook), inner-timeout must be < hook timeout (7s internal vs 10s outer), file content drift between Read and hook fire, special-char escaping in block output, 100-line output cap for large files, path normalization, concurrent hook invocations, and hooks.json merge (not overwrite). Added 4 new success criteria for escaping, cap, timeout-returns-empty, and SessionStart preservation.
- [2026-04-18T19:48:46Z] [Seth] Debrief: walking skeleton delivered (format-block + socket-lsp-client + enrich-file). All 12 success criteria met. Tests: 47 pyright-mcp (17 new — 9 format-block unit + 4 socket-lsp-client integration + 5 enrich-file integration + 3 adversarial for Unicode/negative-line/relative-path); 2392 pyright-internal; typecheck clean. End-to-end scripted verify confirms sample.py produces Greeter refs=3 impls=2 block; non-Python returns {}. Reflections: vscode-jsonrpc CancellationToken only sends $/cancelRequest to peer and does NOT reject local promise — had to force-close the socket in the timer handler to unblock hung sendRequest. Saved as reference memory. Claude Code PostToolUse hook schema verified against code.claude.com docs. Saved as reference memory. One SRE claim-error fixed during review: createSocketBridge is proxy.ts:88 (not :290 which is createMessageConnection). Committed 89afff6bc, pushed to origin/dev.
