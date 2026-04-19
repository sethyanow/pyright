---
id: pyr-bay
title: 'Phase 5.5b Task 2: extend file-intelligence with inlayHint enrichment'
status: active
type: task
priority: 1
owner: Seth
depends_on: [pyr-klq]
parent: pyr-ilj
---






## Context

Second task of Phase 5.5b (pyr-ilj). Builds on pyr-noe's walking skeleton (`socket-lsp-client.ts` + `format-block.ts` + `enrich-file.ts`) to add inlay-hint data — inferred return types for unannotated function defs and inferred types for unannotated variable assignments — into the `<file-intelligence>` block.

**Blocked by:** pyr-noe (closed — codeLens enrichment pipeline in place)
**Unlocks:** Task 3 (semanticTokens + ABC/Protocol classifications), Phase 5.5b acceptance demo

## Requirements

From pyr-tcv parent epic:
- R5 (partial): PostToolUse hook injects inferred types from Pyright's `textDocument/inlayHint` alongside existing codeLens data
- R6 (partial): block now includes inlay TYPE entries (`InlayHintKind.Type` = 1) — return types on functions + types on variables. Parameter name hints (`InlayHintKind.Parameter` = 2) are OUT OF SCOPE for this task — they're noisy at call sites and not "inferred types of unannotated symbols"
- R7: all existing tests pass, no regressions to the codeLens slice from pyr-noe

## Design

### What Pyright emits (verified)

`InlayHintProvider` in `packages/pyright-internal/src/languageService/inlayHintProvider.ts` emits:
- `InlayHintKind.Type` (1) after an unannotated function def's `)` with label like `-> int` or `-> list[str]`
- `InlayHintKind.Type` (1) on an unannotated variable assignment with label like `: int`
- `InlayHintKind.Parameter` (2) at call arg positions — **filtered out in this task**

LSP response shape for `textDocument/inlayHint`:
```ts
Array<{
  position: { line: number; character: number };
  label: string | Array<{ value: string }>;
  kind?: 1 | 2;           // 1 = Type, 2 = Parameter
  paddingLeft?: boolean;
  paddingRight?: boolean;
}>
```

### Block format extension

Keep the format line-anchored; extend with inlay lines that carry inferred types. codeLens lines stay as-is; inlay lines use a distinct marker so readers can separate at a glance.

```
<file-intelligence path="/.../sample.py">
L4   Greeter         refs=3  impls=2
L24  add             refs=1
L24  -> int
L28  multiply        refs=1
L32  result : int
L33  product : int
</file-intelligence>
```

Rules:
- CodeLens lines keep the existing `L{line}  {symbol}  refs={n}  impls={m}` shape
- Inlay Type lines use the form `L{line}  {label}` (no symbol column; label carries the full `-> X` or `: X` text Pyright produced)
- Sort all lines together by ascending line number; stable sort so codeLens entry for line N precedes its inlay entry at line N
- The existing 100-line cap now applies to the combined set; sort-by-score stays codeLens-only (inlay entries sort by line only, after score-based truncation)

### Architectural split (reuses pyr-noe)

Introduce a combined fetch in `socket-lsp-client.ts`:

```ts
interface FileIntelligence {
    codeLenses: ResolvedLens[];
    inlayHints: InlayTypeHint[];
}
interface InlayTypeHint { line: number; label: string }

export async function fetchFileIntelligence(socketPath: string, filePath: string): Promise<FileIntelligence>;
```

`fetchFileIntelligence` reuses the existing connect → initialize → didOpen → poll documentSymbol machinery from pyr-noe, then issues BOTH `textDocument/codeLens` (with resolve) and `textDocument/inlayHint` (range = whole file) over the same connection, then returns both. Single socket, single Pyright session, one timeout budget.

`fetchCodeLenses` from pyr-noe stays exported for backward compatibility (delete later if no other caller).

`format-block.ts` grows a new entry point:

```ts
export function formatFileIntelligenceBlock(
    path: string,
    intel: FileIntelligence,
): string;
```

Renders combined output per Rules above. The existing `formatFileIntelligence(path, lenses)` function is kept (pure formatter over codeLens-only input) so existing unit tests survive unchanged.

