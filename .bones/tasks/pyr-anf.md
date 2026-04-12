---
id: pyr-anf
title: Build Node.js proxy entry point with shared Pyright backend
status: open
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

### Step 1: Write integration test for proxy lifecycle
- Test file: `src/tests/proxy.test.ts`
- Test intent: spawn proxy in `--lsp` mode, send LSP `initialize`, verify response, kill proxy, verify Pyright PID is gone
- Uses `child_process.spawn` to launch the proxy, `vscode-jsonrpc` to speak LSP over stdio
- Key assertions: initialize response has capabilities, PID file exists during connection, PID file gone after disconnect

### Step 2: Write integration test for MCP mode through proxy
- Same test file
- Test intent: spawn proxy in `--mcp` mode, verify MCP tool call works (e.g., `lsp` tool with `textDocument/hover`)
- Key assertion: MCP response contains valid LSP data

### Step 3: Extract Pyright spawn from createMcpServer
- File: `src/mcp-server.ts`
- Refactor `createMcpServer(langserverPath, workspaceRoot)` to `createMcpServer(lspConnection, workspaceRoot)`
- The `startPyright()` function and `pyrightProcess` management move out to the proxy
- All MCP tool handlers stay unchanged — they already use `lspConnection`

### Step 4: Implement proxy entry point
- New file: `src/proxy.ts`
- Parse `--lsp` / `--mcp` flag from `process.argv`
- Pyright spawn + PID file + Unix socket management
- `--lsp` path: relay stdin/stdout ↔ socket (bidirectional JSON-RPC pipe)
- `--mcp` path: create `MessageConnection` from socket, pass to `createMcpServer`, connect MCP transport to stdin/stdout
- Signal handlers: SIGTERM, SIGINT, stdin `end` → kill Pyright, cleanup PID + socket

### Step 5: Add proxy to webpack config
- File: `webpack.config.js`
- Add `proxy: './src/proxy.ts'` to entry points
- Verify `npm run webpack` produces `dist/proxy.js`

### Step 6: Update plugin.json with LSP config + update bin script
- File: `.claude-plugin/plugin.json`
- Add `lspServers` section pointing to `${CLAUDE_PLUGIN_ROOT}/bin/start-server.sh --lsp`
- Update `bin/start-server.sh` to delegate to `node dist/proxy.js` with the flag
- Or replace `bin/start-server.sh` entirely with a minimal shim: `exec node "$(dirname "$0")/../dist/proxy.js" "$@"`

### Step 7: Verify full test suite + typecheck
- `cd packages/pyright-internal && npm run test:norebuild` — all pass
- `npm run typecheck` — clean
- Manual verification: restart Claude Code, confirm diagnostics flow, confirm MCP tools work

## Success Criteria

- [ ] `src/proxy.ts` exists and bundles to `dist/proxy.js`
- [ ] `--lsp` mode: LSP initialize/shutdown handshake works
- [ ] `--mcp` mode: MCP lsp() tool returns valid data
- [ ] PID file created on spawn, removed on disconnect
- [ ] Pyright child process killed on any disconnect (verified by PID check)
- [ ] `createMcpServer` accepts external `MessageConnection` (no internal spawn)
- [ ] Integration tests pass for both modes
- [ ] `npm run typecheck` clean

## Anti-Patterns

- **Don't keep `createMcpServer` spawning its own Pyright as a fallback.** One spawn path (the proxy), not two. REASON: dual spawn paths mean dual lifecycle bugs.
- **Don't use HTTP or TCP for the socket.** Unix domain socket only — no network exposure. REASON: dev tooling, localhost only, no security surface.
