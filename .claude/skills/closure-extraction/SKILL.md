---
name: closure-extraction
description: This skill should be used when extracting functions from the createTypeEvaluator closure into standalone modules. Invoke at session start alongside executing-plans for any pyr-a56 subtask.
---

# Closure Extraction

Extract functions from `createTypeEvaluator()` into standalone module files, following the pattern established by `specialForms.ts`.

**Rigidity: MEDIUM** — Phase 1 (mapping) provides a starting point. The extraction order emerges from doing the work.

## Prerequisites

- Active bones task with a function inventory (function names — line numbers are stale, use `rg` to find current positions)
- LSP warm (run `documentSymbol` on a real source file if needed)
- Target module file either doesn't exist yet or has been committed in its current state

## Phase 1: Map the Dependency Graph

**No code changes in this phase.** The output is a starting extraction order — expect it to change.

For each function in the task's inventory, find its current line with `rg -n 'function funcName\b'`, then:

```
LSP prepareCallHierarchy on the function name
LSP outgoingCalls from that position
```

**Tip:** `prepareCallHierarchy` is line-sensitive — off by one and it returns nothing. Always use `rg` to get the current line first. Lines shift during extraction.

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

**Critical: check for hidden dependencies.** For each function's closure deps that are NOT in the batch, run `incomingCalls` on them. If a closure dep has only 1-2 callers and they're all in the batch, that function should come along — it's the connective tissue. This is how getTypeOfClassMemberName was discovered mid-session in pyr-p1w: it wasn't in the inventory but was the sole connector between batch members.

**Extraction order:** Leaves first, then the cycle as one batch, then post-leaves. But this is a starting point — the order refines as you extract.

Log the extraction order to bones before writing any code.

## LSP Drives Extraction

**LSP is the primary extraction tool, not reading.**

| LSP Operation | What it tells you | When to use |
|---|---|---|
| `outgoingCalls` | Every call a function makes — the dependency map | Before writing each function |
| `hover` | Signatures, types, interface membership — instantly | Checking if a dep is on the interface (hover the closure function, see if it resolves to typeEvaluatorTypes.ts). Checking param signatures match. Understanding any symbol without reading its source. **Use liberally — it's magic.** |
| `incomingCalls` | Who calls this function, and how many callers | Discovering hidden deps that should join the batch. Choosing delegation pattern. Verifying delegates have zero callers before deletion. |
| `goToDefinition` | Which module exports a symbol | When the compiler reports a missing import — trace to the right source file |
| `prepareCallHierarchy` | Exact function position for call hierarchy | Always precede with `rg -n` to get current line number |
| `findReferences` | Usage count across workspace | Rarely needed — incomingCalls is usually better |

**Do NOT use `workspaceSymbol`.** It returns 1MB of every symbol in the workspace. You never need all symbols. Use `documentSymbol` for a file map, `hover` for individual symbols, `rg` for line numbers.

**LSP blind spot:** `outgoingCalls` misses property access chains on closure variables. Example: `codeFlowEngine.createCodeFlowAnalyzer()` won't appear. **Always read the function body** after outgoingCalls to catch closure variable property access.

## Dependency Dissolution

**Most closure deps that look blocking dissolve when you check them.** Before classifying ANY dep as a blocker, run this check:

For each outgoing call that resolves to typeEvaluator.ts:

1. **State wrapper?** Many closure functions are thin wrappers: `function readTypeCache(...) { return state.readTypeCache(...); }`. The extracted function calls `state.xxx()` directly. Common state wrappers: `readTypeCache`, `writeTypeCache`, `pushSymbolResolution`, `popSymbolResolution`, `suppressDiagnostics`, `disableSpeculativeMode`, `isSpeculativeModeInUse`, `isTypeCached`.

2. **On TypeEvaluator interface?** Use `hover` on the closure function. If it shows a signature from typeEvaluatorTypes.ts, it's on the interface → call `evaluator.xxx()`.

3. **Already extracted?** If the function is in symbolResolution.ts, memberAccess.ts, or another extracted module, call it directly.

4. **Pure function?** Run `outgoingCalls` on the dep ITSELF. If it has zero closure deps, it can be extracted alongside.

5. **Nested function?** If it's defined inside the function being extracted, it comes along for free.

