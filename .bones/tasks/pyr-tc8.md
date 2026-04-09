---
id: pyr-tc8
title: Implement SemanticTokensProvider with full/range support
status: open
type: task
priority: 1
parent: pyr-mge
---

## Context

First task in Phase 3 (pyr-mge: Semantic Tokens). No prior semantic tokens infrastructure exists in this fork. The provider must resolve each name node through the type evaluator to determine its classification — syntax-only matching is forbidden per the parent epic's anti-patterns.

**Blocked by:** pyr-lfw (closed — Phase 2 complete)
**Unlocks:** Phase 3 acceptance task → pyr-mge closure → pyr-evw (Phase 4: Inlay Hints)

## Requirements

From parent epic R4: `textDocument/semanticTokens/full` and `/range` — classify every resolved symbol for semantic highlighting.

Token types required: class, function, parameter, typeParameter, variable, property, decorator, method, namespace, enum, enumMember.

## Design

### Provider: `packages/pyright-internal/src/languageService/semanticTokensProvider.ts`

A `SemanticTokensProvider` class that:
1. Takes `ProgramView`, `Uri`, optional `Range`, `CancellationToken`
2. Gets `ParseFileResults` for the file
3. Walks all `Name` nodes using `ParseTreeUtils.getNodeIterator` or a recursive walk
4. For each `Name` node, calls `evaluator.getDeclInfoForNameNode(node)` to resolve its declaration
5. Maps `DeclarationType` + context to `SemanticTokenTypes`:
   - `DeclarationType.Class` / `SpecialBuiltInClass` → `SemanticTokenTypes.class`
   - `DeclarationType.Function` → `method` if parent is Class, else `function`
   - `DeclarationType.Param` → `parameter`
   - `DeclarationType.TypeParam` → `typeParameter`
   - `DeclarationType.Variable` → `variable` (or `property` if parent is Class)
   - `DeclarationType.TypeAlias` → `type`
   - `DeclarationType.Alias` → resolve through `resolveAliasDeclaration`, then re-classify
   - Decorator nodes → `decorator`
   - Module-level names imported as namespace → `namespace`
   - Enum members → `enumMember` (check if class is `Enum` subclass)
6. Uses `SemanticTokensBuilder` from `vscode-languageserver` to encode tokens
7. For `/range` requests, filters tokens to only those within the requested range

### Token Legend

Register a `SemanticTokensLegend` in capabilities with the token types and modifiers arrays. The legend maps array indices to token type strings.

### Wiring: `languageServerBase.ts`

- Register `semanticTokensProvider` in capabilities with `full: true`, `range: true`, and the legend
- Wire `connection.languages.semanticTokens.on(...)` → `onSemanticTokensFull`
- Wire `connection.languages.semanticTokens.onRange(...)` → `onSemanticTokensRange`
- Handler methods create `SemanticTokensProvider` and call `getTokens()`

### Test Harness

Add `verifySemanticTokens` to `testState.ts` and `fourslash.d.ts`:
- Takes a map of marker names to expected token classifications at that position
- Creates provider, gets tokens, decodes, finds token at marker position, asserts type matches

## Implementation Steps

### Step 1: Write fourslash test for mixed symbol classification
Create `semanticTokens.basic.fourslash.ts` with a Python file containing class, function, parameter, variable, decorator, and type parameter — each at a marker. Assert each marker resolves to the correct SemanticTokenType.

### Step 2: Add test harness method `verifySemanticTokens`
In `testState.ts`: create provider, get full tokens, decode the delta-encoded array, find the token at each marker position, assert token type matches expected. Add declaration to `fourslash.d.ts`.

### Step 3: Run test — should fail (provider doesn't exist yet)

### Step 4: Create `semanticTokensProvider.ts`
Walk Name nodes, resolve via `getDeclInfoForNameNode`, map DeclarationType to SemanticTokenTypes, build with `SemanticTokensBuilder`. Support optional range filtering.

### Step 5: Run test — should pass

### Step 6: Write fourslash test for type-dependent classification
Create `semanticTokens.typeDependentClassification.fourslash.ts` — a name that's used as a class in one context and as a variable in another. This is the critical test from the parent epic: "a name that's a class in one context and a variable in another must be classified differently."

### Step 7: Run test — verify it passes (or fix classification logic)

### Step 8: Wire handlers in `languageServerBase.ts`
Register `semanticTokensProvider` capability with legend, wire `on` and `onRange` handlers. Add round-trip test verifying the handler path returns encoded tokens.

### Step 9: Run full test suite, typecheck, commit

## Success Criteria

- [ ] `textDocument/semanticTokens/full` registered in capabilities, returns token classifications
- [ ] `textDocument/semanticTokens/range` returns classifications for a given range
- [ ] Tokens classified by resolved type, not syntax — type-dependent classification test passes
- [ ] Token types covered: class, function, parameter, typeParameter, variable, property, decorator, method, namespace
- [ ] Fourslash tests covering: mixed symbol kinds, type-dependent classification
- [ ] Full test suite passes

## Key Considerations

- `ParseTreeUtils.findNodeByOffset` finds deepest node — for token walking, need to visit ALL Name nodes in order. Consider a recursive AST walker or use `ParseTreeUtils.getNodeIterator` if available.
- `SemanticTokensBuilder.push()` requires tokens in document order (line, character) — walk must be ordered.
- Decorator detection: check if Name node is inside a `Decorator` parent node, or if the resolved declaration points to a decorator usage.
- Property vs variable: check if the Name node's enclosing scope is a Class definition.
- Enum member detection: resolve the containing class type and check if it derives from `enum.Enum`.
- The visitor pattern built here is referenced by Phases 4 and 5 — design for reuse but don't over-abstract. If Phases 4/5 need different traversal, they'll build their own.

## Anti-Patterns

- **Syntax-only classification** — matching keyword text instead of resolving through the evaluator. REJECTED per parent epic.
- **Skipping alias resolution** — imported names must resolve through to their actual declaration type.