`enrich-file.ts` switches from `fetchCodeLenses` to `fetchFileIntelligence`; from `formatFileIntelligence` to `formatFileIntelligenceBlock`. No schema change to hook output.

### Parameter hint filtering

At the boundary where raw LSP hints come back, filter `kind === 2` OUT. Keep only `kind === 1` (Type) hints. Rationale: parameter hints appear at call sites — dozens per file, repetitive, low-signal compared to refs counts. Task 3 may revisit if we add a "call-site intelligence" mode.

### Label normalization

LSP `InlayHint.label` can be either a `string` or an array of `{ value, ... }` parts. Normalize: if array, concatenate `.value` fields; if string, keep as-is (trim only trailing whitespace). Keep Pyright's emitted label verbatim otherwise — `-> int` includes the arrow, `: int` includes the colon. Preserve upstream formatting.

## Implementation

### Step 1: Write failing test for formatFileIntelligenceBlock

File: `packages/pyright-mcp/src/tests/hooks/format-block.test.ts` (extend existing)

Test intent: `formatFileIntelligenceBlock(path, { codeLenses, inlayHints })` produces a block with both lens lines and inlay-Type lines sorted by line number; inlay lines use the `L{line}  {label}` shape without a symbol column.

Key assertions:
- Input `{ codeLenses: [{line:4, symbol:'Greeter', references:3, implementations:2}], inlayHints: [{line:24, label:'-> int'}, {line:32, label:': int'}] }` → output body has three lines in ascending line order
- CodeLens line unchanged by extension (same format as existing `formatFileIntelligence` test suite)
- Inlay line contains the raw label verbatim (no stripping of `:` or `->`)
- Empty `inlayHints` array → behaves identically to calling the existing `formatFileIntelligence`
- Stable order: codeLens entry for line N precedes inlay entry at line N
- The combined 100-line cap counts codeLens + inlay entries together

Run: `cd packages/pyright-mcp && npx jest format-block --forceExit` — expect module-export-not-found failure.

### Step 2: Implement formatFileIntelligenceBlock

File: `packages/pyright-mcp/src/hooks/format-block.ts`

Export `FileIntelligence` and `InlayTypeHint` types. Add `formatFileIntelligenceBlock(path, intel): string`. Implementation: tag each entry with a type discriminator, merge into a single array, stable-sort by line number (with codeLens-before-inlay tiebreak), apply `MAX_LINES` cap, append truncation note if overflow. Keep the existing `formatFileIntelligence(path, lenses)` export unchanged.

Run: `cd packages/pyright-mcp && npx jest format-block --forceExit` — expect pass.

### Step 3: Write failing test for fetchFileIntelligence

File: `packages/pyright-mcp/src/tests/hooks/socket-lsp-client.test.ts` (extend existing)

Test intent: `fetchFileIntelligence(socketPath, sampleFile)` returns `{ codeLenses, inlayHints }` where `codeLenses` matches pyr-noe's shape and `inlayHints` contains inferred-type entries for `sample.py`'s unannotated `add` / `multiply` / `result` / `product` symbols.