6. **Stored on state?** `importLookup` and `codeFlowEngine` are on `TypeEvaluatorState`.

7. **One-liner wrapper?** Some closure functions just wrap an already-extracted function or external utility. Call the underlying function directly instead of going through the closure wrapper. See the one-liner dissolution table in `references/dependency-patterns.md`.

**Only after all checks fail** is a dep genuinely blocking. Add it to the interface or extract it first.

**The dissolution cascade:** When a dep dissolves, re-check everything it was blocking.

**Prior session logs are claims to verify.** Never trust a log that says "deferred — deep closure deps." Run outgoingCalls fresh.

## Phase 2: Extract Functions (one at a time)

**The per-function loop is tight.** `outgoingCalls` + `Read` of the function body → write. The dissolution table in `references/dependency-patterns.md` handles classification. Don't pre-read deps, don't pre-read callers.

For each function:

1. **outgoingCalls** — Run it. For each call that resolves to typeEvaluator.ts, check the dissolution table:
   - State wrapper? → `state.xxx()`
   - On interface? (use `hover` to verify) → `evaluator.xxx()`
   - Already in target module? → direct call
   - External import? → add import
   - Not in any category? → Run the dissolution check. If a non-batch dep has only 1-2 callers in the batch (`incomingCalls`), consider extracting it alongside.

2. **Read and write** — Read the function body. Transform: add `export`, add params (evaluator/state/registry as needed), replace closure calls per step 1. Append to target module via Edit.

3. **Wire delegation** — Replace the function body in typeEvaluator.ts with a one-line call. For large functions, use the **dead-rename technique**: insert a delegation stub, rename the old to `_functionName_dead`. Delete the dead function after tests pass.

4. **Compile** — Trust live diagnostics first. They update within a tool call and tell you exactly what's wrong. Run `npm run typecheck` only when live diagnostics are clean and you want belt-and-suspenders confirmation. Don't pre-solve imports — write what you know, let the compiler report what's missing.

5. **Test** — Run targeted tests: `cd packages/pyright-internal && npx jest typeEvaluator1.test typeEvaluator2.test checker.test --forceExit`. If tests fail:
   - **STOP.** Don't proceed.
   - Use `hover` on both closure and interface signatures — look for optional param mismatches.
   - If you can't find the cause, ask the user.

6. **Commit** — Each extraction is one commit. Run `npm run check` periodically (every 2-3 extractions) for eslint/prettier.

## Phase 3: Extract the Cycle

Same per-function analysis as Phase 2, but:

- Write ALL cycle functions to the target file before compiling
- Wire ALL delegations in typeEvaluator.ts before compiling
- Then compile once and fix
- One commit for the cycle wiring, then delete dead functions in a second commit

**"Write ALL" means accumulate sequentially** — write one function, then the next. It does NOT mean understand all functions first. The cadence is: `outgoingCalls` on function → read body → transform → append → next function. The compile step waits; the understanding step does not batch.

**The cycle is not as hard as it looks.** The anticipation of complexity is the actual blocker, not the complexity itself. Each function in the cycle follows the same read-transform-write pattern. Dead-rename makes wiring mechanical.

## Phase 4: Extract Post-Leaves

Same as Phase 2 — one at a time, compile after each, commit after each.

## Per-Function Checklist

- [ ] `outgoingCalls` reviewed
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

**Signs of panic-scaling:**
- Reading more than one function body before writing anything
- "I need to understand the full picture first"
- Counting or mentioning line counts — the difficulty is per-function, not aggregate
- The "I'm ready to write" feeling immediately followed by "let me trace one more dep" — that pivot IS the trap
- Using `workspaceSymbol` for anything
- Spawning agents for mechanical work

## Circular Import Avoidance

When a type or interface defined in typeEvaluator.ts is needed by the extracted module, redefine it locally. Importing from typeEvaluator.ts creates a circular dependency. Example: `MemberAccessTypeResult` was redefined in memberAccess.ts rather than imported.

## File Safety

- **Always append via Edit, never overwrite via Write or Bash redirects**
- **Untracked files have no git recovery** — commit after each leaf extraction
- **Never use sed/cat/bash to create or modify source files** (sed for deleting dead functions after commit is acceptable)

## Reference

For the dependency classification table with project-specific details, see `references/dependency-patterns.md`.
