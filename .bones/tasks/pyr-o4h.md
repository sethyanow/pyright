---
id: pyr-o4h
title: Set up pyright-mcp plugin with LSP adapter
status: active
type: task
priority: 1
owner: Seth
parent: pyr-lo0
---





## Context

Phase 1 needs a way for agents to use the new Pyright capabilities (goToImplementation, workspaceSymbol). The adapter layer is a Claude Code plugin rooted at the repo root, with an MCP server in `packages/pyright-mcp/` that wraps Pyright's LSP.

The MCP server spawns the dev-built `pyright-langserver --stdio` (via `$CLAUDE_PLUGIN_ROOT/packages/pyright/dist/pyright-langserver.js`), runs the LSP handshake with CWD as workspace root, and exposes a single `lsp()` tool. Any LSP method + params in, response out. Zero business logic — protocol bridge only.

A skill + wrapper scripts provide the same capabilities for agents that don't speak MCP.

## Approach

### Plugin Structure (repo root = plugin root)
```
pyright/                                  ← repo root = $CLAUDE_PLUGIN_ROOT
├── .claude-plugin/
│   └── plugin.json                       # Plugin manifest (includes mcpServers inline)
├── skills/
│   └── pyright/
│       ├── SKILL.md                      # Skill description + usage
│       └── scripts/                      # Wrapper scripts for non-MCP agents
├── hooks/
│   └── hooks.json                        # Session start: verify dev build exists
├── packages/
│   ├── pyright-mcp/                      # MCP server package
│   │   ├── src/
│   │   │   └── mcp-server.ts             # MCP server: LSP client bridge
│   │   └── package.json                  # Dependencies
│   ├── pyright/                          # CLI (existing)
│   ├── pyright-internal/                 # Core (existing)
│   └── vscode-pyright/                   # VS Code extension (existing)
└── ...
```

### MCP Server (`packages/pyright-mcp/src/mcp-server.ts`)
- Spawns dev-built Pyright: `node $CLAUDE_PLUGIN_ROOT/packages/pyright/dist/pyright-langserver.js --stdio`
- LSP client using `vscode-jsonrpc` — handles Content-Length framing, JSON-RPC over stdio
- Runs `initialize` with CWD as `rootUri`, advertises client capabilities
- Exposes single MCP tool: `lsp(method: string, params: object)` → JSON-RPC → response
- Shuts down Pyright on MCP server shutdown

### MCP Registration (inline in plugin.json)
The existing `.mcp.json` at repo root contains project dev tools (ChunkHound, Serena, wallaby). Plugin MCP config goes inline in `plugin.json` to keep concerns separate:
```json
{
  "name": "pyright",
  "mcpServers": {
    "pyright": {
      "command": "node",
      "args": ["$CLAUDE_PLUGIN_ROOT/packages/pyright-mcp/dist/mcp-server.js"]
    }
  }
}
```

### Skill (`skills/pyright/SKILL.md`)
- Describes available LSP capabilities (goToImplementation, workspaceSymbol, etc.)
- References wrapper scripts in `scripts/` for non-MCP agents
- Updates each phase as new providers land

### Hook (`hooks/hooks.json`)
- SessionStart: check that `packages/pyright/dist/pyright-langserver.js` exists, warn if not built

### Testing
- Fourslash tests prove Pyright providers work internally
- Integration smoke test: call `lsp("textDocument/implementation", ...)` through the MCP against a real Python file, verify results
- Test `lsp("workspace/symbol", {query: ""})` returns symbols

## Implementation Steps

0. Build Pyright CLI: `npm run build:cli:dev` (prerequisite)
1. Scaffold plugin files at repo root — `.claude-plugin/plugin.json` (with inline mcpServers), `hooks/hooks.json`
2. Scaffold `packages/pyright-mcp/` — `package.json`, `tsconfig.json`, directory structure
3. Implement MCP server — spawn Pyright, LSP handshake, `lsp()` tool
4. Write integration smoke test — goToImplementation + workspaceSymbol through MCP
5. Create skill + wrapper scripts at `skills/pyright/`
6. Create session start hook — verify dev build
7. Install plugin locally, verify via `/mcp`

## Success Criteria

- [ ] MCP server starts, spawns Pyright, completes LSP initialize handshake
- [ ] `lsp("textDocument/implementation", ...)` returns implementations through MCP
- [ ] `lsp("workspace/symbol", {query: ""})` returns symbols through MCP
- [ ] Plugin installs in Claude Code — `/mcp` shows pyright server, tools available
- [ ] Skill describes capabilities with wrapper scripts for non-MCP agents
- [ ] Session start hook warns if dev build missing
- [ ] `lsp()` calls gate on init promise — call before init completes returns after init, not error
- [ ] Integration smoke test passes

## Anti-Patterns (FORBIDDEN)

- **Don't put plugin MCP config in the project `.mcp.json`** — it already has ChunkHound/Serena/wallaby for development. Plugin config goes inline in `plugin.json`. REASON: mixing concerns means installing the plugin also registers dev tools for end users.
- **Don't add business logic to the MCP server** — it translates MCP→LSP and back, nothing more. REASON: intelligence lives in Pyright's providers.
- **Don't swallow LSP errors** — surface them as MCP tool errors with the original message. REASON: agents need error context to adapt.

