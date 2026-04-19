---
id: pyr-a7n
title: 'Phase 5.5b Acceptance: Enrichment Hooks + File Intelligence'
status: open
type: task
priority: 1
parent: pyr-ilj
---

## Acceptance Task — Phase 5.5b: Enrichment Hooks + File Intelligence

### Agent Documentation (complete before presenting demo)

Update stale docs only — do not generate new content.

- [x] `CLAUDE.md` (root): reviewed — no Phase 5.5b-specific sections are stale
- [x] `packages/pyright-mcp/`: no README exists; implementation is self-documenting via inline comments on the hook, helper, and proxy guard

Both deliverables are "no stale content found" — the code, skeleton, and bones log carry the details.

### What This Phase Built

Sub-tasks A (semantic token modifiers: abstract/protocol/override), B (`file_intelligence` MCP tool), and C (PostToolUse enrichment hook) are shipped. When the agent reads or edits a `.py` file, Claude Code fires a PostToolUse hook that opens a transient LSP connection to the shared Pyright instance, fetches codeLens + inlayHint + semanticTokens, formats a compact `<file-intelligence>` block, and injects it into the agent's conversation context alongside the tool result — the same place a human sees IDE hints.

### Environment Setup

1. Ensure the built artifacts are current:
   ```bash
   cd /Volumes/code/pyright/packages/pyright-mcp && npm run webpack
   ```

2. Optional — if the installed plugin cache (`~/.claude/plugins/cache/pyright-marketplace/pyright-mcp/0.1.0`) is stale vs source, refresh it via your plugin workflow. The Path A CLI demo below bypasses the cache and works against local source.

### Demo

Two paths — pick one, or both.

**Path A — CLI demonstration (works from any shell; no plugin refresh needed):**

```bash
cd /Volumes/code/pyright/packages/pyright-mcp
mkdir -p /tmp/pyright-demo-state

SAMPLE="$(pwd)/src/tests/fixtures/sample.py"
PAYLOAD=$(cat <<JSON
{
  "session_id": "demo",
  "transcript_path": "/tmp/transcript.jsonl",
  "cwd": "$(pwd)/src/tests/fixtures",
  "permission_mode": "default",
  "hook_event_name": "PostToolUse",
  "tool_name": "Read",
  "tool_input": { "file_path": "${SAMPLE}" },
  "tool_response": { "success": true },
  "tool_use_id": "toolu_demo"
}
JSON
)

echo "$PAYLOAD" | PYRIGHT_PROXY_STATE_DIR=/tmp/pyright-demo-state \
    node dist/hooks/enrich-file.js | jq -r '.hookSpecificOutput.additionalContext'
```

Expected output: a `<file-intelligence>` block for `sample.py` showing `class Greeter`, `class EnglishGreeter`, `class SpanishGreeter`, reference / implementation counts, and inferred types for `result` and `product` (the unannotated module-level variables).

**Path B — Live Claude Code session (requires plugin refresh):**

After refreshing the pyright-mcp plugin, use the Read tool on `packages/pyright-mcp/src/tests/fixtures/sample.py` in an agent session. Observe the `<file-intelligence>` block injected as additional context alongside the Read result.

### Edge cases to exercise

```bash
# Non-.py file — hook emits {} and does NOT spawn Pyright
echo '{"tool_name":"Read","tool_input":{"file_path":"/etc/hosts"}}' \
    | PYRIGHT_PROXY_STATE_DIR=/tmp/pyright-demo-state \
    node dist/hooks/enrich-file.js

# Malformed stdin — hook emits {} and returns exit code 0
echo 'not json' \
    | PYRIGHT_PROXY_STATE_DIR=/tmp/pyright-demo-state \
    node dist/hooks/enrich-file.js
```

Both must print `{}` on stdout and return exit code 0.

### Sign-Off

- [ ] Path A (or B) produces a `<file-intelligence>` block containing `class Greeter` and at least one reference/implementation count
- [ ] Edge cases: non-.py and malformed stdin both emit `{}` with exit code 0
- [ ] Phase 5.5b complete — parent epic pyr-tcv ready for closure
