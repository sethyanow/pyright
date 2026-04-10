---
id: pyr-zve
title: Implement inlayHintProvider with return types, variable types, and parameter names
status: open
type: task
priority: 1
parent: pyr-evw
---



## Context

Phase 4 of pyr-otr (R5). Follows the same provider pattern as Phase 3's semantic tokens: provider class in `languageService/`, wired into `languageServerBase.ts`, tested via fourslash.

The semantic tokens provider (`semanticTokensProvider.ts`) walks the parse tree and resolves types via the evaluator. Inlay hints use a similar walk but emit `InlayHint[]` at specific positions instead of classifying tokens.

**Blocked by:** pyr-mge (Phase 3 — closed)
**Unlocks:** Remaining Phase 4 criteria → acceptance → Phase 5

## Requirements

R1. Create `inlayHintProvider.ts` in `packages/pyright-internal/src/languageService/`
R2. Walk the parse tree, emit three kinds of hints:
  - **Return type hints:** on function defs without return annotations → show `: <inferred type>` after parameter list
  - **Variable type hints:** on assignments without type annotations → show `: <inferred type>` after variable name
  - **Parameter name hints:** at call sites → show `paramName=` before each argument
R3. Wire into `languageServerBase.ts`: capability registration (`inlayHintProvider: true`), connection handler (`connection.languages.inlayHint.on()`), handler method (`onInlayHint`)
R4. Add `verifyInlayHints` to fourslash test harness (`testState.ts` + `fourslash.d.ts`)
R5. Write fourslash tests covering all three hint types

## Implementation

### Step 1: Add verifyInlayHints to fourslash harness
- Add `verifyInlayHints(expected: { label: string; position: { line: number; character: number }; kind: string }[]): void` to `fourslash.d.ts`
- Implement in `testState.ts` — instantiate `InlayHintProvider`, call `getHints()`, compare against expected array
- Pattern: follow `verifySemanticTokens` implementation (testState.ts:1583)

### Step 2: Write failing fourslash test for return type hints
- File: `tests/fourslash/inlayHints.returnType.fourslash.ts`
- Python: `def add(x: int, y: int):` (no return annotation) → expect hint `: int` after `)` 
- Also test: function WITH annotation → no hint

### Step 3: Create InlayHintProvider skeleton
- File: `packages/pyright-internal/src/languageService/inlayHintProvider.ts`
- Class `InlayHintProvider` with constructor taking `ProgramView`, `Uri`, `CancellationToken`, `Range?`
- Method `getHints(): InlayHint[]`
- Internal walker class `InlayHintWalker extends ParseTreeWalker`
- Use `this._evaluator.getType()` and `this._evaluator.printType()` for type strings
- Return type hints: override `visitFunction`, check if return annotation missing, get inferred return type, emit `InlayHint` with `kind: InlayHintKind.Type` at position after `)`

### Step 4: Make return type test pass (GREEN)
- Implement `visitFunction` in the walker
- Run test to verify GREEN

### Step 5: Write failing fourslash test for variable type hints
- File: `tests/fourslash/inlayHints.variableType.fourslash.ts`
- Python: `x = 42` (no annotation) → expect hint `: int` after `x`
- Also test: `x: int = 42` (has annotation) → no hint

### Step 6: Implement variable type hints (GREEN)
- Override `visitAssignment` in the walker
- Check if target is a name without type annotation
- Get inferred type, emit hint

### Step 7: Write failing fourslash test for parameter name hints
- File: `tests/fourslash/inlayHints.parameterName.fourslash.ts`
- Python: `def greet(name: str, greeting: str): ...` then `greet("Alice", "Hello")` → expect `name=` and `greeting=` hints before args
- Also test: keyword args `greet(name="Alice")` → no hint (already named)

### Step 8: Implement parameter name hints (GREEN)
- Override `visitCall` in the walker
- Match positional args to parameter names
- Skip self/cls, skip kwargs, skip already-named args
- Emit `InlayHint` with `kind: InlayHintKind.Parameter` before each positional arg

### Step 9: Wire into languageServerBase.ts
- Import `InlayHintProvider` at top
- Add `inlayHintProvider: true` to capabilities (after `semanticTokensProvider`)
- Add `connection.languages.inlayHint.on()` in `setupConnection` (after semantic tokens block)
- Add `onInlayHint` handler method (pattern: `onSemanticTokensFull`)

### Step 10: Verify full suite + typecheck
- `cd packages/pyright-internal && npm run test:norebuild` → all pass
- `npm run typecheck` → clean
- Rebuild MCP bundle: `npm run build:cli:dev && cd packages/pyright-mcp && npm run webpack`

## Success Criteria

- [ ] `InlayHintProvider` class in `languageService/inlayHintProvider.ts`
- [ ] Return type hints on functions without return annotations
- [ ] Variable type hints on assignments without type annotations
- [ ] Parameter name hints at call sites (positional args only)
- [ ] `inlayHintProvider: true` in server capabilities
- [ ] `onInlayHint` handler wired in `languageServerBase.ts`
- [ ] `verifyInlayHints` in fourslash harness
- [ ] Fourslash tests for all three hint types
- [ ] Full test suite passes
- [ ] `npm run typecheck` clean

## Anti-Patterns

- Do NOT use syntax-only checks — resolve types through the evaluator
- Do NOT emit hints for annotated functions/variables — only where type is inferred
- Do NOT emit parameter name hints for keyword arguments — they're already named
- Do NOT add hints for `self`/`cls` parameters
