---
id: pyr-smw
title: Build PostToolUse enrichment hook for .py files
status: open
type: task
priority: 1
parent: pyr-ilj
---

## Context

Sub-task C of Phase 5.5b (pyr-ilj). Sub-task B (pyr-1fl) shipped the `file_intelligence` MCP tool. This sub-task wires it into a PostToolUse hook so the agent passively receives enrichment when reading or editing `.py` files — the same ambient signal humans get in an IDE.

The hook cannot directly invoke the MCP server's tool from Claude Code (the MCP channel is owned by Claude Code, not externally addressable). Architectural intent: share the LSP-fetching + formatting logic between the MCP tool handler and the hook. Both connect to the same shared-Pyright instance via the proxy's socket (Phase 5.5a, `ensurePyrightRunning` pattern).

Verified existing infrastructure:
- `packages/pyright-mcp/src/proxy.ts:211` — `ensurePyrightRunning(stateDir)` spawns-or-connects to shared Pyright; returns `PyrightBackend { socketPath, pyrightProcess, socketServer, isOwner }`.
- `packages/pyright-mcp/src/mcp-server.ts` — contains the file_intelligence handler body that needs extraction for reuse.
- `packages/pyright-mcp/hooks/hooks.json` — currently registers only a SessionStart hook; PostToolUse entry needs to be added.
- `packages/pyright-mcp/webpack.config.js` — bundles 3 entries (mcp-server, lsp-client, proxy); add hook as 4th entry.
- `packages/pyright-mcp/.claude-plugin/plugin.json` — plugin config already wires MCP + LSP servers via `bin/start-server.sh`. Hook is plugin-local, no plugin.json change needed.

