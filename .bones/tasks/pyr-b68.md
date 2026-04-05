---
id: pyr-b68
title: go_to_definition returns empty on async method definitions at keyword position
status: active
type: bug
priority: 2
owner: Seth
---





## Bug Report — Field Observation

**Source:** ChunkHound MCP tool acceptance testing (chunkhound project)
**Reporter:** AI agent during live MCP tool demo
**Pyright version:** 1.1.408 (via LSP stdio transport)

### Reproduction

`textDocument/definition` returns empty `[]` when the cursor position is on the `async` or `def` keyword of a method definition. Positioning on the method **name** works correctly.

**Steps:**
1. Open a Python file via `textDocument/didOpen` (or rely on Pyright's on-disk analysis)
2. Send `textDocument/definition` at the position of the `async` keyword (or `def` keyword) of a method
3. Result: empty array `[]`
4. Send `textDocument/definition` at the position of the method **name** identifier
5. Result: correct Location pointing to the definition

**Concrete example:**
```python
# chunkhound/services/lsp_population.py, line 58 (1-based):
    async def populate_file(
#   ^~~~~                        ← definition here returns []
#              ^~~~~~~~~~~~~     ← definition here returns correct Location
```

LSP request that returns empty:
```json
{"method": "textDocument/definition", "params": {"textDocument": {"uri": "file:///path/to/lsp_population.py"}, "position": {"line": 57, "character": 14}}}
```

### Context

Discovered during ChunkHound's LSP edge population pipeline. The population service calls `find_references` and `go_to_definition` at `SymbolInfo.range.start` positions from `textDocument/documentSymbol` responses. For class/method definitions, `range.start` points to the beginning of the full definition (keyword), not `selectionRange.start` (the name).

This means `go_to_definition` at `range.start` silently returns nothing for many symbols. The workaround is to use `selectionRange.start` instead, which we've implemented in ChunkHound.

### Expected Behavior

`textDocument/definition` at a keyword position (`async`, `def`, `class`) that is part of a symbol definition should resolve to that symbol's definition location — same as positioning on the name.

### Impact

Low — workaround exists (use `selectionRange`). But it's a papercut for any tool that iterates `documentSymbol` results and calls definition/references at `range.start`.

### Workaround

Use `selectionRange.start` instead of `range.start` for all LSP operations that need symbol identity.

## Root Cause (verified)

`definitionProvider.ts:158` — `getDefinitionsForNode` only handles `ParseNodeType.Name` and `ParseNodeType.String`. When cursor is on `async`/`def`/`class` keywords, `findNodeByOffset` (parseTreeUtils.ts:100) returns the FunctionNode/ClassNode itself (keywords aren't child ParseNode instances), and the method falls through to return `undefined`.

## Approach

In `getDefinitionsForNode` (`definitionProvider.ts:158`), add an else-if branch for `ParseNodeType.Function` and `ParseNodeType.Class` that redirects to the declaration's `d.name` NameNode:

```typescript
} else if (node.nodeType === ParseNodeType.Function || node.nodeType === ParseNodeType.Class) {
    return this.getDefinitionsForNode(node.d.name, node.d.name.start);
}
```

This is the minimal contained fix — recursive call reuses the existing Name handler without duplicating `getDeclInfoForNameNode` logic.

**File:** `packages/pyright-internal/src/languageService/definitionProvider.ts`
**Method:** `DefinitionProviderBase.getDefinitionsForNode` (line 158)
**Insert after:** the `ParseNodeType.String` else-if block (line 184)

## Implementation

1. Add `ParseNodeType.Function` and `ParseNodeType.Class` imports if not already present
2. Add else-if branch in `getDefinitionsForNode` after the String handler
3. Write fourslash test `findDefinitions.keywordPosition.fourslash.ts`

## Success Criteria

- [ ] `def` keyword position on a function definition resolves to the function's name declaration
- [ ] `async` keyword position on an async function resolves to the function's name declaration
- [ ] `class` keyword position on a class definition resolves to the class's name declaration
- [ ] Existing name-based go-to-definition still works (no regression)
- [ ] Fourslash test covers all three keyword types (def, async def, class)
- [ ] All existing tests pass

## Edge Cases

- **`lambda`**: No name node — should continue returning `undefined`. Not a declaration keyword in the same sense. No change needed.
- **Decorated functions/classes**: Cursor on decorator `@` is on a DecoratorNode, not on the FunctionNode — not affected by this fix.
- **Control flow keywords** (`for`, `if`, `with`, `try`): Not declaration nodes — `findNodeByOffset` returns ForNode/IfNode/etc., which have no `d.name`. Not affected by this fix (they should continue returning undefined).
- **Nested functions/classes**: The fix operates on the innermost node returned by `findNodeByOffset`, which is correct for nested declarations.

## Anti-Patterns

- Don't modify `findNodeByOffset` to redirect keyword offsets — that changes behavior for ALL consumers (hover, references, etc.), not just go-to-definition.
- Don't add a catch-all for "any node with a `.d.name`" — be explicit about which ParseNodeTypes are handled.
- Don't change how the offset is computed in `_tryGetNode` — the offset is correct; the handler is what's missing.

## Key Considerations (Failure Catalog)

**Input Hostility: getDefinitionsForNode — FunctionNode/ClassNode with broken name**
- Assumption: `node.d.name` is a valid NameNode when the parser produces a FunctionNode/ClassNode
- Betrayal: Parse errors could produce a declaration node with an error/empty name
- Consequence: `getDeclInfoForNameNode` returns undefined → `getDefinitionsForNode` returns undefined — same as current behavior. No regression.
- Mitigation: Not needed — graceful degradation to existing behavior via the recursive call hitting the Name branch and returning nothing.

**Resource Exhaustion: Recursive call termination**
- Assumption: `getDefinitionsForNode(node.d.name, ...)` terminates in one step
- Betrayal: Could infinite-loop if a NameNode somehow re-entered the Function/Class branch
- Consequence: Stack overflow
- Mitigation: Structurally impossible — `node.d.name` is typed `NameNode` (ParseNodeType.Name). The recursive call hits the Name branch, not Function/Class. TypeScript type system enforces this.

**Input Hostility: Test marker placement off-by-one**
- Assumption: Fourslash markers land exactly on keyword tokens
- Betrayal: Marker placed one character off lands on whitespace (returns parent suite) or on the name (tests wrong path)
- Consequence: Test passes for wrong reason
- Mitigation: Test includes control markers: one on the name (must also resolve — proves the Name path still works) and one on the keyword (proves the new path works). Different positions, same expected result.

**Temporal Betrayal / State Corruption / Dependency Treachery / Encoding Boundaries** — Skipped. Pure synchronous in-memory AST traversal. No external calls, no persistent state, no encoding boundaries, no temporal dependencies.

## Log

- [2026-04-05T23:40:55Z] [Seth] Adversarial stress test complete. All 9 markers pass (3 basic, 3 adversarial, 3 control). Q2 finding: hoverProvider.ts and findReferences likely have same keyword-position issue — out of scope for this bug fix.
