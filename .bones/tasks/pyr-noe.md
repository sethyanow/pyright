---
id: pyr-noe
title: 'Phase 5.5b Task 1: PostToolUse hook scaffold + codeLens file-intelligence'
status: open
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

The hook is a transient process (spawned per Read). Speaking MCP means spawning `dist/proxy.js --mcp` as a child, doing the MCP handshake, calling the `lsp()` tool, parsing the response — heavy for a per-Read hook. Direct socket connection makes the hook another LSP client of the shared Pyright, reusing the multiplexing already in place (see `createSocketBridge` in proxy.ts). No new infrastructure, one less protocol layer.

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

Key assertions: returns non-empty array; each item has `line` (number), `symbol` (string); at least one item has `implementations` ≥ 1 (Animal in the fixture has Dog/Cat).

Run: `cd packages/pyright-mcp && npx jest socket-lsp-client --forceExit` — expect file-not-found failure.

### Step 4: Implement socket-lsp-client

File: `packages/pyright-mcp/src/hooks/socket-lsp-client.ts`

Export `fetchCodeLenses(socketPath: string, filePath: string): Promise<ResolvedLens[]>`. Uses `net.createConnection` + `vscode-jsonrpc` `StreamMessageReader`/`StreamMessageWriter` + `createMessageConnection` — same pattern as `proxy.ts:290`. Parses `command.title` strings to extract `references`/`implementations` counts.

Key decisions:
- workspace root for `initialize`: pass `process.cwd()` — hooks run from the editor's cwd
- `didOpen` content: read file from disk (the hook fires AFTER the Read, file is on disk)
- timeout: reuse the 30s pattern from `mcp-server.ts`
- connection teardown: explicit `connection.dispose()` + `socket.end()` after response

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
3. Read `_demo_codelens.py`
4. Confirm `<file-intelligence>` block appears in next turn's context referencing Animal/Dog/Cat with refs/impls counts
5. Read a non-Python file — confirm no block

### Step 10: Full verification

- `cd packages/pyright-mcp && npx jest --forceExit` — all tests pass (existing + new hook tests)
- `cd packages/pyright-internal && npm run test:norebuild` — all pass, no regressions
- `npm run typecheck` — clean

## Success Criteria

- [ ] `src/hooks/enrich-file.ts` created and bundles to `dist/hooks/enrich-file.js`
- [ ] `src/hooks/socket-lsp-client.ts` connects to shared Pyright via Unix socket and fetches resolved codeLens
- [ ] `src/hooks/format-block.ts` produces `<file-intelligence>` block with line-anchored refs/impls counts
- [ ] `hooks.json` registers PostToolUse on Read; hook runs only for `.py`/`.pyi` files
- [ ] Manual verification: Reading a Python file produces a visible `<file-intelligence>` block in agent context
- [ ] Unit tests for format-block and socket-lsp-client pass
- [ ] Integration test for enrich-file entry passes
- [ ] `cd packages/pyright-internal && npm run test:norebuild` — all pass
- [ ] `npm run typecheck` — clean

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

## Log

- [2026-04-17T01:16:39Z] [Seth] Task scoped as walking skeleton for Phase 5.5b enrichment pipeline: PostToolUse on Read .py → direct Unix socket to shared Pyright → codeLens fetch/resolve → <file-intelligence> block. Direct-socket over MCP-stdio justified in Design. Open design question: exact hook output JSON shape for additionalContext injection — verify during implementation, STOP if not findable.
