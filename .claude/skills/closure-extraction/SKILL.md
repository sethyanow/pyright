---
name: closure-extraction
description: This skill should be used when extracting functions from the createTypeEvaluator closure into standalone modules. Invoke at session start alongside executing-plans for any pyr-a56 subtask.
---

# Closure Extraction

Extract functions from `createTypeEvaluator()` into standalone module files, following the pattern established by `specialForms.ts`.

**Rigidity: MEDIUM** — Phase 1 (mapping) is mandatory before any code changes. Phases 2-4 follow the map.

## Prerequisites

- Active bones task with a function inventory (line numbers, function names)
- LSP warm (run `documentSymbol` on a source file if needed)
- Target module file either doesn't exist yet or has been committed in its current state

## Phase 1: Map the Dependency Graph

**No code changes in this phase.** The output is an extraction order.

For each function in the task's inventory, run `outgoingCalls`:

```
LSP prepareCallHierarchy on the function name
LSP outgoingCalls from that position
```

**Tip:** `prepareCallHierarchy` is line-sensitive — off by one and it returns nothing. Use ChunkHound regex or a quick `Read` to confirm the exact line before calling it.

Filter the results to only calls between functions in the extraction batch. Build a table:

```
| Function | Calls within batch |
|---|---|
| assignType | assignClass, assignFunction, ... |
| isSpecialFormClass | (none) |
```

From that table, identify:

1. **Leaves** — functions with zero intra-batch calls. These can be extracted one at a time.
2. **The cycle** — trace the arrows. If A calls B and B (transitively) calls A, they're in the same cycle. All functions in any cycle form the "must extract together" set.
3. **Post-leaves** — functions that call into the cycle but nothing in the cycle calls them. Extract after the cycle.

**Tips for finding cycles:** Start from the biggest function (usually the main `assign*` dispatcher). Follow its outgoing batch calls. For each, check if any path leads back. Most small helpers are leaves. The cycle is usually obvious — it's the core recursive dispatch chain.

**Extraction order:** Leaves first, then the cycle as one batch, then post-leaves.

Log the extraction order to bones before writing any code.

## LSP Drives Extraction

**LSP is the primary extraction tool, not reading.** For each function, `outgoingCalls` gives you the dependency map — every closure ref, every external import, every intra-batch call, with exact file and line.

| LSP Operation | What it tells you | When to use |
|---|---|---|
| `outgoingCalls` | Dependency classification for a function | Before writing each function — this IS step 2 |
| `goToDefinition` | Which module exports an ambiguous symbol | When outgoingCalls shows a symbol you can't place |
| `incomingCalls` | How many callers a function has | Choosing delegation pattern (many callers = local stub, few = interface lambda) |
| `hover` | Function signatures | Wiring delegation params — confirm types match |

**LSP blind spot:** `outgoingCalls` misses property access chains on closure variables. Example: `codeFlowEngine.createCodeFlowAnalyzer()` won't appear in the results because it's a method call on an object, not a direct function call. **Always read the function body** after outgoingCalls to catch closure variable property access that LSP won't report.

Read the function body when you're ready to WRITE the transformed version, and to catch closure variable access that outgoingCalls missed.

## Dependency Dissolution

**Most closure deps that look blocking dissolve when you check them.** Before classifying ANY dep as a blocker, run this check:

For each outgoing call that resolves to typeEvaluator.ts:

1. **State wrapper?** Check lines ~570-610 in typeEvaluator.ts. Many closure functions are thin wrappers: `function readTypeCache(...) { return state.readTypeCache(...); }`. The extracted function calls `state.xxx()` directly. Common state wrappers: `readTypeCache`, `writeTypeCache`, `pushSymbolResolution`, `popSymbolResolution`, `suppressDiagnostics`, `disableSpeculativeMode`, `isSpeculativeModeInUse`, `isTypeCached`.

2. **On TypeEvaluator interface?** Run `documentSymbol` on `typeEvaluatorTypes.ts` and search. If yes, call `evaluator.xxx()`.

3. **Already extracted?** If the function is in symbolResolution.ts or another extracted module, call it directly as an intra-module call.

4. **Pure function?** Run `outgoingCalls` on the dep ITSELF. If it has zero closure deps, it can be extracted alongside as a helper or standalone function.

5. **Nested function?** If it's defined inside the function being extracted (not a separate closure function), it comes along for free.

6. **Stored on state?** `importLookup` and `codeFlowEngine` are stored on `TypeEvaluatorState`. Access via `state.importLookup` and `state.codeFlowEngine`.

