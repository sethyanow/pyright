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

**LSP is the primary extraction tool, not reading.** For each function, `outgoingCalls` gives you the complete dependency map — every closure ref, every external import, every intra-batch call, with exact file and line. This IS the dependency classification step. You don't need to read the function body to classify its dependencies; `outgoingCalls` already did it.

| LSP Operation | What it tells you | When to use |
|---|---|---|
| `outgoingCalls` | Complete dependency classification for a function | Before writing each function — this IS step 2 |
| `goToDefinition` | Which module exports an ambiguous symbol | When outgoingCalls shows a symbol you can't place |
| `incomingCalls` | How many callers a function has | Choosing delegation pattern (many callers = local stub, few = interface lambda) |
| `hover` | Function signatures | Wiring delegation params — confirm types match |

Read the function body only when you're ready to WRITE the transformed version — not before, not for "understanding."

## Phase 2: Extract Leaves (one at a time)

For each leaf function:

1. **Classify dependencies** — Run `outgoingCalls` on the function. The result classifies every call:

   | Resolves to | What it means | Transformation |
   |---|---|---|
   | Another extracted function | Intra-module call | Direct call, pass evaluator/registry/state through |
   | Closure function on TypeEvaluator interface | Evaluator method | `evaluator.xxx(...)` |
   | `registry.xxxClass` | Registry lookup | Needs `registry` param |
   | `state.xxxStack` / `state.xxxCache` | State access | Needs `state` param |
   | Function in types.ts, typeUtils.ts, etc. | External import | Add import statement |

   Use `goToDefinition` on ambiguous symbols to confirm which module they come from.

2. **Read and write the function** — Read the function body, transform it, append to the target module file via Edit. Add `export`, add the needed params (evaluator/registry/state) as first arguments, replace `evaluatorInterface` with `evaluator`, replace bare closure calls with `evaluator.xxx(...)`.

3. **Wire delegation** — In typeEvaluator.ts, replace the function body with a call to the extracted version. For functions over ~100 lines, use the **dead-rename technique**: match the signature + first unique lines, insert a delegation stub, rename the old function to `_functionName_dead`. Delete `_dead` functions after tests pass (bottom-up to avoid line shifts).

4. **Compile** — `npx tsc --noEmit`. Fix errors before moving to the next function. Don't pre-solve imports — add what you know, compile, fix what the compiler reports.

5. **Commit** — Each leaf extraction is one commit.

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