Memory references (canonical):
- `reference_claude_code_hook_schema.md` — PostToolUse stdin/stdout shapes; must `process.exit(0)` on any internal error.
- `reference_proxy_architecture.md` — `ensurePyrightRunning` pattern and socket bridging.
- `reference_pyright_inlay_behavior.md` — Pyright label is always `: T`; first-call cold-cache gaps for some inlays (fail-open, don't retry).

## Requirements

1. **Extract shared helper** `fetchFileIntelligence(lspConnection, filePath, tokenLegend, openedUris)` → `{ block: string } | { error: string }`. Move the LSP-fetching + formatting logic out of the MCP handler into a module-level function exported from a new file (or reorganized within `mcp-server.ts`). The MCP handler becomes a thin wrapper that calls the helper and wraps the string in MCP's `content` array.
2. **Hook entry point** `packages/pyright-mcp/src/hooks/enrich-file.ts`: reads PostToolUse JSON from stdin, emits `{hookSpecificOutput: {...}}` on stdout, exits 0 on any error.
3. **Gating** in the hook:
   - `tool_name` in {`Read`, `Edit`, `Write`}
   - `tool_input.file_path` must exist, be absolute, and end with `.py` (not `.pyi` — matches Sub-task B scope)
   - Skip silently (emit `{}`) for any non-matching input
4. **Connection**: hook uses `ensurePyrightRunning` to get a socket, creates a MessageConnection, sends `initialize` to capture the tokenLegend, then calls `fetchFileIntelligence`. If `CLAUDE_PLUGIN_DATA` is unset, skip silently.
5. **Error envelope**: any internal exception (JSON parse, LSP error, socket failure, Pyright unavailable) → `{}` on stdout, `process.exit(0)`. Never throw; never exit non-zero. The PostToolUse hook must be invisible to the user on failure.
6. **Build wiring**: add `hooks/enrich-file: './src/hooks/enrich-file.ts'` as a 4th webpack entry. Output `dist/hooks/enrich-file.js`.
7. **hooks.json registration**: add PostToolUse entry with `matcher: "Read|Edit|Write"` invoking `node ${CLAUDE_PLUGIN_ROOT}/dist/hooks/enrich-file.js` with a 60s timeout.
8. **Tests**:
   - Unit tests for gating + error paths (mocked stdin/stdout).
   - Integration test spawning the built hook as a subprocess with a controlled PostToolUse input and real Pyright via `ensurePyrightRunning` against the fixtures directory.
9. All existing tests continue to pass; `npm run typecheck` clean.

## Design

### Extraction boundary

```
fetchFileIntelligence(
  lspConnection: MessageConnection,
  filePath: string,          // absolute path, already validated
  tokenLegend: TokenLegend,
  openedUris: Set<string>    // caller-owned tracking, for didOpen reuse
): Promise<{ block: string } | { error: string }>
```

The function:
- Reads the source via `readFileSync` (same as current handler).
- Sends `didOpen` if not already in `openedUris`.
- Fires `Promise.allSettled` across codeLens, inlayHint, semanticTokens.
- Resolves code lenses, decodes tokens, filters inlays.
- Returns `{ block }` from `formatFileIntelligence(...)` or `{ error }` on all-three-fail.

The existing MCP handler becomes:
```ts
async ({ path: filePath }) => {
  // path validation (absolute, .py, exists, legend set)
  const result = await fetchFileIntelligence(lspConnection, filePath, tokenLegend, openedUris);
  if ('error' in result) return { content: [{ type: 'text', text: result.error }], isError: true };
  return { content: [{ type: 'text', text: result.block }] };
}
```

### Hook entry point shape

```ts
// src/hooks/enrich-file.ts (compiled to dist/hooks/enrich-file.js)

async function main(): Promise<void> {
  try {
    const input = await readStdinJson(); // PostToolUseInput
    if (!shouldEnrich(input)) { writeOutput({}); return; }
    const filePath = input.tool_input.file_path;
    const stateDir = process.env.CLAUDE_PLUGIN_DATA;
    if (!stateDir) { writeOutput({}); return; }
    const { socketPath } = await ensurePyrightRunning(stateDir);
    const { connection, legend, openedUris } = await connectAndInit(socketPath);
    const result = await fetchFileIntelligence(connection, filePath, legend, openedUris);
    connection.dispose();
    if ('error' in result) { writeOutput({}); return; }
    writeOutput({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: result.block,
      },
    });
  } catch {
    writeOutput({}); // swallow all errors
  } finally {
    process.exit(0);
  }
}

main();
```

### Gating logic

```ts
function shouldEnrich(input: PostToolUseInput): boolean {
  if (!['Read', 'Edit', 'Write'].includes(input.tool_name)) return false;
  const fp = input.tool_input?.file_path;
  if (typeof fp !== 'string') return false;
  if (!fp.endsWith('.py')) return false;
  if (!path.isAbsolute(fp)) return false;
  return true;
}
```

### Hook-as-client vs proxy
The hook is a **transient client** of the shared Pyright. It calls `ensurePyrightRunning` just like the proxy's `runMcpMode` does — this either spawns Pyright (if the first consumer) or connects to the existing socket. The hook's own connection closes when the script exits. The shared Pyright stays alive as long as some other client (Claude Code's MCP channel or the proxy's LSP channel) holds the socket open.

## Implementation

**Files to modify:**
- `packages/pyright-mcp/src/mcp-server.ts` — extract `fetchFileIntelligence`; handler becomes thin wrapper
- `packages/pyright-mcp/webpack.config.js` — add hook entry
- `packages/pyright-mcp/hooks/hooks.json` — add PostToolUse registration
- `packages/pyright-mcp/src/tests/file-intelligence-partial-failure.test.ts` — update to exercise the extracted helper directly (cleaner than going through MCP client)

**New files:**
- `packages/pyright-mcp/src/hooks/enrich-file.ts` — hook entry point
- `packages/pyright-mcp/src/fetch-file-intelligence.ts` — extracted helper (or moved into mcp-server.ts if it stays cohesive there; decide during implementation)
- `packages/pyright-mcp/src/tests/hook-enrich-file.test.ts` — unit + integration tests for the hook

**TDD Steps (each step is RED-GREEN-REFACTOR):**

### Step 1: Extract fetchFileIntelligence helper (REFACTOR-first, tests unchanged)

This is pure code motion — the existing partial-failure + integration tests already cover the handler's behavior. Move the handler body into a new exported `fetchFileIntelligence` function. Handler becomes a wrapper. Run the full pyright-mcp suite; all existing tests must pass unchanged. This is the ONE exception to TDD-first in this plan: pure extraction with zero behavior change, gated by the existing 28+ tests.

### Step 2: Unit tests for hook gating (RED)

Create `packages/pyright-mcp/src/tests/hook-enrich-file.test.ts`. Test intent:
- `shouldEnrich()` returns false for tool_name="Bash", tool_name="Grep", non-.py path, relative path, missing file_path, .pyi path
- `shouldEnrich()` returns true for tool_name="Read" + absolute .py, same for Edit and Write

Expected shape:
```ts
import { shouldEnrich } from '../hooks/enrich-file';
describe('enrich-file hook gating', () => {
  it('rejects non-Read/Edit/Write tools', () => { ... });
  // etc.
});
```

### Step 3: Implement shouldEnrich + hook shell (GREEN)

Create `packages/pyright-mcp/src/hooks/enrich-file.ts` with `shouldEnrich` exported. Main flow stubbed to emit `{}` always. Unit tests from Step 2 pass.

### Step 4: Integration test for hook entry (RED)

In `hook-enrich-file.test.ts`, add an integration test that:
- Builds the hook (`npm run webpack` in pyright-mcp, or invokes webpack programmatically for the test)
- Spawns `node dist/hooks/enrich-file.js` as a child process with `CLAUDE_PLUGIN_DATA` set to a tmpdir
- Writes a PostToolUse JSON to its stdin for `Read` on `fixtures/sample.py`
- Reads stdout, parses JSON
- Asserts `hookSpecificOutput.additionalContext` contains `<file-intelligence` and `class Greeter`

Expected to fail — main flow is stubbed to emit `{}`.

### Step 5: Implement connection + call to fetchFileIntelligence (GREEN)

Wire the main flow:
- readStdinJson helper (promise that collects stdin to EOF and parses)
- connectAndInit: create socket, wrap in MessageConnection, send initialize, capture legend from response
- Call fetchFileIntelligence
- Write output
- All error paths swallow and emit `{}`

### Step 6: Unit tests for error paths (RED-GREEN cycles)

Add tests for each silent-error case:
- Invalid JSON on stdin → emit `{}`, exit 0
- CLAUDE_PLUGIN_DATA unset → emit `{}`, exit 0
- Socket connection refused → emit `{}`, exit 0

Each failing → implement minimal guard → passes.

### Step 7: Webpack wiring

Update `webpack.config.js`: add `'hooks/enrich-file': './src/hooks/enrich-file.ts'` to the `entry` object. Run `npm run webpack` to verify `dist/hooks/enrich-file.js` is produced.

### Step 8: hooks.json registration

Update `packages/pyright-mcp/hooks/hooks.json` to add:
```json
"PostToolUse": [
  {
    "matcher": "Read|Edit|Write",
    "hooks": [
      {
        "type": "command",
        "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/hooks/enrich-file.js",
        "timeout": 60
      }
    ]
  }
]
```

### Step 9: Build + full test suite + typecheck

```bash
cd packages/pyright-mcp && npm run build
cd packages/pyright-mcp && npm run webpack
cd packages/pyright-mcp && ./node_modules/.bin/jest --forceExit
cd /Volumes/code/pyright && npm run typecheck
```

All must be clean.

## Success Criteria

- [ ] `fetchFileIntelligence` helper extracted; MCP handler is a thin wrapper; all existing pyright-mcp tests pass unchanged
- [ ] `shouldEnrich()` gates correctly: Read/Edit/Write times absolute .py path only; .pyi, .txt, relative paths, other tools rejected
- [ ] Hook entry point `src/hooks/enrich-file.ts` reads PostToolUse JSON, invokes fetchFileIntelligence when gate passes, emits `hookSpecificOutput.additionalContext` with the `<file-intelligence>` block
- [ ] Hook swallows all errors (invalid JSON, missing env, socket failure, LSP error, timeout) and emits `{}` with `process.exit(0)`
- [ ] Integration test spawns built hook, feeds PostToolUse JSON for sample.py, verifies additionalContext contains class Greeter enrichment
- [ ] `webpack.config.js` includes `hooks/enrich-file` entry; `npm run webpack` produces `dist/hooks/enrich-file.js`
- [ ] `hooks.json` PostToolUse entry matches `Read|Edit|Write` and points to the compiled hook
- [ ] `npm run typecheck` clean
- [ ] Full pyright-mcp test suite passes: `./node_modules/.bin/jest --forceExit`

## Anti-Patterns

- **Don't crash the hook on any error.** The hook must be transparent. Any non-zero exit surfaces as a hook error in Claude Code and scares the user.
- **Don't spawn a new Pyright per hook invocation.** Use `ensurePyrightRunning` — it connects to the shared instance managed by the proxy.
- **Don't duplicate fetch/format logic.** Extract the helper; the hook and MCP handler share it.
- **Don't widen the gate.** `.pyi` is out of scope (matches Sub-task B). `Grep`/`Bash`/other tools are out of scope.
- **Don't call `initialize` with capabilities that differ from the proxy's initialize.** Mismatched capabilities trigger a Pyright re-initialize on every connection, which is wasteful and can cause analysis state resets.
- **Don't write debug output to stdout.** Anything on stdout is parsed as JSON by the hook runtime. Use stderr for diagnostics (which Claude Code surfaces in debug mode but doesn't feed to the model).

