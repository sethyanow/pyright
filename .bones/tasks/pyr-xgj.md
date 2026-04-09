---
id: pyr-xgj
title: 'Make pyright-mcp self-contained: webpack bundle + co-located langserver'
status: open
type: task
priority: 1
parent: pyr-mge
---




## Context

Phase 3 acceptance shakedown found that pyright-mcp doesn't work from other codebases. The MCP server has two problems:
1. `langserverPath` defaults to `packages/pyright/dist/pyright-langserver.js` relative to cwd — only works from pyright repo root
2. MCP server is tsc output with node_modules deps — not a self-contained bundle like pyright and vscode-pyright

The langserver is already webpack-bundled by `npm run build:cli:dev` → `packages/pyright/dist/pyright-langserver.js`. The MCP server needs the same treatment, plus the langserver bundle needs to be co-located in pyright-mcp's dist so the whole thing is one directory.

## Requirements

1. Webpack bundle pyright-mcp into a self-contained JS file (follow `packages/pyright/webpack.config.js` pattern)
2. Build step copies `pyright-langserver.js` (+ its split chunks: `vendor.js`, `pyright-internal.js`) from `packages/pyright/dist/` into `packages/pyright-mcp/dist/`
3. MCP server resolves langserver via `path.join(__dirname, 'pyright-langserver.js')` — not cwd, not env var fallback
4. `PYRIGHT_LANGSERVER_PATH` env var override stays as escape hatch
5. pyright-mcp build depends on `build:cli:dev` (langserver must exist first)
6. typeshed-fallback must also be co-located (the langserver needs it at runtime)

## Implementation

### Files to create/modify
- `packages/pyright-mcp/webpack.config.js` — new, follow pyright's pattern (target: node, ts-loader, externals: fsevents)
- `packages/pyright-mcp/package.json` — add webpack/build scripts, devDeps (webpack, ts-loader, copy-webpack-plugin, esbuild-loader)
- `packages/pyright-mcp/src/mcp-server.ts` — fix langserver path resolution (lines 235-236)
- `packages/pyright-mcp/src/lsp-client.ts` — fix langserver path resolution (lines 133-134)
- `package.json` (root) — add `build:mcp:dev` script

### Webpack config specifics
- Entry: `mcp-server.ts` and `lsp-client.ts` (two entry points like pyright package)
- CopyPlugin: copies `packages/pyright/dist/pyright-langserver.js`, `vendor.js`, `pyright-internal.js`, and `typeshed-fallback/` into pyright-mcp dist
- No splitChunks needed — MCP server is small, single chunk is fine
- Target: node, same resolve/externals as pyright package

### Path resolution fix
```typescript
// mcp-server.ts — replace lines 235-236
const langserverPath = process.env.PYRIGHT_LANGSERVER_PATH
    || path.resolve(__dirname, 'pyright-langserver.js');
```

Same pattern in lsp-client.ts lines 133-134.

## Success Criteria

- [ ] `npm run build:mcp:dev` produces self-contained dist in `packages/pyright-mcp/dist/`
- [ ] dist contains: `mcp-server.js`, `lsp-client.js`, `pyright-langserver.js`, `vendor.js`, `pyright-internal.js`, `typeshed-fallback/`
- [ ] MCP server works when invoked from a directory outside the pyright repo (e.g., `cd /tmp && node /Volumes/code/pyright/packages/pyright-mcp/dist/mcp-server.js`)
- [ ] lsp-client CLI works from outside the pyright repo
- [ ] Existing MCP tests still pass
- [ ] `npm run typecheck` clean

## Anti-Patterns

- Don't duplicate the webpack shared lib — import from `build/lib/webpack` like the other packages
- Don't hardcode any absolute paths in source — only `__dirname`-relative and env var override
- Don't add pyright-internal as a dependency — the MCP server doesn't import it, it spawns the langserver as a child process
