---
id: pyr-g5x
title: Restructure pyright-mcp as standalone plugin with entrypoint script
status: open
type: task
priority: 1
owner: Seth
parent: pyr-lo0
---






## Context

The plugin currently uses the repo root as the plugin root. When installed, the entire pyright repo (~hundreds of MB) gets copied to the plugin cache. The plugin should be self-contained in `packages/pyright-mcp/` — the marketplace source points there, and only the MCP server + skills + hooks get cached.

The MCP server depends on the Pyright langserver (`packages/pyright/dist/`), which is a dev build artifact that changes frequently. Copying it into the plugin defeats the purpose — the MCP exposes the *live* dev build. An entrypoint script resolves the langserver path at runtime, separating "find Pyright" from "run the MCP bridge."

Also fixes: `${CLAUDE_PLUGIN_ROOT}` syntax (curly braces required for expansion in plugin.json args), and deprecated `server.tool()` → `registerTool()` API.

## Approach

Make `packages/pyright-mcp/` the plugin root. Move plugin components (`.claude-plugin/`, `skills/`, `hooks/`) into it. Add a `bin/start-server.sh` entrypoint that resolves the langserver path, then execs the Node MCP server. Update marketplace source to `"./packages/pyright-mcp"`. Clean up old locations at repo root.

## Implementation Steps

1. **Create `packages/pyright-mcp/bin/start-server.sh`** — entrypoint script
   - Check `PYRIGHT_LANGSERVER_PATH` env var (explicit override)
   - Fall back to CWD-relative `packages/pyright/dist/pyright-langserver.js` (repo dev case)
   - Fail with clear message if neither found
   - `export PYRIGHT_LANGSERVER_PATH` then `exec node "${SCRIPT_DIR}/../dist/mcp-server.js"`
   - Must be executable (`chmod +x`)

2. **Move plugin components into `packages/pyright-mcp/`**
   - `packages/pyright-mcp/.claude-plugin/plugin.json` — new location
   - `packages/pyright-mcp/skills/pyright/SKILL.md` — move from repo root `skills/`
   - `packages/pyright-mcp/hooks/hooks.json` + `hooks/scripts/check-build.sh` — move from repo root `hooks/`

3. **Update `packages/pyright-mcp/.claude-plugin/plugin.json`**
   - Command: `"${CLAUDE_PLUGIN_ROOT}/bin/start-server.sh"` (entrypoint, not node directly)
   - No `args` needed — the script handles everything
   - Remove old `node` + `$CLAUDE_PLUGIN_ROOT` args pattern

4. **Update `.claude-plugin/marketplace.json`** (stays at repo root)
   - `"source": "./packages/pyright-mcp"` instead of `"./"`

5. **Simplify MCP server langserver resolution** (`src/mcp-server.ts`)
   - Read `PYRIGHT_LANGSERVER_PATH` from env — entrypoint always sets it
   - Remove `CLAUDE_PLUGIN_ROOT` fallback logic (no longer relevant)
   - Keep `process.cwd()` for workspace root (unchanged)

6. **Fix `lsp-client.ts` langserver resolution** (line 113)
   - Same broken `CLAUDE_PLUGIN_ROOT` fallback as mcp-server.ts
   - Read `PYRIGHT_LANGSERVER_PATH` from env, fall back to CWD-relative
   - lsp-client is a standalone CLI (not spawned by plugin system), so it needs its own resolution — no entrypoint script wrapping it

7. **Update SKILL.md paths** for new plugin root
   - Old: `$CLAUDE_PLUGIN_ROOT/packages/pyright-mcp/dist/lsp-client.js`
   - New: `${CLAUDE_PLUGIN_ROOT}/dist/lsp-client.js` (plugin root IS pyright-mcp now)
   - Fix all path references in the skill

8. **Update hooks paths** — `check-build.sh` resolves relative to `${CLAUDE_PLUGIN_ROOT}` which is now the pyright-mcp directory, not repo root. The script should check CWD-relative langserver path (same logic as entrypoint). Also check that MCP server dist exists (not just langserver).

9. **Clean up old locations** — remove `.claude-plugin/plugin.json`, `skills/`, `hooks/` from repo root (marketplace.json stays)

8. **Rebuild** — `cd packages/pyright-mcp && npm run build`

9. **Reinstall plugin** — user reinstalls, verify `/mcp` shows the pyright server

## Success Criteria

- [ ] `packages/pyright-mcp/` is self-contained plugin root (`.claude-plugin/`, `skills/`, `hooks/`, `bin/`, `dist/`, `node_modules/`)
- [ ] Marketplace source points to `"./packages/pyright-mcp"` — only that directory gets cached
- [ ] Entrypoint script resolves langserver: env var → CWD-relative → clear error
- [ ] MCP server starts and responds when run from the pyright repo (CWD fallback)
- [ ] MCP server starts when `PYRIGHT_LANGSERVER_PATH` is set explicitly
- [ ] Entrypoint fails with helpful message when langserver not found
- [ ] `registerTool()` API used (not deprecated `server.tool()`)
- [ ] `${CLAUDE_PLUGIN_ROOT}` syntax (curly braces) in all plugin config
- [ ] Old plugin files removed from repo root (`.claude-plugin/plugin.json`, `skills/`, `hooks/`)
- [ ] Smoke tests pass: `cd packages/pyright-mcp && npm test`
- [ ] Plugin installs and `/mcp` shows pyright server with `lsp` tool

## Anti-Patterns

- **Don't copy the langserver into the plugin** — it's a dev build that changes frequently. The entrypoint resolves it at runtime.
- **Don't hardcode paths** — use env var + CWD-relative fallback for portability across machines.
- **Don't use `$VAR` without curly braces in plugin.json** — Claude Code only expands `${VAR}` syntax.
- **Don't write to stdout in the entrypoint script** — stdout is the MCP protocol channel. All messages (errors, warnings) go to stderr. One stray `echo` corrupts the transport.

## Edge Cases

- CWD is not the pyright repo (e.g., user runs Claude Code in a Python project): entrypoint won't find CWD-relative langserver. User must set `PYRIGHT_LANGSERVER_PATH`. Entrypoint prints clear instructions.
- Langserver not built yet: entrypoint fails with "run `npm run build:cli:dev` first" message.
- Plugin cache is stale after MCP server code changes: user must reinstall. The langserver is NOT affected (resolved at runtime).
- MCP server dist not built: same as langserver — entrypoint script would fail to exec Node on a missing file. Hook should check both artifacts.
- Windows: entrypoint is bash-only. Matches plugin-dev examples but won't work on Windows without WSL.

## Key Considerations

- marketplace.json stays at repo root — it's the registry, not part of the plugin
- The entrypoint script must use `exec` to replace the shell process with Node (stdio MCP transport needs clean stdin/stdout)
- `check-build.sh` hook and entrypoint have overlapping concerns — hook warns at session start, entrypoint errors at MCP spawn. Both are useful (early warning vs. hard gate).
