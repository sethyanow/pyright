---
id: pyr-qzi
title: Implement InlayHintProvider + server wiring + fourslash tests
status: open
type: task
priority: 1
parent: pyr-evw
---



## Requirements

R5 from parent epic: `textDocument/inlayHint` — show inferred return types, variable types, and parameter names at call sites.

**Blocked by:** Nothing — Phase 3 closed, Phase 4 unblocked.
**Unlocks:** Phase 4 acceptance task → Phase 4 closure → Phase 5 (Code Lens).

## Context

Greenfield — no inlay hint code exists in the codebase. Follow the Phase 3 (semantic tokens) provider pattern:
1. Provider class in `languageService/inlayHintsProvider.ts`
2. Handler methods in `languageServerBase.ts`
3. Capability registration in server capabilities
4. Fourslash test harness helper + fourslash test files
5. MCP adapter already passes through arbitrary LSP methods — no adapter changes needed

The `connection.languages.inlayHint.on(handler)` API handles request routing. `InlayHintKind.Type = 1` for type annotations, `InlayHintKind.Parameter = 2` for parameter names. Client capabilities already advertised in test utils.

## Implementation

### Step 1: Write fourslash harness helper `verifyInlayHints`

**File:** `packages/pyright-internal/src/tests/harness/fourslash/testState.ts`

Add `verifyInlayHints(map: { [marker: string]: { label: string; kind: 'type' | 'parameter' } })` method. Pattern: instantiate `InlayHintsProvider`, call `getHints()`, match results against marker positions. Each marker maps to expected label text and kind.

Also add declaration to `packages/pyright-internal/src/tests/fourslash/typings/fourslash.d.ts`.

### Step 2: Write fourslash test — return type inference

**File:** `packages/pyright-internal/src/tests/fourslash/inlayHints.returnType.fourslash.ts`

Python code with functions that have no return type annotation. Markers at function def positions. Expected: `InlayHintKind.Type` with the inferred return type as label (e.g., `-> int`, `-> str`, `-> None`).

Functions with explicit return annotations should NOT produce hints.

### Step 3: Write fourslash test — variable type inference

**File:** `packages/pyright-internal/src/tests/fourslash/inlayHints.variableType.fourslash.ts`

Assignments without type annotations: `x = 42`, `name = "hello"`, `items = [1,2,3]`. Markers at variable name positions. Expected: `InlayHintKind.Type` with inferred type.

Annotated variables (`x: int = 42`) should NOT produce hints.

### Step 4: Write fourslash test — parameter names at call sites

**File:** `packages/pyright-internal/src/tests/fourslash/inlayHints.parameterNames.fourslash.ts`

Function calls with positional args: `process(42, "hello")`. Markers at argument positions. Expected: `InlayHintKind.Parameter` with parameter name as label (e.g., `x:`, `msg:`).

Named arguments (`process(x=42)`) should NOT produce hints since the name is already visible.

### Step 5: Run tests — should fail (RED)

```bash
cd packages/pyright-internal && npx jest fourSlashRunner.test --forceExit
```

Tests fail because `InlayHintsProvider` doesn't exist and `verifyInlayHints` calls it.

### Step 6: Implement `InlayHintsProvider`

**File:** `packages/pyright-internal/src/languageService/inlayHintsProvider.ts`

Class `InlayHintsProvider` with constructor `(program: ProgramView, fileUri: Uri, range: Range, token: CancellationToken)`.

Method `getHints(): InlayHint[]` — walks the AST within the given range:

1. **Return type hints:** Visit `FunctionNode`. If no return type annotation, use evaluator to get the inferred return type. Emit `InlayHintKind.Type` hint at end of parameter list with label `-> <type>`.

2. **Variable type hints:** Visit assignment nodes (`AssignmentNode`). If LHS is a simple name without type annotation, infer the type. Emit `InlayHintKind.Type` hint after the name with label `: <type>`.

3. **Parameter name hints:** Visit `CallNode`. For each positional argument, resolve the call target to get parameter names. Emit `InlayHintKind.Parameter` hint before each argument with label `<paramName>:`.

Use `ParseTreeWalker` like `SemanticTokenWalker`. Get `TypeEvaluator` from `program.evaluator`. Use `evaluator.getType()` for type inference, `printType()` for string representation.

### Step 7: Wire handler in `languageServerBase.ts`

**File:** `packages/pyright-internal/src/languageServerBase.ts`

1. Import `InlayHintsProvider` and LSP types (`InlayHint`, `InlayHintParams`)
2. Register handler: `this.connection.languages.inlayHint.on(async (params, token) => this.onInlayHints(params, token))`
3. Register capability: `inlayHintProvider: true` in server capabilities
4. Implement `onInlayHints` method following the `onSemanticTokensFull` pattern — get program, get URI, instantiate provider, return results.

### Step 8: Run tests — should pass (GREEN)

```bash
cd packages/pyright-internal && npx jest fourSlashRunner.test --forceExit
```

All inlay hint fourslash tests pass.

### Step 9: Run full test suite + typecheck

```bash
npm run typecheck 2>&1 > /tmp/typecheck.out && echo PASS || echo FAIL
cd packages/pyright-internal && npm run test:norebuild 2>&1 > /tmp/tests.out && echo PASS || echo FAIL
```

### Step 10: Commit and push

## Success Criteria

- [ ] `textDocument/inlayHint` registered in server capabilities
- [ ] `InlayHintsProvider.getHints()` returns `InlayHint[]` for a given file range
- [ ] Return type hints emitted for unannotated functions
- [ ] Variable type hints emitted for unannotated assignments
- [ ] Parameter name hints emitted at call sites with positional args
- [ ] No hints for explicitly annotated functions/variables or named arguments
- [ ] Fourslash tests: return type, variable type, parameter names
- [ ] Full test suite passes
- [ ] `npm run typecheck` clean

## Anti-Patterns

- Don't walk the AST with syntax-only checks — resolve through the type evaluator
- Don't emit hints where annotations already exist — that's noise, not information
- Don't build provider logic in the MCP adapter — the adapter passes through LSP methods
