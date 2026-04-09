---
id: pyr-xgj
title: 'Make pyright-mcp self-contained: webpack bundle + co-located langserver'
status: closed
type: task
priority: 1
owner: Seth
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
- `packages/pyright-mcp/package.json` — add webpack/build scripts, devDeps (webpack, webpack-cli, ts-loader, copy-webpack-plugin, esbuild-loader)
- `packages/pyright-mcp/src/mcp-server.ts` — fix langserver path resolution (lines 235-236)
- `packages/pyright-mcp/src/lsp-client.ts` — fix langserver path resolution (lines 133-134)
- `package.json` (root) — add `build:mcp:dev` script

### Webpack config specifics
- Entry: `{ 'mcp-server': './src/mcp-server.ts', 'lsp-client': './src/lsp-client.ts' }` (two entry points like pyright package)
- Import shared config: `require('../../build/lib/webpack')` for `cacheConfig`, `monorepoResourceNameMapper`, `tsconfigResolveAliases`
- CopyPlugin: copies `packages/pyright/dist/pyright-langserver.js`, `vendor.js`, `pyright-internal.js`, and `typeshed-fallback/` into pyright-mcp dist
- No splitChunks needed — MCP server is small, single chunk is fine
- Target: node, same resolve/externals as pyright package

### Root build script
- `build:mcp:dev` in root `package.json`: must run `build:cli:dev` first (langserver must exist for CopyPlugin), then `cd packages/pyright-mcp && npm run webpack`
- Pattern: `"build:mcp:dev": "npm run build:cli:dev && cd packages/pyright-mcp && npm run webpack"`

### Path resolution fix
```typescript
// mcp-server.ts — replace lines 235-236
const langserverPath = process.env.PYRIGHT_LANGSERVER_PATH
    || path.resolve(__dirname, 'pyright-langserver.js');
```

Same pattern in lsp-client.ts lines 133-134.

## Success Criteria

- [x] `npm run build:mcp:dev` produces self-contained dist in `packages/pyright-mcp/dist/`
- [x] dist contains: `mcp-server.js`, `lsp-client.js`, `pyright-langserver.js`, `vendor.js`, `pyright-internal.js`, `typeshed-fallback/`
- [x] MCP server works when invoked from a directory outside the pyright repo (e.g., `cd /tmp && node /Volumes/code/pyright/packages/pyright-mcp/dist/mcp-server.js`)
- [x] lsp-client CLI works from outside the pyright repo
- [x] `PYRIGHT_LANGSERVER_PATH` env var override works (e.g., `PYRIGHT_LANGSERVER_PATH=/Volumes/code/pyright/packages/pyright/dist/pyright-langserver.js node packages/pyright-mcp/dist/mcp-server.js`)
- [x] Existing MCP tests still pass
- [x] `npm run typecheck` clean

## Key Considerations (Failure Catalog)

**Dependency Treachery: CopyPlugin source paths**
- Assumption: pyright's webpack output produces `pyright-langserver.js`, `vendor.js`, `pyright-internal.js` with exactly those names
- Betrayal: pyright's webpack config changes chunk names (e.g., hash suffixes, renamed cache groups)
- Consequence: CopyPlugin throws at build time if source doesn't exist — loud failure, not silent
- Mitigation: Structural — CopyPlugin fails the build if source paths are wrong. Success criterion 2 verifies expected files exist in dist.

**Temporal Betrayal: Direct webpack invocation without CLI build**
- Assumption: `build:cli:dev` ran first, populating `packages/pyright/dist/`
- Betrayal: Developer runs `cd packages/pyright-mcp && npm run webpack` directly
- Consequence: CopyPlugin fails — source files don't exist
- Mitigation: Root `build:mcp:dev` enforces order via `&&`. Package-level `webpack` script has no guard — acceptable since this is a dev-only build step, not user-facing.

**Input Hostility: `__dirname` in webpack bundle**
- Assumption: `__dirname` in the webpack output resolves to the runtime output directory (`dist/`)
- Betrayal: Webpack mocks `__dirname` to source directory or `/`
- Consequence: `path.resolve(__dirname, 'pyright-langserver.js')` resolves to wrong path, langserver fails to start
- Mitigation: Structural — webpack 5 with `target: 'node'` defaults `node.__dirname` to `false` (real runtime value). Confirmed by pyright's own webpack config using the same pattern (typeshed-fallback CopyPlugin + runtime resolution). Do NOT set `node.__dirname` in config — rely on the default.

**State Corruption: Stale tsc output in dist/**
- Assumption: dist/ contains only webpack output
- Betrayal: Prior `npm run build` (tsc) left `.js` files in dist/ — webpack output mixed with tsc artifacts
- Consequence: Node might load wrong file if require paths are ambiguous
- Mitigation: Structural — set `output.clean: true` in webpack config (matches pyright pattern). This wipes dist/ before each webpack build.

**Encoding Boundaries:** Skip — pure JS/TS build tooling, no text/data encoding boundaries.
**Resource Exhaustion:** Skip — build tool runs once, bounded by codebase size. MCP server is small.

## Anti-Patterns

- Don't duplicate the webpack shared lib — import from `build/lib/webpack` like the other packages
- Don't hardcode any absolute paths in source — only `__dirname`-relative and env var override
- Don't add pyright-internal as a dependency — the MCP server doesn't import it, it spawns the langserver as a child process
