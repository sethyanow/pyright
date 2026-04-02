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

## Phase 2: Extract Leaves (one at a time)

For each leaf function:

1. **Get the body** — ChunkHound regex search gives complete functions for small/medium ones (with exact start/end lines). Large functions (~800+ lines) only return the first ~30 lines as a chunk — use `Read` with offset+limit from the ChunkHound start line to the next function's start. To find function end lines, `documentSymbol` on the whole file returns every function boundary (large output, cache it once per session).

2. **Classify dependencies** — The `outgoingCalls` result from Phase 1 already has this. For each call in `typeEvaluator.ts`, it resolves to one of:

   | Resolves to | What it means | Transformation |
   |---|---|---|
   | Another extracted function | Intra-module call | Direct call, pass evaluator/registry/state through |
   | Closure function on TypeEvaluator interface | Evaluator method | `evaluator.xxx(...)` |
   | `registry.xxxClass` | Registry lookup | Needs `registry` param |
   | `state.xxxStack` / `state.xxxCache` | State access | Needs `state` param |
   | Function in types.ts, typeUtils.ts, etc. | External import | Add import statement |

   Use `goToDefinition` on any call site to confirm the classification. Use `hover` to check signatures when wiring delegation.

3. **Write the function** — Append to the target module file via Edit. Add `export`, add the needed params (evaluator/registry/state) as first arguments, replace `evaluatorInterface` with `evaluator`, replace bare closure calls with `evaluator.xxx(...)`.

4. **Wire delegation** — In typeEvaluator.ts, replace the function body with a call to the extracted version. Use `incomingCalls` to check how many callers exist — if many, keep a local delegate function. If only called from the interface object, a lambda in the interface is sufficient.

5. **Compile** — `npx tsc --noEmit`. Fix errors before moving to the next function.

6. **Commit** — Each leaf extraction is one commit.

## Phase 3: Extract the Cycle

Same per-function analysis as Phase 2, but:

- Write ALL cycle functions to the target file before compiling
- Wire ALL delegations in typeEvaluator.ts before compiling
- Then compile once and fix
- One commit for the entire cycle

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
- Estimating the total line count of the extraction

## File Safety

- **Always append via Edit, never overwrite via Write or Bash redirects**
- **Untracked files have no git recovery** — if the target module isn't committed, a bad Write destroys it permanently
- **Commit after each leaf extraction** — this creates recovery points
- **Never use sed/cat/bash to create or modify source files**

## Reference

For the dependency classification table with project-specific details, see `references/dependency-patterns.md`.