## Edge Cases

- **Pyright not built**: MCP server must detect missing `dist/pyright-langserver.js` and return a clear error on `lsp()` calls (not crash silently). The SessionStart hook also warns, but the server must be independently robust.
- **CWD has no Python files**: Pyright initializes fine with an empty workspace — `workspace/symbol` returns empty, `textDocument/*` methods return empty/null for nonexistent files. No special handling needed.
- **Unsupported LSP method**: Pyright returns a standard JSON-RPC MethodNotFound error (-32601). MCP server passes it through as a tool error.
- **Concurrent `lsp()` calls**: LSP JSON-RPC uses request IDs — `vscode-jsonrpc` handles multiplexing. Concurrent calls are safe.
- **Pyright process crashes mid-session**: MCP server should detect the closed pipe and return an error. No automatic restart — agent retries or user rebuilds.

## Failure Catalog

**Temporal Betrayal: Pyright initialization race**
- Assumption: LSP `initialize` completes before first `lsp()` call
- Betrayal: First `lsp()` arrives before handshake finishes
- Consequence: `sendRequest` fails or hangs — connection not ready
- Mitigation: Gate `lsp()` behind an init promise. Server constructor starts Pyright + runs `initialize`; handler awaits init promise before forwarding. Single async gate, not polling.

**Temporal Betrayal: Pyright background analysis**
- Assumption: After `initialize`, workspace is analyzed and queries return results
- Betrayal: Pyright needs time to analyze. First `workspace/symbol` returns empty because analysis hasn't finished.
- Consequence: Agent sees no symbols, concludes feature is broken
- Mitigation: Inherent to LSP. Document in the skill that first queries after init may return partial results. Smoke test should target a small file or wait for `$/progress` completion.

**Input Hostility: notification vs request methods**
- Assumption: Agent sends LSP request methods (expect responses)
- Betrayal: Agent sends a notification method (e.g., `textDocument/didOpen`) — no response generated
- Consequence: `sendRequest` hangs waiting for a response that never comes
- Mitigation: Add a timeout (30s) to every `sendRequest` call. Notifications become timeout errors with a clear message. Document request-only limitation in skill.

**Dependency Treachery: Pyright process spawn**
- Assumption: `node dist/pyright-langserver.js` starts successfully
- Betrayal: Node not on PATH, `dist/` stale, or Pyright crashes during init
- Consequence: No LSP connection, all `lsp()` calls fail
- Mitigation: Listen for `error` and `close` events on child process. If Pyright fails to start, `lsp()` returns: "Pyright langserver failed to start: [reason]". SessionStart hook catches missing-build case early.

**Resource Exhaustion: workspace/symbol on large codebase**
- Assumption: Results are manageable size
- Betrayal: Large monorepo with 50k+ symbols, no cap in Pyright (verified: `reportSymbols()` returns all `_allSymbols` with no limit)
- Consequence: MCP response may exceed tool output limits, truncated data
- Mitigation: Acceptable for now — matches vtsls behavior. If needed later, add optional `limit` param to `lsp()` tool for client-side truncation. Not a Phase 1 blocker.

**State Corruption: stale workspace after CWD change**
- Assumption: Each MCP server instance serves one workspace
- Betrayal: Claude Code reuses MCP process when user changes directories
- Consequence: Pyright queries files outside its workspace root, returns empty/wrong results
- Mitigation: Stdio MCP transport — Claude Code restarts process on lifecycle events. Workspace is scoped to spawn-time CWD. Document that server is workspace-scoped.

## Key Considerations

- Repo root is the plugin root: `$CLAUDE_PLUGIN_ROOT` resolves to `/Volumes/code/pyright/`, giving stable paths to the dev-built langserver and MCP server
- CWD as workspace root: Pyright initializes with the CWD where the MCP server runs. Pyright scans and analyzes Python files from workspace root on `initialize` — no `didOpen` needed for workspace files
- Single `lsp()` tool: no per-method MCP tool definitions to maintain. New LSP providers from future phases automatically work through it
- `$CLAUDE_PLUGIN_ROOT` for all intra-plugin path references — portable
- `vscode-jsonrpc@^9.0.0-next.8` already in pyright-internal and vscode-pyright — add as dependency in pyright-mcp's `package.json`, npm hoisting resolves it
- `@modelcontextprotocol/sdk` for MCP protocol — new dependency for pyright-mcp
- MCP server build: `packages/pyright-mcp/` needs its own `tsconfig.json` (target ES2020, module NodeNext) and a build script (`tsc` to `dist/`) — no webpack needed for a simple server
- Requires `npm run build:cli:dev` before MCP server can spawn Pyright
- Smoke test lives at `packages/pyright-mcp/src/tests/mcp-server.test.ts` — uses Jest (consistent with pyright-internal), spawns the MCP server as a subprocess and sends tool calls
