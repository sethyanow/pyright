---
id: pyr-anf
title: Build Node.js proxy entry point with shared Pyright backend
status: active
type: task
priority: 1
parent: pyr-084
---


## Context

Replace `bin/start-server.sh` (shell script) with a Node.js proxy that spawns Pyright and serves both LSP and MCP protocol modes. The proxy owns the Pyright child process via Unix socket + PID file. `--lsp` flag does LSP JSON-RPC passthrough, `--mcp` flag runs the existing MCP server. Any disconnect tears down Pyright.

**Blocked by:** pyr-yh8 (Phase 5 must close first)
**Unlocks:** Plugin LSP config task (enables diagnostics from dev build), then Phase 5.5b enrichment hooks

## Requirements

- Node.js entry point at `src/proxy.ts` (replaces shell script)
- Accepts `--lsp` or `--mcp` CLI flag
- Spawns Pyright langserver as child process, pipes to Unix socket
- PID file at `${CLAUDE_PLUGIN_DATA}/pyright.pid`, socket at `${CLAUDE_PLUGIN_DATA}/pyright.sock`
- First connection spawns Pyright if not running (check PID file, verify process alive)
- `--lsp` mode: bidirectional JSON-RPC relay between stdin/stdout and the Unix socket
- `--mcp` mode: run existing `createMcpServer()` but connect its LSP MessageConnection to the Unix socket instead of spawning its own Pyright
- On SIGTERM, SIGINT, stdin close, or MCP disconnect: kill Pyright child, remove PID + socket files

## Design

```
proxy --lsp:
  stdin/stdout ←→ [JSON-RPC relay] ←→ Unix socket ←→ Pyright

proxy --mcp:
  stdin/stdout ←→ [MCP server] ←→ Unix socket ←→ Pyright
                                    (reuses existing createMcpServer, but
                                     MessageConnection comes from socket
                                     instead of child_process stdio)
```

### Key decisions

- **Refactor `createMcpServer` to accept a `MessageConnection` parameter** instead of spawning Pyright internally. The proxy creates the connection (from Unix socket), passes it in. This is the minimal seam — `createMcpServer` loses its spawn logic, gains a parameter.
- **`resolve-langserver-path.ts` stays unchanged** — the proxy imports it to find the langserver binary.
- **Webpack entry point**: add `proxy` alongside `mcp-server` and `lsp-client` in webpack.config.js so it bundles to `dist/proxy.js`.

## Implementation

