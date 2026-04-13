---
id: pyr-tcv
title: 'Phase 5.5: LSP Proxy + Enrichment Hooks'
status: open
type: epic
priority: 1
depends_on: [pyr-yh8, pyr-084, pyr-ilj]
parent: pyr-otr
---










## Requirements (IMMUTABLE)

R1. Single Node.js proxy entry point replaces `bin/start-server.sh`. Accepts `--lsp` or `--mcp` flag to select protocol mode. Spawns Pyright langserver as a child process.

R2. Shared Pyright backend across LSP and MCP connections via Unix socket + PID file. First connection spawns Pyright. Any disconnect tears down Pyright — no connection counting, no leaked processes. Next connection spawns fresh.

R3. LSP passthrough mode: proxy forwards LSP JSON-RPC between Claude Code and the shared Pyright process. Diagnostics, navigation, hover, symbols all flow through unchanged.

R4. Plugin LSP configuration (`lspServers` in plugin.json) registers the proxy as the Python language server for `.py` and `.pyi` files, replacing the stock `pyright-lsp` plugin.

R5. PostToolUse hook on Read for `.py` files calls the MCP to fetch code lens, inlay hints, and semantic tokens for the read file and injects a `<file-intelligence>` block into conversation context.

R6. `<file-intelligence>` format: single block combining code lens (reference counts, implementation counts), semantic classification (ABC, Protocol, override), and inlay hints (inferred types for unannotated variables/returns). Compact, line-anchored, scannable.

R7. All existing tests pass. MCP tool behavior unchanged. Fourslash tests unaffected.

## Context

Phase 5 (Code Lens) shipped the provider but the agent DX gap remains: code lens, inlay hints, and semantic tokens require explicit MCP calls. Humans get this data passively in an IDE. Phase 5.5 closes that gap by making the enriched data flow automatically when an agent reads a Python file.

Claude Code's built-in LSP client requests diagnostics + navigation but NOT codeLens, inlayHint, or semanticTokens. A feature request is impractical (core team is focused on other priorities). The solution: PostToolUse hooks on Read that call through the MCP to fetch enrichments and inject them as context.

The proxy architecture replaces the shell script entry point and shares a single Pyright instance across LSP and MCP connections. This is a trial pattern intended for reuse across the user's other LSP-based projects.

## Success Criteria

- [x] `bin/start-server.sh` replaced by Node.js proxy entry point
- [x] `--lsp` flag: LSP JSON-RPC passthrough working (diagnostics flow from dev Pyright)
- [x] `--mcp` flag: MCP server working (existing tool behavior preserved)
- [x] Shared Pyright backend via Unix socket + PID — verified one Pyright process serves both
- [x] Any disconnect tears down Pyright child process (no leaked PIDs)
- [x] Plugin `lspServers` config registered, stock `pyright-lsp` disabled, dev build provides Python LSP
- [ ] PostToolUse hook on Read for `.py` fires and injects `<file-intelligence>` block
- [ ] `<file-intelligence>` includes code lens counts, semantic classifications, inferred types
- [ ] All existing tests pass: `cd packages/pyright-internal && npm run test:norebuild`
- [ ] `npm run typecheck` clean

## Anti-Patterns (FORBIDDEN)

- **Don't modify the Pyright language server itself for enrichment.** Enrichment happens at the proxy/hook layer. The language server stays clean. REASON: proxy is swappable, language server serves all clients equally.
- **Don't count connections for lifecycle.** Any disconnect kills Pyright. No reference counting. REASON: simpler, no leaked processes, warmup is cheap.
- **Don't inject enrichments as fake diagnostics at the LSP level.** Use hooks. REASON: fake diagnostics would pollute every LSP client, not just Claude Code. Hooks target the agent specifically.
- **Don't daemon-ize the proxy.** No persistent background process, no service management. Spawn on connect, teardown on disconnect. REASON: dev tooling, not infrastructure.

## Approach

Replace the shell entry point with a Node.js proxy that owns the Pyright spawn. Claude Code connects to the proxy twice (once for LSP, once for MCP) — both route to the same Pyright child process via Unix socket. The proxy is stateful but ephemeral: it manages the PID and socket for the lifetime of the connections, tears down on any disconnect.

