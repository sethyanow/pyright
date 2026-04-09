---
id: pyr-tc8
title: Implement SemanticTokensProvider with full/range support
status: active
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
3. Subclasses `ParseTreeWalker` from `analyzer/parseTreeWalker.ts`, overrides `visitName` (and `visitMemberAccess` for `obj.attr` member names). `ParseTreeWalker.walk()` visits nodes in document order via `getChildNodes()`.
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
- [ ] Token types covered: class, function, parameter, typeParameter, variable, property, decorator, method, namespace, enum, enumMember
- [ ] Fourslash tests covering: mixed symbol kinds, type-dependent classification
- [ ] Full test suite passes

## Key Considerations

- **AST walker:** Use `ParseTreeWalker` from `analyzer/parseTreeWalker.ts` — subclass it, override `visitName` to process each `NameNode`. `ParseTreeWalker.walk()` recurses via `getChildNodes()` which returns children in source order, satisfying `SemanticTokensBuilder`'s document-order requirement.
- **MemberAccess names:** `MemberAccessNode.d.member` is a `NameNode`. Override `visitMemberAccess` to return `false` (handle children manually) — process `d.member` as a potential property/method, recurse into `d.leftExpr` normally.
- **Decorator detection:** When `visitName` fires, check `node.parent?.nodeType === ParseNodeType.Decorator` or check if the parent chain has a `DecoratorNode`. The decorator's `d.expr` can be a `NameNode` (simple decorator) or `MemberAccessNode`/`CallNode` (dotted/called decorator).
- **Property vs variable:** Use `getEnclosingClass(node)` from `parseTreeUtils.ts` to check if the name is inside a class scope.
- **Import names:** Names inside `ImportFromAs` and `ImportAs` nodes resolve via `getDeclInfoForNameNode` to `Alias` declarations. Skip import statement names — they get syntax highlighting already and resolving them through aliases adds noise without value. Only classify names at their usage sites.
- **Enum member detection:** Resolve the containing class type and check if it derives from `enum.Enum`.
- **`DeclarationType.Intrinsic`:** Maps to `variable` (built-in constants like `None`, `True`, `False`).
- **Fourslash type declarations:** Add `verifySemanticTokens` to `packages/pyright-internal/src/tests/fourslash/typings/fourslash.d.ts`.
- The visitor pattern built here is referenced by Phases 4 and 5 — design for reuse but don't over-abstract. If Phases 4/5 need different traversal, they'll build their own.

## Failure Catalog

**Encoding Boundaries: Offset→Position conversion**
- Assumption: `SemanticTokensBuilder.push(line, char, length, ...)` receives correct 0-based line/character from name node offsets
- Betrayal: `NameNode.start` is a byte offset, not a line/char pair. If we pass `node.start` directly as `char`, every token after line 0 gets wrong positions and the delta encoding produces garbage
- Consequence: Editor renders semantic highlights on wrong characters — subtle visual corruption, not a crash
- Mitigation: Use `convertOffsetToPosition(node.start, parseResults.tokenizerOutput.lines)` to get `{line, character}`. For `length`, use `node.d.value.length` (string length of the identifier text), not `node.length` (which includes surrounding whitespace/decorations in some node types)

**Input Hostility: Empty `decls` array from `getDeclInfoForNameNode`**
- Assumption: Every resolved `SymbolDeclInfo` has at least one declaration in `decls`
- Betrayal: `getDeclInfoForNameNode` returns `SymbolDeclInfo` with `decls: []` for names in error recovery regions, or returns `undefined` for unresolvable names
- Consequence: `decls[0]` is `undefined`, accessing `.type` throws
- Mitigation: Check `declInfo === undefined || declInfo.decls.length === 0` → skip token. This is a structural guard, not error handling — unresolvable names legitimately have no semantic classification

**Input Hostility: Multiple declarations (overloads, augmented assignments)**
- Assumption: `decls[0]` is always the right declaration to classify
- Betrayal: A name with overloaded functions has multiple `DeclarationType.Function` entries. An augmented assignment (`x = 1; x += 2`) has two Variable declarations
- Consequence: Taking `decls[0]` produces correct classification for overloads (all are Function) but could theoretically produce wrong classification if declaration types differ across entries
- Mitigation: Use `decls[0]` — this matches what other providers do (definitionProvider, hoverProvider). Multiple decls of the same name have the same classification category. If a name has mixed declaration types (extremely rare — e.g., conditional class-or-function assignment), `decls[0]` is the best guess

**Encoding Boundaries: Delta encoding in test harness**
- Assumption: Test harness correctly decodes `SemanticTokens.data` (groups of 5: deltaLine, deltaStartChar, length, tokenType, tokenModifiers)
- Betrayal: `deltaStartChar` is relative to previous token on SAME line, but absolute (relative to line start) for first token on a new line. Off-by-one in accumulation produces cascading position errors — tests fail with "no token at marker"
- Consequence: False test failures, debugging nightmare
- Mitigation: Accumulator resets `prevChar = 0` when `deltaLine > 0`. This is the LSP spec behavior — document it in the decoder with a comment

**Input Hostility: Parse-error files**
- Assumption: `ParseFileResults` contains a complete, well-formed AST
- Betrayal: Files with syntax errors produce partial ASTs. The walker visits whatever nodes exist. Some subtrees may be `ErrorNode` with child fragments
- Consequence: Walker may encounter unexpected node shapes, or `getDeclInfoForNameNode` returns undefined more often
- Mitigation: `ParseTreeWalker` already handles this — `getChildNodes` for `ErrorNode` returns `[node.d.child, ...node.d.decorators]`. Skipping unresolvable names (the empty-decls guard above) handles the rest

**Resource Exhaustion: Large files**
- Assumption: Walking every name node and calling `getDeclInfoForNameNode` completes in reasonable time
- Betrayal: A 10,000-line file with thousands of names triggers evaluation for each. If the file hasn't been fully analyzed, this is O(n) evaluator calls
- Consequence: Semantic tokens request blocks for seconds on first request for a large unevaluated file
- Mitigation: The evaluator caches results — first call is expensive, subsequent calls are cache hits. The checker already walks every node for diagnostics, so by the time semantic tokens are requested, the evaluator cache is warm. For `/range` requests, we can skip walking nodes outside the range entirely (check `node.start` against range before calling `getDeclInfoForNameNode`)

## Anti-Patterns

- **Syntax-only classification** — matching keyword text instead of resolving through the evaluator. REJECTED per parent epic.
- **Skipping alias resolution** — imported names must resolve through to their actual declaration type.