**Only after all six checks fail** is a dep genuinely blocking. At that point: add it to the TypeEvaluator interface (if it's an evaluation entry point) or extract it first.

**The dissolution cascade:** When a dep dissolves, re-check everything it was blocking. One dissolved dep can unblock several functions previously classified as "too entangled."

**Prior session logs are claims to verify.** Never trust a log that says "deferred — deep closure deps." Run outgoingCalls fresh.

## Phase 2: Extract Functions (one at a time)

**The per-function loop is tight.** Two tool calls before writing: one `outgoingCalls`, one `Read` of the function body. That's it. Do not read deps, do not read callers, do not "understand the context." The outgoingCalls result + the dissolution table in `references/dependency-patterns.md` tell you everything you need to transform the function.

For each function:

1. **outgoingCalls** — Run it. For each call that resolves to typeEvaluator.ts, check the dissolution table in `references/dependency-patterns.md`:
   - In the state wrappers table? → `state.xxx()`
   - In the stored dependencies table? → `state.importLookup`, `state.codeFlowEngine`
   - On the TypeEvaluator interface? → `evaluator.xxx()`
   - Already in the target module? → direct intra-module call
   - External import (types.ts, typeUtils.ts, etc.)? → add import

   If a dep isn't in any of these categories, run the 6-step dissolution check from the Dependency Dissolution section above. Don't read the dep's source — just run outgoingCalls on IT.

2. **Read and write** — Read the function body. Transform it: add `export`, add params (evaluator/state as needed), replace closure calls per step 1. Append to target module via Edit.

3. **Wire delegation** — Replace the function body in typeEvaluator.ts with a one-line call to the extracted version. For large functions, use the **dead-rename technique**: insert a delegation stub above the old function, rename the old to `_functionName_dead`. After tests pass, delete the entire `_dead` function in one Edit (match from its `function _xxx_dead(` to the closing `}`). Don't try to suppress unused-param warnings in the dead copy — just delete it whole.

4. **Compile** — `npm run typecheck`. Fix errors before moving to the next function. Don't pre-solve imports — add what you know, compile, fix what the compiler reports.

5. **Test** — Run targeted tests after each extraction: `cd packages/pyright-internal && npx jest typeEvaluator1.test typeEvaluator2.test checker.test --forceExit`. Clean compile does NOT mean correct extraction — interface signatures may be missing optional params that silently change behavior. If tests fail:
   - **STOP.** Don't proceed with failing tests.
   - Check interface signatures against closure function signatures — use `hover` on both. Look for optional params with non-obvious defaults (especially booleans where the closure passes `false` but the interface default is `true`).
   - If you can't find the cause, ask the user whether to revert.
   - Never proceed to the next function with a failing test.

6. **Commit** — Each extraction is one commit. Run `npm run check` periodically (every 2-3 extractions) to catch eslint/prettier drift before it accumulates.

## Phase 3: Extract the Cycle

Same per-function analysis as Phase 2, but:

- Write ALL cycle functions to the target file before compiling
- Wire ALL delegations in typeEvaluator.ts before compiling
- Then compile once and fix
- One commit for the entire cycle

**"Write ALL" means accumulate sequentially** — write one function, then the next. It does NOT mean understand all functions first. The cadence is: `outgoingCalls` on function → read body → transform → append → next function. The compile step waits until all are written; the understanding step does not batch.

This is the only justified batch operation. It's bounded by the dependency graph, not by convenience.

## Phase 4: Extract Post-Leaves

Same as Phase 2 — one at a time, compile after each, commit after each.

## Per-Function Checklist

- [ ] `outgoingCalls` reviewed (from Phase 1 map)
- [ ] Each outgoing call classified (evaluator / registry / state / intra-module / external)
- [ ] Function signature has correct params
- [ ] Body transformed (closure refs replaced)
- [ ] Appended to target file (never overwrite)
- [ ] Delegation wired in typeEvaluator.ts
- [ ] Compiles clean
- [ ] Committed

## Panic Check

**Before touching more than one function at a time, ask:**

> Is this the cycle batch from my Phase 1 map, or am I inventing reasons to go bigger?

If you can't point to the specific cycle in your dependency table that justifies the batch — you're panic-scaling. Stop. Go back to one function at a time.

**Other signs of panic-scaling:**
- Reaching for sed, cat, or bash pipelines to "extract" code
- Reading more than one function body before writing anything
- The phrase "I need to understand the full picture first"
- Counting or mentioning line counts. Line counts are planning noise — the difficulty of extraction is per-function (read, transform, write), not aggregate. If you catch yourself saying "~2500 lines remaining," you're not planning, you're catastrophizing.
- Spawning agents for mechanical work you should do yourself

## File Safety

- **Always append via Edit, never overwrite via Write or Bash redirects**
- **Untracked files have no git recovery** — if the target module isn't committed, a bad Write destroys it permanently
- **Commit after each leaf extraction** — this creates recovery points
- **Never use sed/cat/bash to create or modify source files**

## Reference

For the dependency classification table with project-specific details, see `references/dependency-patterns.md`.
