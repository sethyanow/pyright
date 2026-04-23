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

## Log

- [2026-04-20T00:34:21Z] [Seth] BUG — Enrichment hook not firing in live Claude Code session despite fresh plugin install. Observed: Read of sample.py and demo_tokens.py in this session produces NO <file-intelligence> block inline. Plugin install verified fresh at ~/.claude/plugins/cache/pyright-marketplace/pyright-mcp/0.1.0/ — hooks.json has correct PostToolUse Read|Edit|Write entry, dist/hooks/enrich-file.js present (5692 bytes, 20:18 today). CLI invocation of the hook with synthetic payload works (verified against /tmp state dir earlier). Hypothesis CLAUDE_PLUGIN_DATA missing ruled out by Claude Code docs: variable IS documented as available in plugin hooks (https://code.claude.com/docs/en/hooks). So hook is being invoked but silently emits {} — outer catch swallowing something. Next-session diagnostic plan: (1) temporarily add fs.writeFileSync('/tmp/enrich-hook-debug.log', ...) at top of main() with env+input snapshot; (2) rebuild + copy to installed plugin dir (or full reinstall); (3) agent Reads a .py in a NEW session; (4) inspect log to see actual env, actual input, where the flow bails; (5) fix root cause; (6) remove debug log; (7) re-verify. Acceptance gate stays OPEN until the hook fires end-to-end in a live session with block visible alongside Read tool result.
- [2026-04-20T01:29:11Z] [Seth] CORRECTION to prior bug log (2026-04-20T00:34:21Z): 'hook not firing' was NOT a pyright-mcp bug. Root cause identified via transcript forensics on 820c702f-f9b8-4d5d-a482-6005ebb7b302.jsonl. Timeline: (1) SessionStart:resume at 00:17:12 registered the hook; (2) Read of sample.py at 00:17:42 fired the hook, still in-flight at 00:17:58 when user interrupted the turn, producing hook_cancelled attachment; (3) from 00:17:58 through 00:36:52 Claude Code's PostToolUse dispatcher went SILENT — zero hook attachments of any kind on any tool use, not even 2-byte {} for non-.py Reads. The hook was registered but never invoked; (4) SessionStart:compact at 00:36:52 reinitialized the subsystem and every tool use from 00:37:17 onward produced a hook attachment as expected; (5) in this session, sample.py Read produced hook_success (5168ms, 475 bytes stdout) + hook_additional_context — full <file-intelligence> block injected. CONCLUSION: hook code is correct. The 19-minute silence was Claude Code-side state after user-cancel of an in-flight PostToolUse hook. Likely upstream bug worth filing against anthropics/claude-code, but out of scope for pyr-smw/pyr-a7n. Instrumentation used for diagnosis has been stripped; bundle back to 5692 bytes. Acceptance task stays open pending user-run shakedown/sign-off.
- [2026-04-22T02:58:41Z] [Seth] Shakedown #1 investigation (generic subscript stripping): NOT REPRODUCING. Raw Pyright via lsp-client returns full string labels (e.g. ': Proto[float]', ': list[dict[str, str]]'). Both local (packages/pyright-mcp/dist) and installed-plugin (~/.claude/plugins/.../0.1.0/dist) hook bundles produce identical full-subscript output on protocol1.py and genericType11.py. No stripping logic in inlayLabelString (fetch-file-intelligence.ts:50-53), escapeContent (format-file-intelligence.ts:66-68), or emission path. Earlier observation of ': Proto' truncation in summary appears to have been a misread. Side finding: hook silently returns {} when PYRIGHT_PROXY_STATE_DIR doesn't exist — main's catch swallows the thrown error from ensurePyrightRunning; minor robustness gap but not in scope for #1.
- [2026-04-22T06:47:24Z] [Seth] Shakedown #3 investigation (cold-cache vs out-of-workspace for /tmp files): NOT REPRODUCING. Tested three conditions: (1) live Write on /tmp/shakedown_demo.py produced inlays (int, list[int], dict[str, int]); (2) live Read on brand-new /tmp/cold_demo.py produced inlays; (3) fresh Pyright (new state dir /tmp/pyright-probe-fresh-xyz) on fresh /tmp/cold_pyright_demo.py produced inlays. All three paths yield full inlays for out-of-workspace files. Earlier premise ('cold Pyright + /tmp file → no inlays') does not reproduce. Likely explanation: Pyright's inlay hint provider handles explicitly-opened out-of-workspace files via didOpen regardless of workspace membership. Shakedown triage: #1 not reproducing, #2 filed as pyr-oq2, #3 not reproducing. Acceptance-blocking issues: none.
