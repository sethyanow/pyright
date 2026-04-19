---
id: pyr-x2v
title: Verify codeLens/resolve performance on cold cache with large workspace
status: closed
type: task
priority: 2
---









## Context

Unfinished debt from the 2026-04-12 handoff. Phase 5 (pyr-yh8) shipped the codeLens provider but closed with a known issue: `codeLens/resolve` with `kind: "implementations"` was timing out on cold cache when the workspace had many Python files. Prior session measured `_findSubclassLocations` binding 1,284 test-sample Python files in >30s, exceeding the hardcoded MCP timeout.

An import-graph pre-filter was attempted and reverted (diagnosis: the bottleneck is `_bindFile` itself, which must run before the import graph exists — chicken-and-egg).

A string-BFS approach was proposed: use `sourceFileInfo.contents` (available without binding, per `ReferencesProvider`'s existing pattern) to pre-filter files by name before calling `getParseResults`.

**State of the code (verified 2026-04-18, SRE pass):** The string-BFS fix IS already implemented. Commit `de968173a` on 2026-04-12 (same day as the handoff, authored by Seth; the handoff text predates this commit) introduced:
- `_findSubclassLocations` BFS pre-filter at `definitionProvider.ts:389-458`
- `_findMethodOverrideLocations` BFS pre-filter at `definitionProvider.ts:460-534`
- `TypeHierarchyProvider.getSubtypes` single-pass string pre-filter at `typeHierarchyProvider.ts:150-181` (transitivity handled by caller recursion)
- Regression tests: `codeLens.transitiveSubclass.fourslash.ts`, `findImplementations.transitiveMethod.fourslash.ts`, `typeHierarchy.transitiveSubtypes.fourslash.ts`, plus adversarial battery (BFS deep chain, diamond, substring collision, empty, unicode)

What remains unverified: whether the committed fix actually resolves the cold-cache timeout against a real 1000+ file workspace driven through the MCP proxy path. All evidence to date is fourslash-test-pass, which runs on tiny virtual workspaces that are always hot.

Timeout budget (verified):
- MCP server outer timeout: 30s (`packages/pyright-mcp/src/mcp-server.ts:70`)
- lsp-client timeout: 30s (`packages/pyright-mcp/src/lsp-client.ts:116`)
- Hook inner timeout: 7s (`packages/pyright-mcp/src/hooks/socket-lsp-client.ts:16`, `INNER_TIMEOUT_MS = 7_000`). Returns `[]` on timeout — silent degradation.
- Hook-level success: enrichment returns within hook budget (Phase 5.5b's PostToolUse hook blocks Read briefly; the effective user-perceived budget is ~10s end-to-end).

## Requirements

R1. Reproduce the original failure scenario: cold-cache codeLens resolve on a workspace with 1000+ Python files (the pyright-internal test samples are the canonical reproducer at `packages/pyright-internal/src/tests/samples/` — 1,284 `.py` files, verified).
R2. Measure the actual timing for both `kind: "implementations"` and `kind: "references"` codeLens resolves on cold cache. Capture baseline numbers.
R3. If R2 shows breach of the hook's effective budget: implement further optimization. **Note:** BFS pre-filter already implemented in commit `de968173a`; if still slow, investigate next bottleneck (typeshed scan? getTypeOfClass on hit files? binding during _collectSubclassesFromStatements?).
R4. Regression test for transitive subclass discovery MUST remain green. Test exists at `codeLens.transitiveSubclass.fourslash.ts` — verify it still passes after any optimization work.
R5. Confirm end-to-end: a PostToolUse hook Read on a Python file in a cold-cache workspace emits the `<file-intelligence>` block containing codeLens enrichment within the hook budget (no silent degradation to `[]`).

## Success Criteria

Structural gates only. Timing numbers are diagnostic inputs (logged to bones), not criteria.

- [x] Env-gated perf test in `packages/pyright-mcp/src/tests/codeLensPerf.test.ts` invokes the full LSP stack against the pyright-internal samples workspace for `codeLens/resolve` with `kind: "implementations"` — passes with cold-cache timing 723ms (well under 30s MCP timeout).
- [x] Same perf test covers `kind: "references"` — passes with cold-cache timing 57ms.
- [x] `enrich-file.test.ts` extended with an env-gated test that spawns a fresh proxy (`PYRIGHT_PROXY_STATE_DIR=mktemp -d`) and runs the hook against `abstractClass1.py` in the samples workspace — block contains `<file-intelligence` + `AbstractClassA`, elapsed 367ms (well under 7s hook inner timeout).
- [x] `codeLens.transitiveSubclass.fourslash.ts` passes in `npm run test:norebuild` (part of full fourslash suite pass).
- [x] `cd packages/pyright-internal && npm run test:norebuild` — all 2,392 tests pass across 57 suites.
- [x] `cd packages/pyright-mcp && npm test` — all 72 tests pass across 8 suites (3 perf tests gated skip by default); with `PYRIGHT_MCP_PERF=1` all 75 pass.
- [x] N/A — no further optimization needed; BFS pre-filter in commit `de968173a` is sufficient.

## Anti-Patterns

- **Don't declare victory from test-pass alone.** Fourslash tests run on tiny virtual workspaces that are always hot. The failure mode is cold-cache on large real workspaces.
- **Don't re-attempt the import-graph pre-filter.** The handoff already established that approach is chicken-and-egg. The string-BFS on `sourceFileInfo.contents` is the right tool — it reads disk without parsing/binding.
- **Don't invent a numeric target.** "<10s on 1284 files" isn't a design spec; it's a consequence of the hook timeout. Success is "hook timeout no longer trips" on the reproduction workload.

## Key Considerations

- **`sourceFileInfo.contents` availability:** per the handoff, `getFileContent()` in `sourceFile.ts` reads from (1) open file buffer, (2) cached parsed content, (3) filesystem — no parsing or binding. Confirmed the pattern works for `ReferencesProvider` at `referencesProvider.ts:255-256`.
- **BFS for transitive subclasses:** finding `Dog` as a subclass adds `"Dog"` to the search queue; next pass finds files containing `"Dog"`. Without BFS, a `GoldenRetriever(Dog)` in a file that doesn't mention `Animal` gets missed when searching for `Animal`'s impls. TypeHierarchy handles transitivity via caller recursion rather than BFS.
- **Cold-cache reproduction:** the MCP proxy reads/writes state under `PYRIGHT_PROXY_STATE_DIR`. A fresh `mktemp -d` directory for that env var gives a guaranteed cold process. First codeLens/resolve after spawn is the cold path.
- **Hook-layer mitigation already exists:** pyr-noe's socket-lsp-client has a 7s internal timeout that returns `[]` rather than rejecting (`socket-lsp-client.ts:16,113-116`). So cold-cache failure currently degrades silently: no enrichment block, but Read still succeeds. Silent degradation is the UX bug we're verifying.
- **Hit the full stack, not just the provider:** fourslash tests call `CodeLensProvider.resolve` directly against a `Program` that already loaded tiny virtual files. The real cold path exercises proxy → LSP client → `codeLens/resolve` round trip → provider against a Program that has not yet bound anything. R5's end-to-end check is the only one that exercises the whole stack.
- **Workspace config gotcha:** Pyright treats all Python files in the workspace as user code when there's no `pyrightconfig.json` narrowing scope. The pyright-internal repo DOES have configs — confirm which files are treated as user code during the repro (`getSourceFileInfoList()` iteration is what the providers scan).
- **Adversarial failure modes to watch:** (a) pre-filter string `targetClass.shared.name` appearing as substring in unrelated identifier → false-positive binding, no correctness issue; (b) unicode class names — the adversarial test exists but verify it runs; (c) BFS runaway: if every file contains the name, BFS collapses to full scan — still correct but no speedup.

### Failure Catalog (adversarial planning)

Grouped by component. Each entry: Assumption → Betrayal → Consequence → Mitigation.

**Component A: Cold-cache reproduction harness**

- *State Corruption:*
  - Assumption: `PYRIGHT_PROXY_STATE_DIR` isolates our measurement from other MCP instances.
  - Betrayal: The proxy architecture is "spawn once, share via Unix socket + PID file" (memory `reference_proxy_architecture.md`). If another pyright-mcp process uses the same state dir, our "fresh" client attaches to a warm existing process.
  - Consequence: Measurement reports warm timing; we declare "fixed" without actually exercising the bug.
  - Mitigation: `mktemp -d` per measurement run; after issuing first request, verify the PID file's `lsPid` matches a process spawned *after* the harness started.

- *Temporal Betrayal:*
  - Assumption: First `codeLens/resolve` after spawn measures the cold path.
  - Betrayal: Pyright may eagerly scan workspace during `initialize` before our timed request arrives. By the time codeLens/resolve fires, binding is already complete or underway.
  - Consequence: Underreported resolve timing; fix appears better than it is.
  - Mitigation: Instrument and report all four phases separately — `initialize`, `didOpen`, `codeLens`, `codeLens/resolve`. Don't attribute workspace scan cost to resolve.

- *Input Hostility:*
  - Assumption: OS-level file cache state is representative of user experience.
  - Betrayal: Our test machine's disk cache is warm from prior development; a true first-ever cold measurement would require cache eviction we can't reliably control.
  - Consequence: Reported "cold" is really warm-disk-cold-process, optimistic vs worst case.
  - Mitigation: Document the state model we control (fresh process, fresh state dir, warm OS cache) — that's the realistic user scenario (re-running Claude Code in the same working tree). Don't claim stronger coldness than measured.

**Component B: Timing measurement for both resolve kinds**

- *Temporal Betrayal:*
  - Assumption: `implementations` and `references` kinds are independent measurements.
  - Betrayal: Measuring one kind binds a portion of the workspace; the second kind's timing is no longer cold.
  - Consequence: First measurement looks slow, second looks fast; conclusions about which kind is the slow path flip based on measurement order.
  - Mitigation: Fresh process per kind. Two runs, two state dirs, two sets of numbers. Never reuse the process across kinds.

- *Input Hostility:*
  - Assumption: The chosen target symbol (for codeLens/resolve) exercises the slow path.
  - Betrayal: A symbol with zero subclasses returns empty fast, skipping the bind-heavy scan. Baseline lies.
  - Consequence: Measurement on a trivial target claims "fast cold path" while a realistic target (e.g., an ABC used across samples) would timeout.
  - Mitigation: Pick the target deterministically — a class in the samples known to have multiple subclasses. Document the class name in the reproduction procedure so the measurement is reproducible.

- *Resource Exhaustion:*
  - Assumption: One measurement run yields a meaningful number.
  - Betrayal: GC pauses, JIT warm-up, and macOS fsevents noise create inter-run variance. A single number misrepresents the distribution.
  - Consequence: Precision claimed beyond what measurement supports; apparent speedups/regressions on the next run create confusion.
  - Mitigation: Minimum 3 runs per kind per process; report min/median/max. Don't claim precision we don't have.

**Component C: End-to-end hook path (PostToolUse → socket-lsp-client → provider)**

- *Dependency Treachery:*
  - Assumption: The hook actually fires for our Read tool use.
  - Betrayal: `.claude/settings.json` hook config may be stale, absent, or misconfigured. Hook silently doesn't fire; verification sees "no error" and passes.
  - Consequence: False positive — we claim the budget held when the code path under test didn't execute.
  - Mitigation: Verify positively: the enrichment block MUST be present in the Read output (or explicitly empty with a recorded log from the hook). Absence-of-error is not evidence of execution.

- *Temporal Betrayal:*
  - Assumption: An empty enrichment block (`[]`) means the feature is unavailable or not applicable.
  - Betrayal: Socket-lsp-client's 7s inner timeout returns `[]` on timeout. An empty block conflates "no data" with "too slow" — same signal, opposite causes.
  - Consequence: Success criterion "enrichment block present" passes when the fix barely works at 6.9s; fails when resolve takes 7.1s even though transport is healthy.
  - Mitigation: Instrument socket-lsp-client duration. Report hook wall-clock duration in the log. Success is "wall-clock well under hook budget," not just "block non-empty."

- *State Corruption:*
  - Assumption: The hook invokes the current source (our BFS fix).
  - Betrayal: Pyright-mcp ships a webpack bundle from `dist/`. If `dist/` is stale, the hook runs pre-fix code despite our source tree being current (memory `reference_rebuild_dist_for_mcp.md`).
  - Consequence: Measurement reflects pre-fix behavior; we either think the fix failed or (worse) declare success on measurements from code we didn't ship.
  - Mitigation: `npm run build` for pyright-mcp before the end-to-end run. Make the rebuild an explicit first step in the reproduction procedure.

## Log

(None yet.)
- [2026-04-19T01:37:57Z] [Seth] Re-opened as its own task after pyr-noe checkpoint review. Pyr-yh8 (Phase 5) closed with the handoff's cold-cache concern unverified. pyr-noe's 7s hook timeout masks the failure as silent degradation. String-BFS pre-filter on sourceFileInfo.contents (per ReferencesProvider pattern) is the proposed fix but was never implemented.
- [2026-04-19T03:16:06Z] [Seth] SRE pass: spot-checked skeleton claims. Found string-BFS fix ALREADY implemented in commit de968173a (2026-04-12): _findSubclassLocations (definitionProvider.ts:389), _findMethodOverrideLocations (definitionProvider.ts:460), TypeHierarchyProvider.getSubtypes (typeHierarchyProvider.ts:150). Regression tests committed: codeLens.transitiveSubclass, findImplementations.transitiveMethod, typeHierarchy.transitiveSubtypes + adversarial battery. Budget verified: MCP 30s, lsp-client 30s, hook 7s. Task scope is now primarily verification (R1/R2/R5): cold-cache reproduction, timing measurement, end-to-end hook confirmation. R3 becomes conditional on baseline; R4 test already in tree. Updated skeleton with verified state + repro guidance + adversarial failure modes.
- [2026-04-19T03:47:18Z] [Seth] Reframed criteria per user feedback: measurement is diagnostic input, not a success gate. Structural tests only - non-null result (no MCP timeout), non-empty hook block, fourslash regression greens. Numbers go in log as context. Acceptance demo = agent performs Read in this session; hook block appears. Proceeding to TDD.
- [2026-04-19T03:52:14Z] [Seth] BASELINE captured (perf test PASS on first run): cold-cache codeLens/resolve implementations=652ms, references=56ms against samples workspace (1284 .py files, no pyrightconfig narrowing scope). Well under MCP 30s outer timeout and hook 7s inner timeout. BFS pre-filter (commit de968173a) is working as designed at scale. Test committed as regression guard: packages/pyright-mcp/src/tests/codeLensPerf.test.ts (env-gated PYRIGHT_MCP_PERF=1).
- [2026-04-19T03:54:13Z] [Seth] R5 verified: enrichFile on cold-cache large workspace (samples dir, 1284 files, fresh proxy state dir) = 337ms. Block contains AbstractClassA content and file-intelligence tags. Well under the 7s socket-lsp-client inner timeout. No silent [] degradation observed.
- [2026-04-19T04:00:26Z] [Seth] All success criteria verified and checked off. Tests committed (1f4368290) and pushed. Closing task.
