---
id: pyr-bay
title: 'Phase 5.5b Task 2: extend file-intelligence with inlayHint enrichment'
status: open
type: task
priority: 1
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

Extend the existing file. Add `fetchFileIntelligence(socketPath, filePath): Promise<FileIntelligence>`. Internally reuse the connect → initialize → didOpen → poll-documentSymbol dance, then issue codeLens + resolve (reuse existing logic — extract into a helper if the diff gets large) and `textDocument/inlayHint` with `range: { start:{line:0,character:0}, end:{line:2**31-1,character:0} }` over the same connection.

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

- [ ] `fetchFileIntelligence` added to `src/hooks/socket-lsp-client.ts`; fetches codeLens + inlayHint over one socket with a single timeout budget
- [ ] Parameter hints (`kind: 2`) filtered out; only Type hints reach the block
- [ ] Inlay labels kept verbatim (no stripping of `:` / `->`); array-form labels normalized by concat
- [ ] `formatFileIntelligenceBlock` renders combined codeLens + inlay lines sorted by line number; 100-line cap applies to the combined set; stable sort puts codeLens line before inlay line for the same line number
- [ ] Existing `fetchCodeLenses` and `formatFileIntelligence` exports still work unchanged (pyr-noe tests green)
- [ ] `enrich-file.ts` switched to the combined fetch/format path; empty-suppression gate checks BOTH lists
- [ ] Block for `packages/pyright-mcp/src/tests/fixtures/sample.py` contains at least one inlay line (`-> int` for `add`/`multiply` or `: int` for `result`/`product`)
- [ ] `cd packages/pyright-mcp && npx jest --forceExit` — all tests pass (existing + new assertions)
- [ ] `cd packages/pyright-internal && npm run test:norebuild` — all pass, no regressions
- [ ] `npm run typecheck` — clean
- [ ] End-to-end scripted verify produces block with visible inferred-type entry alongside Greeter codeLens data

## Anti-Patterns

- **Don't open a second socket for inlay hints.** One connection, one initialize, one timeout — same Pyright session serves both LSP methods. REASON: doubling connections doubles the collision surface on the shared Pyright backend documented in pyr-noe's Key Considerations.
- **Don't include parameter hints.** `InlayHintKind.Parameter` (2) is out of scope. REASON: epic R5 specifies "inferred types for unannotated variables/returns" — parameter name hints aren't inferred types, and they'd dominate the block with call-site noise.
- **Don't invent your own label format.** Keep Pyright's emitted `-> int` / `: int` verbatim. REASON: upstream already chose compact phrasing; re-formatting creates a second source of truth that drifts on upstream changes.
- **Don't deprecate `fetchCodeLenses` in this task.** Keep it as a wrapper over `fetchFileIntelligence`. REASON: pyr-noe's tests exercise it as a public boundary; breaking them is out-of-scope churn. If it truly has no callers after this task, delete in a follow-up.

## Key Considerations

- **Inlay hint request range:** LSP requires a `range` parameter. Pass `{ start: {line:0, character:0}, end: {line: 2**31 - 1, character: 0} }` or the file's line count (from the read text: `text.split('\n').length`). Both work with Pyright; the huge-end idiom avoids the extra count pass.
- **0-indexed → 1-indexed conversion:** Pyright returns LSP positions (0-indexed line). Both codeLens and inlay paths must add 1 before handing to the formatter so lines match editor display. pyr-noe's code already does this for lenses — mirror it for hints.
- **Label-is-array fallback:** LSP spec allows `InlayHint.label` as string OR array of `InlayHintLabelPart`. Pyright emits strings today, but upstream is free to switch. Handle both — cheap insurance.
- **Combined timeout budget:** pyr-noe's internal timeout is 7s; the hook's outer budget is 10s. Adding one inlay request per file costs ~100–300ms on the fixture. Measure during manual verification on a bigger file and flag as a follow-up if close to the limit.
- **Sort stability:** codeLens entry for line N must appear before an inlay entry for the same line N — the codeLens line anchors the symbol; the inlay line annotates. Use a stable sort with an explicit tiebreak (`codeLens` before `inlay` when `line` ties).
- **Empty-block suppression gate:** `enrich-file.ts` must return `{}` only if BOTH lists are empty, not if just codeLens is empty. A file with no classes/functions but inferred-type variables should still inject the inlay lines.
- **Kind default:** Pyright's response may omit `kind` (LSP spec says optional, Type is default). Filter `kind === 2`; keep `kind === 1` AND `kind === undefined`.

## Log

(None yet — to be added during execution.)