## Key Considerations

- **Shared Pyright initialize handshake**: each client that connects sends its own initialize. Pyright handles this — the proxy's MCP client already does this pattern. The hook is one more client. But every initialize is an RPC roundtrip (~50-200ms). For a hook that fires on every Read/Edit/Write, this adds up. Acceptable for MVP; optimize later (e.g., the proxy could track one shared MessageConnection and multiplex tool calls, but that's a significant refactor).
- **Timeout**: The hook timeout in hooks.json defaults to 60s. file_intelligence has a 30s internal timeout per LSP branch. Net: hook will complete in ≤30s or emit `{}`.
- **First-call cold-cache**: Per `reference_pyright_inlay_behavior.md`, some inlay hints are absent on the very first call after a fresh Pyright spawn. The hook fails open — missing hints are acceptable, partial block is still valuable.
- **openedUris per-invocation**: Each hook invocation is a fresh process with its own `Set<string>`. didOpen will fire on every hook call, even for files already-opened by Claude Code's LSP client. Pyright's didOpen is idempotent — calling it twice on the same URI doesn't corrupt state, just wastes cycles. If the same file is being edited repeatedly, every hook call re-didOpens. Not a correctness issue, but a perf note.
- **stdin parsing**: Claude Code writes the PostToolUse JSON to the hook's stdin and closes stdin. Hook must read to EOF before parsing. Standard Node pattern: accumulate `process.stdin.on('data')` chunks, parse on `'end'`.
- **Path separator on Windows**: `path.isAbsolute('C:\\foo\\bar.py')` returns true on Windows, false on POSIX. The hook inherits the platform of Claude Code. No special handling needed beyond `isAbsolute`.
- **Tool response vs tool input**: The hook gets both `tool_input` (what was requested) and `tool_response` (what happened). We key on `tool_input.file_path` — the path that was read/edited/written. `tool_response` is ignored (we don't need to know if the tool succeeded; we just enrich based on the file touched).

## Failure Catalog

**Dependency Treachery: ensurePyrightRunning hangs or throws**
- Assumption: Pyright spawn or socket connect succeeds quickly
- Betrayal: stale PID file, socket permission error, Pyright startup failure
- Consequence: hook hangs until Claude Code's 60s timeout fires
- Mitigation: wrap the entire main() in a soft-timeout of ~45s that emits `{}` and exits 0. Accept Pyright spawn failures silently.

**Dependency Treachery: initialize fails or returns no legend**
- Assumption: Pyright's initialize response includes `capabilities.semanticTokensProvider.legend`
- Betrayal: older Pyright build missing the legend, or initialize errors out
- Consequence: fetchFileIntelligence can't decode tokens; block may be degenerate
- Mitigation: if legend is missing, emit `{}` and exit 0 (fail open, no enrichment).

**Temporal Betrayal: hook fires during Pyright cold start**
- Assumption: Pyright is already warm
- Betrayal: the user's first Read of a .py file is THE trigger that also spawns Pyright
- Consequence: cold-cache gaps (missing inlay hints); the first enrichment is incomplete
- Mitigation: accepted — second Read will see complete data. Per `reference_pyright_inlay_behavior.md`.

**State Corruption: multiple hook invocations race**
- Assumption: each hook is independent
- Betrayal: rapid-fire edits trigger overlapping hook processes; all call ensurePyrightRunning concurrently
- Consequence: race on PID file creation (first one wins, others connect to existing)
- Mitigation: ensurePyrightRunning is designed for this — PID file check is the dedupe. Trust the proxy's pattern.

**Input Hostility: file deleted between read and hook fire**
- Assumption: file exists when the hook is called
- Betrayal: user deletes/moves the file between the Edit completing and the hook firing
- Consequence: readFileSync throws, didOpen fails
- Mitigation: catch, emit `{}`, exit 0.

**Resource Exhaustion: many concurrent hooks slow down the system**
- Assumption: low-frequency Read/Edit/Write
- Betrayal: agent doing a large refactor, 50 files touched in a minute
- Consequence: 50 transient hook processes, each doing initialize + 3 LSP requests
- Mitigation: accept for MVP. If problematic, a later task can add process-level dedup (e.g., per-file cooldown written to a state file).
