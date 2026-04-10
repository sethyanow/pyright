---
id: pyr-zve
title: Implement inlayHintProvider with return types, variable types, and parameter names
status: closed
type: task
priority: 1
owner: Seth
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
- Add `verifyInlayHints(expected: { label: string; position: { line: number; character: number }; kind: string }[]): void` to `src/tests/fourslash/typings/fourslash.d.ts`
- Implement in `src/tests/harness/fourslash/testState.ts` — instantiate `InlayHintProvider`, call `getHints()`, compare against expected array
- Pattern: follow `verifySemanticTokens` implementation (testState.ts:1583)
- Provider constructor pattern: `new InlayHintProvider(this.program, uri, CancellationToken.None, range?)`

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
- `AssignmentNode` only fires for unannotated assignments (`x = 42`). Annotated assignments (`x: int = 42`) parse as `TypeAnnotationNode` which wraps the assignment — so no annotation check needed
- Check `node.d.leftExpr.nodeType === ParseNodeType.Name` (skip tuple unpacking, subscript, etc.)
- Get inferred type via `evaluator.getType(node.d.leftExpr)`, format with `evaluator.printType()`
- Emit hint at position after the variable name

### Step 7: Write failing fourslash test for parameter name hints
- File: `tests/fourslash/inlayHints.parameterName.fourslash.ts`
- Python: `def greet(name: str, greeting: str): ...` then `greet("Alice", "Hello")` → expect `name=` and `greeting=` hints before args
- Also test: keyword args `greet(name="Alice")` → no hint (already named)

### Step 8: Implement parameter name hints (GREEN)
- Override `visitCall` in the walker
- Get callee type: `evaluator.getType(node.d.leftExpr)` → check `isFunction(type)` to get `FunctionType`
- For overloaded functions (`isOverloaded(type)`): use first overload's params (or skip — design decision)
- Access params via `type.shared.parameters` — `FunctionParam.name` gives param name, `FunctionParam.category` for `*args`/`**kwargs`
- For each positional arg (`arg.d.name === undefined`): match to param by index, skip `self`/`cls` (first param with method flag), skip `*args`/`**kwargs` category params
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

- [x] `InlayHintProvider` class in `languageService/inlayHintProvider.ts`
- [x] Return type hints on functions without return annotations
- [x] Variable type hints on assignments without type annotations
- [x] Parameter name hints at call sites (positional args only)
- [x] `inlayHintProvider: true` in server capabilities
- [x] `onInlayHint` handler wired in `languageServerBase.ts`
- [x] `verifyInlayHints` in fourslash harness
- [x] Fourslash tests for all three hint types
- [x] Parameter name hints work on constructor calls (ClassType → `__init__` params)
- [x] No hints on `@overload` decorated functions or `__init__` return types
- [x] Full test suite passes
- [x] `npm run typecheck` clean

## Edge Cases

- **Tuple unpacking:** `x, y = 1, 2` — leftExpr is not a NameNode, skip (only emit for simple `name = expr`)
- **`*args`/`**kwargs` params:** Don't emit param name hints for args that map to `*args`/`**kwargs`
- **Overloaded functions:** Use first overload's parameter names (Pylance behavior)
- **Lambda return types:** Lambdas don't have a `def` line — skip (no natural hint position)
- **Explicit `-> None` suppression:** If inferred return type is `None`, consider suppressing (Pylance suppresses these)
- **`for` loop variables:** `for x in items:` — not an AssignmentNode, skip naturally
- **Walrus operator:** `:=` — not an AssignmentNode, skip naturally

## Key Considerations (Failure Catalog)

### visitFunction — return type hints
- **Stub/overload/dunder skip list:** Functions without `returnAnnotation` include stubs, `@overload`-decorated functions, `__init__`/`__new__`, and functions with `funcAnnotationComment` (PEP 3107 comments). These should NOT get hints. Check `funcAnnotationComment` as alternative annotation. Skip `__init__`/`__new__` (return type always known). Skip `@overload` decorated functions.
- **Evaluator return types:** `getType(node.d.name)` may return `OverloadedType` — guard with `isFunction()`. `inferredReturnType` is lazy and may be undefined. Use `shared.declaredReturnType ?? shared.inferredReturnType?.type` — skip if neither exists. Filter out `Unknown`/`Never` types.

### visitCall — parameter name hints
- **Constructor calls:** `getType(node.d.leftExpr)` returns `ClassType` for constructor calls, not `FunctionType`. Must look up `__init__`/`__new__` to get param names. For union types, skip (ambiguous).
- **Star-args at call site:** `func(*my_list)` has `argCategory !== ArgCategory.Simple`. Once a star-arg is encountered, stop emitting param hints for remaining args (position mapping breaks).
- **Callable objects:** Objects with `__call__` return `ClassType` — look up `__call__` method for params.

### visitAssignment — variable type hints  
- **NameNode check handles most cases:** `self.x`, subscripts, tuple unpacking all have non-Name leftExpr — naturally skipped. Chained `x = y = 42` produces nested AssignmentNodes but each has a NameNode left — acceptable to hint both.

### onInlayHint handler
- **Range parameter bounds output:** `InlayHintParams` includes a `range` — pass to provider constructor. Walker walks full tree but only emits hints within range (same pattern as semantic tokens).

## Anti-Patterns

- Do NOT use syntax-only checks — resolve types through the evaluator
- Do NOT emit hints for annotated functions/variables — only where type is inferred
- Do NOT emit parameter name hints for keyword arguments — they're already named
- Do NOT add hints for `self`/`cls` parameters

## Log

- [2026-04-10T04:36:12Z] [Seth] Completed. Created inlayHintProvider.ts with 3 hint types (return type, variable type, parameter name). Wired in languageServerBase.ts. 4 fourslash tests (3 functional + 1 adversarial). Key discovery: FunctionType.isInstanceMethod() returns true for regular functions — used methodClass/strippedFirstParamType for self/cls detection instead. Constructor calls resolved via lookUpClassMember + getEffectiveTypeOfSymbol. All 2379 tests pass, typecheck clean.
