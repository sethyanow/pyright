# Dependency Dissolution Patterns

When `graph walk` shows a call into typeEvaluator.ts, work this decision tree top to bottom. Most deps dissolve before step 5.

## Decision Tree

**1. State wrapper?** → `graph walk` depth=1 on the dep. If it calls only `state.*` methods, replace with `state.xxx()` directly. The full list of state wrappers: readTypeCache, writeTypeCache, isTypeCached, pushSymbolResolution, popSymbolResolution, suppressDiagnostics, disableSpeculativeMode, isSpeculativeModeInUse, isNodeInReturnTypeInferenceContext, getCodeFlowAnalyzerForReturnTypeInferenceContext.

**2. On the interface?** → LSP `hover` on the closure function. If it resolves to typeEvaluatorTypes.ts, use `evaluator.xxx()`. ChunkHound can't check this — hover is the only way.

**3. One-liner wrapper?** → `graph walk` depth=1. Exactly 1 outgoing call to an extracted module or utility? Call the underlying function directly, skip the wrapper.

**4. Already extracted?** → `search symbols` for the function name. If it's in an extracted module, import directly.

**5. Pure function?** → `graph walk` depth=1 on the dep itself. Zero closure deps? Extract it alongside — it's free.

**6. Sole connector?** → `graph walk` with `called_by` on the dep. If 1-2 callers, all in your batch, it must come along. This is how hidden batch members get discovered.

**7. Genuinely blocking** → Add to the interface, extract the dep first, or leave this function in the closure. Escalate to the user if unclear.

## Gotchas That Cost Time

**Interface param mismatch.** Closure functions sometimes have optional params not on the interface. LSP `hover` on BOTH the closure function AND the interface definition. If signatures differ, the extracted function needs the closure signature, not the interface one.

**`graph walk` misses property access chains.** `codeFlowEngine.createCodeFlowAnalyzer()` won't appear in outgoingCalls or graph edges. Always read the function body after graph walk to catch `state.xxx.yyy()` chains and closure variable property access.

**Circular imports are silent.** TypeScript won't error on circular imports at compile time — they manifest as runtime `undefined`. Never import from typeEvaluator.ts in extracted modules. If a type defined there is needed, redefine it locally. (Example: `MemberAccessTypeResult` was redefined in memberAccess.ts.)

**assignType has 82 internal callers.** Any function with that many closure callers needs a local delegation stub. Use `graph walk` with `called_by` to check caller count before deciding delegation pattern.

**Dead-rename prevents lost work.** For large functions: insert delegation stub first, rename old body to `_functionName_dead`, run tests, THEN delete dead function in a separate commit. Never delete the original before tests pass on the delegation.

**`evaluatorInterface` → `evaluator` rename is everywhere.** Inside the closure it's `evaluatorInterface`. In extracted modules the convention is `evaluator`. This includes when passed as an argument to other functions — `assignTypedDictToTypedDict(evaluatorInterface, ...)` becomes `evaluator`.

**Module-level constants don't come for free.** `typePromotions` and `maxRecursiveTypeAliasRecursionCount` are defined in typeEvaluator.ts outside the closure. They need to be duplicated in the target module.

## What Stays in the Closure

The decision boundary: if a function calls non-interface closure helpers that touch expression evaluation internals (getTypeOfIndexWithBaseType, isFinalAllowedForAssignmentTarget, reportPossibleUnknownAssignment), it stays. Specifically:

- `assignTypeTo*` functions — call writeTypeCache + non-interface expression evaluation helpers
- `getTypeOf*` / `evaluateTypesFor*` orchestration — the genuine dispatcher
- `narrowConstrainedTypeVar` — hard dep on codeFlowEngine created post-construction

If you're unsure whether something stays: `graph walk` depth=2 with `calls`. If the transitive deps include expression evaluation functions not on the interface, it stays. If everything dissolves through the decision tree above, it goes.