Enrichment is a separate concern from the proxy. A PostToolUse hook on Read for `.py` files calls the MCP's `lsp()` tool to fetch codeLens, inlayHint, and semanticTokens for the file that was just read. The hook formats the results into a `<file-intelligence>` block and injects it into the agent's context. The agent sees the enrichment inline with the file read, same as it sees diagnostics inline with edits.

## Architecture

```
Claude Code
    │
    ├── stdio (LSP) ──→  proxy --lsp  ──┐
    │                                    ├──→  Unix socket  ──→  Pyright (one process)
    └── stdio (MCP) ──→  proxy --mcp  ──┘
                              │
                              └──→  PostToolUse hook (Read .py)
                                        │
                                        └──→  MCP lsp() tool
                                                │
                                                └──→  <file-intelligence> block
```

## Phases

### Phase 1: Proxy Infrastructure + LSP Config
**Scope:** R1, R2, R3, R4
**Gate:**
- `npm run typecheck` clean
- Plugin LSP config works: diagnostics flow from dev Pyright in Claude Code
- MCP tools still work through the proxy
- One Pyright process verified (PID check)
- Disconnect kills Pyright (PID gone after close)
**Demo:** Show diagnostics flowing from our dev build, MCP tool call working, single Pyright PID, clean teardown.

### Phase 2: Enrichment Hooks + File Intelligence
**Scope:** R5, R6, R7
**Gate:**
- PostToolUse hook fires on Read for `.py` files
- `<file-intelligence>` block appears in agent context with code lens, semantic, and inlay data
- Full test suite passes: `cd packages/pyright-internal && npm run test:norebuild`
**Demo:** Read a Python file with classes and functions, show the `<file-intelligence>` block that appears with reference counts, implementation counts, semantic classifications, and inferred types.

## Seam Contracts

### Phase 1 → Phase 2
**Delivers:** Working proxy with shared Pyright backend, MCP accessible through it
**Assumes:** Phase 2 hooks call MCP `lsp()` tool which routes through the same Pyright instance
**If wrong:** Hooks would need their own Pyright connection — defeats the shared architecture

### Phase 5 → Phase 5.5
**Delivers:** Code lens, inlay hint, semantic tokens providers all implemented and working in Pyright
**Assumes:** Phase 5.5 only builds the delivery mechanism, not the providers themselves
**If wrong:** Missing providers would need to be built first (but they're already done — Phases 3, 4, 5)

### Phase 5.5 → Phase 6+
**Delivers:** Dev Pyright as the active language server, enrichment pipeline operational
**Assumes:** Phases 6-8 add more providers that automatically flow through the same enrichment pipeline
**If wrong:** New providers would need hook updates to query additional LSP methods

## Design Rationale

### Problem
Code lens, inlay hints, and semantic tokens are implemented but only accessible via explicit MCP calls. Agents don't passively see this data like humans do in an IDE. The value of these features diminishes without ambient delivery.

### Why proxy over two separate processes
One Pyright instance is cheaper than two. The type cache, parsed files, and binding state are shared. Two instances would double memory and cold-start time. The proxy is trivial — route stdio to a Unix socket.

### Why hooks over diagnostic injection
Hooks target the agent specifically. Diagnostic injection would pollute every LSP client and require client detection at the language server level. The hook layer is clean separation: language server provides data, hook layer decides presentation.

### Why teardown on any disconnect
Connection counting is a state management problem that doesn't need to exist. Pyright cold-starts in <2s for a dev workspace. The simplicity of "spawn on connect, kill on disconnect" eliminates an entire class of leaked-process bugs.

## Open Questions

- Exact Unix socket path convention (e.g., `/tmp/pyright-proxy-<pid>.sock` or `${CLAUDE_PLUGIN_DATA}/pyright.sock`)
- Whether the hook should skip enrichment for very large files (>5000 lines) where codeLens would be noisy

## Log

- [2026-04-12T19:20:29Z] [Seth] Epic created from brainstorming session. Key decisions: Node.js proxy replaces shell script, shared Pyright via Unix socket + PID, teardown on any disconnect, enrichment via PostToolUse hooks on Read (not diagnostic injection), file-intelligence format merges code lens + semantic + inlay into one block. Trial pattern for user's other LSP projects.
