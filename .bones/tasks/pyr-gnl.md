---
id: pyr-gnl
title: 'Phase 5.5a Acceptance: Proxy Infrastructure + LSP Config'
status: open
type: task
priority: 1
parent: pyr-084
---

## Context

Phase 5.5a (Proxy Infrastructure + LSP Config) acceptance. All implementation criteria met. This task delivers the demo and updates any stale docs.

## Deliverables

### Demo

Show the following via restart of Claude Code with the plugin enabled:
1. **Diagnostics from dev Pyright** — open/edit a Python file, show diagnostics flowing from our dev build (not stock pyright-lsp)
2. **MCP tool call through proxy** — use the MCP `lsp()` tool (e.g., workspace/symbol query), show it returns valid data routed through the proxy
3. **Shared Pyright PID** — show PID file in `${CLAUDE_PLUGIN_DATA}`, verify one Pyright process serves both LSP and MCP
4. **Clean teardown** — close Claude Code or disconnect, verify PID file is gone and Pyright process is dead

### Documentation

Update stale docs only — no new summaries or tutorials.

## Success Criteria

- [x] Demo presented to user showing proxy infrastructure working
- [ ] User closes this task