### Step 1: Write integration test for proxy lifecycle (--lsp mode)
- Test file: `src/tests/proxy.test.ts`
- Test intent: spawn proxy in `--lsp` mode, send LSP `initialize`, verify response, kill proxy, verify Pyright PID is gone
- Uses `child_process.spawn` to launch the proxy (`node dist/proxy.js --lsp`), `vscode-jsonrpc` to speak LSP over stdio
- Key assertions: initialize response has capabilities, PID file exists during connection, PID file gone after disconnect
- Note: test needs `dist/proxy.js` — won't pass until Steps 3-5 complete. Write test first per TDD; it fails with file-not-found or similar
- Test must use `PYRIGHT_PROXY_STATE_DIR` env var pointing to a temp dir (jest tests don't have `${CLAUDE_PLUGIN_DATA}`)

### Step 2: Write integration test for MCP mode through proxy
- Same test file
- Test intent: spawn proxy in `--mcp` mode, verify MCP tool call works (e.g., `lsp` tool with `textDocument/hover`)
- Key assertion: MCP response contains valid LSP data
- Same temp-dir pattern for PID/socket paths

### Step 2b: Write integration test for shared Pyright (R2)
- Same test file
- Test intent: spawn proxy `--lsp`, read PID file, spawn proxy `--mcp`, read PID file, verify SAME PID
- Then kill one proxy, verify PID file is gone and Pyright process is dead
- This is the core test for R2 (shared backend + teardown on any disconnect)

### Step 3: Extract Pyright spawn from createMcpServer
- File: `src/mcp-server.ts`
- Refactor `createMcpServer(langserverPath, workspaceRoot)` → `createMcpServer(lspConnection, workspaceRoot)`
- The `startPyright()` function and `pyrightProcess` management move out to the proxy
- **Remove** the `require.main === module` block (lines 268-279) — proxy replaces direct execution
- **Remove** `shutdown()` from the return value — lifecycle owned by proxy. Return `{ server }` only.
- All MCP tool handlers stay unchanged — they already use `lspConnection`
- `initPromise` logic changes: no longer calls `startPyright()` internally. The passed-in `lspConnection` is already initialized. Remove `initPromise`/`initError`; gate on the connection being non-null instead.
- Move spawn-related imports (`spawn`, `ChildProcess`) out; keep `MessageConnection` import

### Step 3b: Update existing tests for new createMcpServer signature
- File: `src/tests/mcp-server.test.ts`
- Current `beforeAll` (line 18) calls `createMcpServer(LANGSERVER_PATH, FIXTURES_DIR)` — breaks with new signature
- Update: test spawns Pyright itself using same pattern that was in `startPyright()`, creates `MessageConnection` from process stdio, runs LSP initialize handshake, then passes connection to `createMcpServer(connection, FIXTURES_DIR)`
- `afterAll` must kill the Pyright child process (previously handled by `mcpServer.shutdown()`)
- All tool-call test assertions remain unchanged — they test MCP behavior, not spawn logic
- Verify all existing tests still pass after the refactor

### Step 4: Implement proxy entry point
- New file: `src/proxy.ts`
- Parse `--lsp` / `--mcp` flag from `process.argv`
- **Pyright lifecycle**: spawn Pyright with `--stdio` via `resolveLangserverPath()`, write PID file, create Unix socket server bridging to Pyright's stdio
- **Socket path**: default `${CLAUDE_PLUGIN_DATA}/pyright.sock`, override via `PYRIGHT_PROXY_STATE_DIR` env var for tests. Validate length < 104 chars (macOS limit)
- **Stale PID handling**: on startup, if PID file exists but process is dead (`kill(pid, 0)` throws), remove stale PID + socket and spawn fresh
- **Race condition**: use atomic PID file write (write to temp, rename with `O_EXCL` semantics) to prevent two proxies from spawning simultaneously
- **JSON-RPC multiplexer**: the proxy that spawns Pyright runs a Unix socket server. Each socket client is tracked. The multiplexer must:
  - Rewrite outgoing request IDs to prevent collisions (e.g., prefix `c1:`, `c2:`)
  - Route responses back to the originating client by reverse-mapping rewritten IDs
  - Broadcast notifications from Pyright to all connected clients
  - Remove client on disconnect; if ANY client disconnects → teardown
- **`--lsp` path**: connect to Unix socket (spawn Pyright + start socket server if not running), relay own stdin/stdout ↔ socket
- **`--mcp` path**: connect to Unix socket (spawn if needed), create `MessageConnection` from socket, run LSP `initialize` handshake, pass connection to `createMcpServer(connection, workspaceRoot)`, connect MCP `StdioServerTransport` to own stdin/stdout
- **Signal handlers**: SIGTERM, SIGINT, stdin `end` → kill Pyright child, remove PID + socket files

### Step 5: Add proxy to webpack config
- File: `webpack.config.js`
- Add `proxy: './src/proxy.ts'` to entry points
- Verify `npm run webpack` produces `dist/proxy.js`

### Step 6: Update plugin.json with LSP config + update bin script
- File: `.claude-plugin/plugin.json`
- Add `lspServers` section (per Claude Code docs, `command` + `extensionToLanguage` required):
  ```json
  "lspServers": {
      "pyright-dev": {
          "command": "${CLAUDE_PLUGIN_ROOT}/bin/start-server.sh",
          "args": ["--lsp"],
          "extensionToLanguage": { ".py": "python", ".pyi": "python" }
      }
  }
  ```
- Update `mcpServers` to pass `--mcp` flag:
  ```json
  "mcpServers": {
      "pyright": {
          "command": "${CLAUDE_PLUGIN_ROOT}/bin/start-server.sh",
          "args": ["--mcp"]
      }
  }
  ```
- Replace `bin/start-server.sh` with minimal shim: `exec node "$(dirname "$0")/../dist/proxy.js" "$@"`
  (Path resolution moves to proxy.ts via `resolveLangserverPath()`)

### Step 7: Verify full test suite + typecheck
- `cd packages/pyright-mcp && npm test` — proxy + MCP tests pass
- `cd packages/pyright-internal && npm run test:norebuild` — all pass (no regressions)
- `npm run typecheck` — clean
- Manual verification: restart Claude Code, confirm diagnostics flow, confirm MCP tools work

## Success Criteria

- [ ] `src/proxy.ts` exists and bundles to `dist/proxy.js`
- [ ] `--lsp` mode: LSP initialize/shutdown handshake works
- [ ] `--mcp` mode: MCP lsp() tool returns valid data
- [ ] Both modes share one Pyright PID (verified by reading PID file from both)
- [ ] PID file created on spawn, removed on disconnect
- [ ] Pyright child process killed on any disconnect (verified by PID check)
- [ ] `createMcpServer` accepts external `MessageConnection` (no internal spawn)
- [ ] Existing mcp-server tests pass with refactored signature
- [ ] Integration tests pass for both modes + shared PID test
- [ ] Plugin `lspServers` config present in plugin.json with correct format
- [ ] `npm run typecheck` clean

## Key Considerations

- **JSON-RPC multiplexing is the core technical challenge.** Two clients sharing one Pyright stdio requires ID rewriting and response routing. `vscode-jsonrpc` auto-increments IDs from 0, so two clients without rewriting will collide. The multiplexer sits in the socket server. Must handle both string and number IDs (JSON-RPC spec allows both) — prefix scheme works for both: `"c1:42"` or `"c1:original-string-id"`.
- **Existing tests break on signature change.** `mcp-server.test.ts` calls the old `createMcpServer(langserverPath, workspaceRoot)` signature. Must update tests to spawn Pyright themselves and pass `MessageConnection`.
- **`${CLAUDE_PLUGIN_DATA}` unavailable in tests.** PID/socket paths need a `PYRIGHT_PROXY_STATE_DIR` env var override so jest tests can use a temp dir.
- **macOS Unix socket path limit is 104 chars.** `${CLAUDE_PLUGIN_DATA}` resolves to `~/.claude/plugins/data/{id}/` which can be long. Validate at startup; consider `/tmp/pyright-proxy-<hash>.sock` as fallback.

### Failure Catalog

**PID file ordering (Temporal Betrayal)**
- Assumption: PID file reliably indicates a live, reachable Pyright + socket
- Betrayal: PID written before socket is ready → second proxy gets ECONNREFUSED. Or PID recycled after OOM → `kill(pid, 0)` says alive but it's not Pyright.
- Mitigation: Creation order: spawn Pyright → start socket server → write PID file (LAST). Stale detection: check PID alive AND socket accepts connection — not PID alone. On startup, if socket exists but no PID file → delete orphaned socket.

**PID + socket asymmetric cleanup (State Corruption)**
- Assumption: PID file and socket file always created/deleted together
- Betrayal: Crash after PID write but before socket creation. Or socket lingers after PID file deleted.
- Mitigation: Deletion order: PID file FIRST → close socket → kill Pyright. Use `fs.unlinkSync` in `process.on('exit')` handler as last-resort synchronous cleanup.

**Orphaned request mappings (Temporal Betrayal)**
- Assumption: Every multiplexer ID mapping gets cleaned up
- Betrayal: Client disconnects while its requests are pending in Pyright. Responses arrive for dead client, map entries linger.
- Mitigation: On client disconnect, purge ALL pending ID mappings for that client. Client-prefixed IDs prevent cross-client collisions even with stale entries.

**Double-signal during teardown (Temporal Betrayal)**
- Assumption: Cleanup runs exactly once to completion
- Betrayal: SIGINT during async cleanup → re-entrant corruption (partial file deletion, Pyright not killed)
- Mitigation: Set `cleaningUp` boolean on first signal; ignore subsequent signals. `process.on('exit')` does synchronous file unlinks as final safety net.

**LSP initialize ordering for --mcp path (Temporal Betrayal)**
- Assumption: Connection passed to createMcpServer is initialized
- Betrayal: Proxy passes connection before initialize handshake completes. MCP tool call arrives, hits uninitialized Pyright.
- Mitigation: Proxy MUST `await` LSP initialize on the connection BEFORE passing to createMcpServer. Refactored createMcpServer receives an already-initialized connection — no internal init gating needed.

## Anti-Patterns

- **Don't keep `createMcpServer` spawning its own Pyright as a fallback.** One spawn path (the proxy), not two. REASON: dual spawn paths mean dual lifecycle bugs.
- **Don't use HTTP or TCP for the socket.** Unix domain socket only — no network exposure. REASON: dev tooling, localhost only, no security surface.