Key assertions:
- `codeLenses` non-empty; contains `Greeter` with `implementations >= 2` (same anchor as pyr-noe's happy-path test)
- `inlayHints` non-empty; at least one `label` contains the substring `int` (because add/multiply return int and result/product are int)
- All `inlayHints[*]` have a numeric `line` and string `label`; no `kind:2` parameter hints leak through (no entry with a label that's just a bare identifier like `x=`/`y=`)

Plus: existing `fetchCodeLenses` happy-path test must still pass unchanged.

Run: `cd packages/pyright-mcp && npx jest socket-lsp-client --forceExit` — expect export-not-found failure.

### Step 4: Implement fetchFileIntelligence

File: `packages/pyright-mcp/src/hooks/socket-lsp-client.ts`

Extend the existing file. Add `fetchFileIntelligence(socketPath, filePath): Promise<FileIntelligence>`. Internally reuse the connect → initialize → didOpen → poll-documentSymbol dance, then issue codeLens + resolve (reuse existing logic — extract into a helper if the diff gets large) and `textDocument/inlayHint` with `range: { start:{line:0,character:0}, end:{line: text.split('\n').length, character:0} }` over the same connection. Use the already-read `text` for the end line — do not pass `2**31 - 1`; the actual line count is equally cheap (we already have `text` in memory for `didOpen`) and eliminates a "trust large-int clamping across Pyright versions" dependency.

Sequence the two LSP calls inside the SAME outer try/catch: `await codeLens+resolve` first, then `await inlayHint`. Do NOT use `Promise.all` — a failure of one must not discard the other's results. The outer catch returns `{ codeLenses: [], inlayHints: [] }` so enrich-file's caller guarantee (never throws) is preserved.

Post-process inlay response:
1. Filter `kind !== 2` (keep only Type hints; missing `kind` → assume Type by default per LSP spec)
2. Normalize label: if `string` → use as-is; if array of `{value, ...}` parts → concat `.value` fields in order; fall back to empty string if neither
3. Skip entries with empty labels after normalization
4. Map to `{ line: position.line + 1, label: normalized }` (1-indexed line to match codeLens path)

Keep the existing `fetchCodeLenses` export as a thin wrapper: `return (await fetchFileIntelligence(...)).codeLenses;` so pyr-noe's tests still compile.

Reuse the same cancel token + outer timer structure from pyr-noe's implementation — inlay adds one more request to the budget but stays within 7s on the test fixture.

Run: `cd packages/pyright-mcp && npx jest socket-lsp-client --forceExit` — expect pass.

### Step 5: Write failing test for enrich-file with inlay data

File: `packages/pyright-mcp/src/tests/hooks/enrich-file.test.ts` (extend existing Python-Read happy-path test)

Add one assertion to the existing "returns PostToolUse hookSpecificOutput with <file-intelligence> for a Python Read" test: `expect(additionalContext).toMatch(/int/)` — the fixture's `add`/`multiply` return int, and `result`/`product` are int, so the block must reference `int` once inlay flows through.

Run: `cd packages/pyright-mcp && npx jest enrich-file --forceExit` — expect failure because `enrich-file` still only calls `fetchCodeLenses`.

### Step 6: Switch enrich-file to combined fetch + formatter

File: `packages/pyright-mcp/src/hooks/enrich-file.ts`

Replace `fetchCodeLenses` / `formatFileIntelligence` calls with `fetchFileIntelligence` / `formatFileIntelligenceBlock`. Change the empty-suppression gate to: `if (intel.codeLenses.length === 0 && intel.inlayHints.length === 0) return {};`.

Run: `cd packages/pyright-mcp && npx jest enrich-file --forceExit` — expect pass.

### Step 7: Full suite + typecheck

- `cd packages/pyright-mcp && npx jest --forceExit` — all existing + new hook tests pass
- `cd packages/pyright-internal && npm run test:norebuild > /tmp/internal-tests.log 2>&1` — zero regressions
- `cd /Volumes/code/pyright && npm run typecheck` — clean

### Step 8: Rebuild bundle + end-to-end scripted verify

- `cd packages/pyright-mcp && npm run webpack`
- Re-run `/tmp/verify-enrich.sh` (script from pyr-noe Step 9) against the new bundle
- Confirm emitted block for `sample.py` now contains at least one `-> int` or `: int` line alongside the existing Greeter codeLens data
- Confirm non-Python Read still returns `{}`

## Success Criteria

- [x] `fetchFileIntelligence` added to `src/hooks/socket-lsp-client.ts`; fetches codeLens + inlayHint over one socket with a single timeout budget
- [x] Parameter hints (`kind: 2`) filtered out; only Type hints reach the block (also: hints with unknown future `kind` values pass through — filter is `kind !== 2`, not `kind === 1`)
- [x] Inlay labels kept verbatim (no stripping of `:` / `->`); array-form labels normalized by concat
- [x] Inlay labels HTML-escaped via the existing `escape()` helper at render time (same treatment as the symbol column) — prevents `<`/`&` in a label from breaking the `<file-intelligence>` container
- [x] `formatFileIntelligenceBlock` renders combined codeLens + inlay lines sorted by line number; 100-line cap applies to the combined set; stable sort puts codeLens line before inlay line for the same line number
- [x] codeLens score-sort and `MAX_LINES` cap applied to codeLens FIRST; then surviving codeLens entries merged with inlay; then stable-sorted by line — inlay entries structurally cannot evict high-signal codeLens
- [x] Formatter dedupes identical `(line, label)` inlay entries before rendering
- [x] Existing `fetchCodeLenses` and `formatFileIntelligence` exports still work unchanged (pyr-noe tests green)
- [x] Inlay request range uses `text.split('\n').length` as the end line (not `2**31 - 1`)
- [x] Combined fetch sequences codeLens then inlay inside ONE outer try/catch; simulated socket failure mid-inlay still returns `{ codeLenses: [...], inlayHints: [] }` (unit test)
- [x] `enrich-file.ts` switched to the combined fetch/format path; empty-suppression gate checks BOTH lists
- [x] Empty-suppression regression test: fixture with zero codeLens entries and non-empty inlay entries → hook emits a non-empty block
- [x] Block for `packages/pyright-mcp/src/tests/fixtures/sample.py` contains at least one inlay line (`-> int` for `add`/`multiply` or `: int` for `result`/`product`)
- [x] `cd packages/pyright-mcp && npx jest --forceExit` — all tests pass (existing + new assertions)
- [x] `cd packages/pyright-internal && npm run test:norebuild` — all pass, no regressions
- [x] `npm run typecheck` — clean
- [x] End-to-end scripted verify produces block with visible inferred-type entry alongside Greeter codeLens data

## Anti-Patterns

- **Don't open a second socket for inlay hints.** One connection, one initialize, one timeout — same Pyright session serves both LSP methods. REASON: doubling connections doubles the collision surface on the shared Pyright backend documented in pyr-noe's Key Considerations.
- **Don't include parameter hints.** `InlayHintKind.Parameter` (2) is out of scope. REASON: epic R5 specifies "inferred types for unannotated variables/returns" — parameter name hints aren't inferred types, and they'd dominate the block with call-site noise.
- **Don't invent your own label format.** Keep Pyright's emitted `-> int` / `: int` verbatim. REASON: upstream already chose compact phrasing; re-formatting creates a second source of truth that drifts on upstream changes.
- **Don't deprecate `fetchCodeLenses` in this task.** Keep it as a wrapper over `fetchFileIntelligence`. REASON: pyr-noe's tests exercise it as a public boundary; breaking them is out-of-scope churn. If it truly has no callers after this task, delete in a follow-up.

## Key Considerations

- **Inlay hint request range:** LSP requires a `range` parameter. Use the file's actual line count: `end: { line: text.split('\n').length, character: 0 }`. We already have `text` in memory for `didOpen`, so the split is ~free, and it avoids the "trust Pyright to clamp `2**31 - 1` across future versions" dependency.
- **0-indexed → 1-indexed conversion:** Pyright returns LSP positions (0-indexed line). Both codeLens and inlay paths must add 1 before handing to the formatter so lines match editor display. pyr-noe's code already does this for lenses — mirror it for hints.
- **Label-is-array fallback:** LSP spec allows `InlayHint.label` as string OR array of `InlayHintLabelPart`. Pyright emits strings today, but upstream is free to switch. Handle both — cheap insurance.
- **Combined timeout budget:** pyr-noe's internal timeout is 7s; the hook's outer budget is 10s. Adding one inlay request per file costs ~100–300ms on the fixture. Measure during manual verification on a bigger file and flag as a follow-up if close to the limit.
- **Sort stability:** codeLens entry for line N must appear before an inlay entry for the same line N — the codeLens line anchors the symbol; the inlay line annotates. Use a stable sort with an explicit tiebreak (`codeLens` before `inlay` when `line` ties).
- **Empty-block suppression gate:** `enrich-file.ts` must return `{}` only if BOTH lists are empty, not if just codeLens is empty. A file with no classes/functions but inferred-type variables should still inject the inlay lines.
- **Kind default:** Pyright's response may omit `kind` (LSP spec says optional, Type is default). Filter `kind === 2`; keep `kind === 1` AND `kind === undefined`.

### Failure Catalog

#### formatFileIntelligenceBlock (format-block.ts)

**Encoding Boundaries: HTML metacharacters in inlay labels**
- Assumption: Pyright's emitted label text is safe to drop into the `<file-intelligence>` container as-is.
- Betrayal: Type labels are not contractually ASCII-alphanum. A future Pyright label carrying `<`, `>`, `&`, or `"` (generics, intersections, TypedDict corners, protocol names) passes through verbatim.
- Consequence: Raw `<` inside a label terminates the container prematurely for any downstream agent that parses the block with strict XML-ish rules — whole block drops silently.
- Mitigation (structural): Reuse `escape()` (format-block.ts:10) on inlay labels at render time, same helper already applied to the symbol column. Enforced by a unit test that renders a hostile label like `List[<weird>]` and asserts the output contains `&lt;` not `<`.

**Resource Exhaustion: High-inlay files evict high-signal codeLens**
- Assumption: Applying `MAX_LINES` to a merged codeLens + inlay array preserves the most informative entries.
- Betrayal: A utility module with hundreds of unannotated locals floods the inlay list. A naive merge-then-sort-by-line-then-cap can push Greeter's `refs=3 impls=2` off the bottom in favor of dozens of `: int` inlays. codeLens-only score sort no longer gatekeeps.
- Consequence: The most agent-actionable intelligence (refs/impl counts on classes and functions) disappears into the truncation note, replaced by low-signal per-variable type echoes.
- Mitigation (structural): Two-phase pipeline in the new formatter — (1) score-sort codeLens and take top `MAX_LINES`; (2) merge survivors with inlay entries; (3) stable-sort merged array by line. Inlay entries can overflow into the truncation note; codeLens visibility is structurally preserved. This is the meaning of the existing "sort-by-score stays codeLens-only" rule — make it explicit in implementation, not just intent.

**Input Hostility: Duplicate inlay entries at the same position**
- Assumption: Pyright emits at most one Type hint per source location.
- Betrayal: Nothing in the LSP spec forbids multiple hints at one position. A future Pyright could surface separate hints for union members or narrowed branches.
- Consequence: Block shows two identical `L32  : int` lines, wasting cap budget and looking like a bug.
- Mitigation (structural): Dedupe inlay entries by `(line, label)` tuple before merging with codeLens. Single pass, O(n). Unit test passes duplicate entries in and asserts the output contains the line once.

#### fetchFileIntelligence (socket-lsp-client.ts)

**Dependency Treachery: Combined fetch must never throw**
- Assumption: `enrich-file.ts` calls the fetch unguarded; it relies on the fetch returning `{ codeLenses: [], inlayHints: [] }` on every failure path.
- Betrayal: The current pyr-noe outer try/catch wraps one LSP request. Adding a second introduces the risk that a refactor reorders them, splits them across promises, or uses `Promise.all` (which fails-fast on either reject) — leaking an unhandled rejection into the hook process or discarding partial data.
- Consequence: Either the hook crashes (propagating an error to Claude Code's hook runner), or we lose good codeLens data because inlay failed.
- Mitigation (structural): ONE outer try/catch wraps BOTH requests. Sequence them (`await codeLens+resolve; await inlay`) — never `Promise.all`. On any throw, return `{ codeLenses: [], inlayHints: [] }`. Unit test destroys the socket between the two requests and asserts the combined return still contains the codeLens data.

**Resource Exhaustion: Inlay adds to the 7s inner budget**
- Assumption: `INNER_TIMEOUT_MS` of 7s covers codeLens + resolve + inlay.
- Betrayal: Inlay on a cold-cache large file triggers type evaluation for every unannotated symbol — easily multi-second on a real project. Sample fixture says nothing about production-sized files.
- Consequence: Timer fires, socket destroyed, block empty; user sees no enrichment and no error (fail-open).
- Mitigation (structural): Keep the outer timer — fail-open IS the correct failure mode for an ambient hook. Do NOT silently bump `INNER_TIMEOUT_MS`. Add an explicit measurement step in Step 8 against a 500+ line file; if close to 7s, log as a bones follow-up task, not a silent tune.

**Temporal Betrayal: Inlay response depends on type evaluator warmth, not just binding**
- Assumption: If `documentSymbol` returns non-empty, Pyright is warm enough for inlay.
- Betrayal: `documentSymbol` only requires binding; inlay requires type evaluation, which is lazier. A symbol-ready file can still return empty inlay on the first call.
- Consequence: First hook invocation after a cold start may produce codeLens but no inlay — intermittent UX.
- Mitigation (structural): Accept fail-open behavior — a second Read in the same session produces the full block. Do not add an extra poll (blows the timeout budget). Log the observed first-cold-call behavior in a bones note after Step 8 measurement so the follow-up task has data, not speculation.

**Input Hostility: `2**31-1` as inlay end line**
- Assumption: Pyright accepts a deliberately-oversized end position and clamps internally.
- Betrayal: Today's behavior is today's; future Pyright versions could validate range bounds or internally materialize arrays sized to the requested end.
- Consequence: Inlay request silently returns nothing or errors; block loses inlay data.
- Mitigation (structural): Use `text.split('\n').length` as the end line. We already have `text` in memory for `didOpen`; one split is cheap. Eliminates the dependency entirely. See Step 4 above.

**Input Hostility: Malformed array-form labels**
- Assumption: Array-form labels match `Array<{ value: string, ... }>`.
- Betrayal: A non-conforming part could omit `value`, carry `value: null`, or contain a nested object.
- Consequence: Concat produces `"undefined: int"` or throws on `.value` access — block shows garbage or drops entirely.
- Mitigation (structural): Normalization filters array parts where `typeof part.value !== 'string'` before joining. If no valid parts remain, return empty string; Step 3 ("skip entries with empty labels") then drops the entry cleanly — structural chain.

**Input Hostility: Unknown future `kind` values**
- Assumption: `kind` is 1, 2, or undefined.
- Betrayal: LSP evolves. A future spec or a Pyright extension could add kind 3 (e.g., ChainingHint).
- Consequence: Accept-list (`kind === 1`) silently drops a new feature we'd want visibility on; drop-list (`kind === 2`) passes it through — might look wrong in the block but at least we SEE it.
- Mitigation (structural): Already correct in the skeleton rule (`filter kind === 2`). Add a unit test that passes `kind: 3` through and asserts it survives to the block. Makes the "keep unknowns" choice executable, not just intent.

#### enrich-file.ts switch

**State Corruption: Empty-suppression gate misses the inlay-only case**
- Assumption: A careful dev updates the `if (lenses.length === 0) return {};` gate to check both lists.
- Betrayal: A half-refactor leaves `if (intel.codeLenses.length === 0) return {};`. A pure-script Python file (no classes, only unannotated locals) injects nothing, silently disabling inlay enrichment for an entire file category.
- Consequence: Inlay enrichment silently fails for scripts, notebooks, utility modules — exactly the files where inferred types matter most.
- Mitigation (structural): Unit test `enrichFile` against a fixture with zero codeLens entries and non-empty inlay entries; assert `additionalContext` is non-empty and contains an inlay line. Test catches the gate mistake at PR time, not at demo time.

## Log

(None yet — to be added during execution.)
- [2026-04-19T05:08:15Z] [Seth] Session wash (2026-04-19). SRE ran; no updates needed. Agent burned the session on performative verification: read inlayHintProvider.ts in full, then ran redundant rg searches to 'prove' the -> int vs : int finding, then escalated format/symbol-column ambiguity to user as a decision — all noise. Skeleton already hedges with 'label like' and success-criterion 'or', and the rule says verbatim pass-through. No factual error, no decision needed. Separately: skipped Step 1a (adversarial-planning / failure catalog) and jumped at TDD. Next session: after confirming SRE has no findings, invoke litepowers:adversarial-planning against pyr-bay before TDD. Fresh runtime check already captured: Pyright emits ': int' for multiply return, ': Literal[3]' for result (literal arithmetic narrowing), ': int' for product, no hint for add (Unknown return).
- [2026-04-19T05:36:23Z] [Seth] Adversarial planning complete. Added Failure Catalog under Key Considerations grouped by component (formatFileIntelligenceBlock, fetchFileIntelligence, enrich-file switch). Structural mitigations only — no defensive try/catches. New success criteria: HTML-escape inlay labels, score-sort+cap codeLens BEFORE merging inlay, dedupe (line,label) pairs, sequence codeLens-then-inlay in one try (no Promise.all), empty-suppression gate regression test for inlay-only files, use text.split('\n').length not 2**31-1 as inlay range end. Updated Step 4 accordingly.
