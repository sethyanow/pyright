---
id: pyr-o4h
title: Set up pyright-mcp plugin with LSP adapter
status: open
type: task
priority: 1
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
│   └── plugin.json                       # Plugin manifest
├── .mcp.json                             # MCP server registration (stdio)
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

### .mcp.json
```json
{
  "pyright": {
    "command": "node",
    "args": ["$CLAUDE_PLUGIN_ROOT/packages/pyright-mcp/dist/mcp-server.js"]
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
1. Scaffold plugin files at repo root — `.claude-plugin/plugin.json`, `.mcp.json`, `hooks/hooks.json`
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
- [ ] Integration smoke test passes

## Key Considerations

- Repo root is the plugin root: `$CLAUDE_PLUGIN_ROOT` resolves to `/Volumes/code/pyright/`, giving stable paths to the dev-built langserver and MCP server
- CWD as workspace root: Pyright initializes with the CWD where the MCP server runs. Pyright scans and analyzes Python files from workspace root on `initialize` — no `didOpen` needed for workspace files
- Single `lsp()` tool: no per-method MCP tool definitions to maintain. New LSP providers from future phases automatically work through it
- `$CLAUDE_PLUGIN_ROOT` for all intra-plugin path references — portable
- Build tools: npm (per repo convention), `vscode-jsonrpc` for LSP framing, `@modelcontextprotocol/sdk` for MCP protocol
- Requires `npm run build:cli:dev` before MCP server can spawn Pyright
