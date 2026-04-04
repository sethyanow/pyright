---
name: chunkhound-extraction
description: This skill should be used when extracting functions from the createTypeEvaluator closure into standalone modules using ChunkHound graph and search tools. Invoke at session start for any pyr-a56 subtask.
---

# ChunkHound-Assisted Closure Extraction

Extract functions from `createTypeEvaluator()` into standalone module files. ChunkHound graph and search tools handle discovery and dependency mapping. LSP handles interface checks and live verification.

## Pre-Flight

Verify ChunkHound index is current and LSP is warm:

```
get_stats → check file/chunk/symbol counts
search symbols query="recentlyExtractedFunction" → verify it appears in the correct module
LSP documentSymbol on a real source file → confirm LSP responds
```

If ChunkHound index is stale, fall back to rg + LSP until re-indexed.

## Discover the Batch

Find what to extract next. Two approaches:

**By connectivity:** `graph overview` scoped to the analyzer directory surfaces the most-connected remaining functions — natural extraction candidates.

**By concept:** `search structural` with a domain query ("type narrowing", "overload resolution") returns semantic matches plus their callers/callees via graph expansion. This discovers what should be co-extracted.

Profile candidates with `symbol_context` for a compound view (graph neighborhood, related symbols across files, edge types) or `graph walk` with `edge_kind="calls"` depth=2 for the full dependency subgraph.

## Map Dependencies and Find Cycles

For each candidate, `graph walk` with `edge_kind="calls"` shows what it depends on. Filter to calls resolving to typeEvaluator.ts — those are closure deps that need dissolution.

**Cycle detection:** If function A appears in B's walk AND B appears in A's walk, they're in a cycle — extract together. A→B→C where C doesn't call A is a chain, not a cycle. Chains extract bottom-up one at a time. Only mutual callers need batch extraction.

**Hidden dependencies:** For each closure dep NOT in the batch, run `graph walk` with `edge_kind="called_by"` depth=1. If it has 1-2 callers all in the batch, it must come along.

## Extract (per-function loop)

For each function, in order:

**1. Classify deps.** `graph walk` with `edge_kind="calls"` on the function. For each call into typeEvaluator.ts, check the dissolution table in `references/dependency-patterns.md`. Work top to bottom: state wrapper → interface method → one-liner wrapper → already extracted → pure function → sole connector → genuinely blocking. Most dissolve before the bottom.

Nothing is "too entangled." Nothing is "deferred." If the dissolution table doesn't resolve it, escalate to the user. Don't self-block.

**2. Read and transform.** Read the function body. Add `export`, add params (evaluator/state/registry as needed), replace closure calls per the dissolution classification. `evaluatorInterface` → `evaluator` everywhere. Append to target module via Edit — never overwrite.

**3. Wire delegation.** Replace the original in typeEvaluator.ts with a one-line delegate call. For large functions: dead-rename technique — insert delegation stub, rename old body to `_functionName_dead`. Delete dead function in a separate commit after tests pass.

Check delegation signatures with LSP `hover` on both the closure function and the interface definition. Optional params on the closure function that aren't on the interface will bite you silently.

**4. Compile.** Trust live LSP diagnostics first — they're at most a few chained tool calls behind. Don't pre-solve imports; write what you know, let the compiler report what's missing. Run `npm run typecheck` when diagnostics are clean for belt-and-suspenders.

Live diagnostics showing errors are facts, not triage decisions. Don't classify anything as "pre-existing" or "unrelated." Report what's broken.

**5. Test.** `cd packages/pyright-internal && npx jest typeEvaluator1.test typeEvaluator2.test checker.test --forceExit`. If tests fail, stop. Don't proceed. Hover on both closure and interface signatures — look for param mismatches.

**6. Commit.** Each extraction is one commit. Commit after each leaf. Run `npm run check` every 2-3 extractions for eslint/prettier.

## Extract the Cycle

Same per-function loop, but accumulate: write ALL cycle functions to the target file before compiling, wire ALL delegations before compiling, compile once and fix. One commit for the cycle wiring, delete dead functions in a second commit.

Each function in the cycle follows the same read-transform-write pattern. The difficulty is anticipated, not experienced.

## Validate Boundaries

After extracting a batch: `graph boundary` scoped to the new module. Edges crossing should be intentional (imports from types.ts, typeUtils.ts, the evaluator interface). Unexpected edges back to typeEvaluator.ts mean missed delegation or circular imports.

Never import from typeEvaluator.ts in extracted modules. If a type defined there is needed, redefine it locally.

## Tool Hierarchy

ChunkHound graph → LSP → rg. Work down only when the level above can't answer.

| Need | Tool |
|------|------|
| What to extract next | `graph overview`, `search structural` |
| Dependency subgraph | `graph walk` with `calls` |
| Who calls this | `graph walk` with `called_by` |
| Compound profile | `symbol_context` |
| Interface membership | LSP `hover` (only reliable method) |
| Live compile errors | LSP diagnostics |
| Current line number | `rg -n` (lines shift during extraction) |
| Boundary validation | `graph boundary` |

## Guardrails

- **Name the functions, not their sizes.** Don't count lines, estimate sizes, or mention line counts. The difficulty is per-function.
- **Start writing.** If you're reading more than one function body before writing anything, that's over-analysis. The first function teaches you what the second needs.
- **Chains are not cycles.** A→B→C extracts bottom-up one at a time. Only A↔B needs batch extraction.
- **The compiler is faster than you.** Don't pre-solve imports or pre-classify every dep. Write, compile, read the errors.
- **Nothing is pre-existing.** Diagnostics and test failures are facts. Report them. The user triages.
- **Nothing is a blocker.** Check the dissolution table. It dissolves or you escalate.

## Reference

Dissolution decision tree, gotchas, and mechanical patterns: `references/dependency-patterns.md`.
