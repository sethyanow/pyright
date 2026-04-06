---
id: pyr-e3e
title: Add goToImplementation provider
status: active
type: feature
priority: 1
owner: Seth
depends_on: [pyr-b68]
parent: pyr-lo0
---






## Context

Pyright doesn't register `textDocument/implementation`. The LSP tool sends it, Pyright responds with "Unhandled method." Pylance has this — open-source Pyright doesn't.

goToImplementation answers: "given this Protocol/ABC/base class, where are the concrete implementations?" goToDefinition answers "where is this defined" — different question.

## Approach

Follow the existing TypeDefinitionProvider pattern in `definitionProvider.ts`:

1. **New class `ImplementationProvider`** in `definitionProvider.ts`. Given a symbol at cursor, resolve its type. If it's a class (Protocol, ABC, or regular base), find subclasses across the workspace. If it's a method on such a class, find overriding methods in those subclasses.

2. **Core algorithm — no reverse index exists.** `ClassType.shared.baseClasses` goes UP the hierarchy only. To find implementors:
   - Resolve the type at cursor via `evaluator.getType(node)`
   - If it's a ClassType: walk all source files via `program.getSourceFileInfoList()`, parse each, collect class declarations, check `derivesFromClassRecursive(candidate, targetClass)` for each
   - If it's a method on a class: find subclasses first (above), then use `lookUpClassMember(subclass, methodName)` on each to find overrides
   - For Protocols: `ClassType.isProtocolClass(classType)` identifies them. Both structural (Protocol) and nominal (ABC with `SupportsAbstractMethods`) subtyping are in scope
   - Pattern reference: `callHierarchyProvider.ts:117-134` — walks `program.getSourceFileInfoList()` filtering to `isUserCode || isOpenByClient`

3. **Wire into server**: `languageServerBase.ts`
   - `setupConnection()`: add `this.connection.onImplementation(...)` at line ~524 alongside existing definition handlers
   - `initialize()`: add `implementationProvider: { workDoneProgress: true }` in capabilities (~line 647)
   - `onImplementation()`: new method following `onTypeDefinition` pattern (~line 752), using the shared `getDefinitions` helper

4. **Test harness**: `verifyFindImplementations()` method in `testState.ts` following `verifyFindTypeDefinitions()` pattern (~line 1447), plus type declaration in `fourslash.d.ts` (~line 337).

## Implementation Steps

1. Add `verifyFindImplementations()` to test harness (`testState.ts`) and `fourslash.d.ts`
2. Write fourslash tests first (RED):
   - `findImplementations.protocol.fourslash.ts` — Protocol class → concrete implementations
   - `findImplementations.methods.fourslash.ts` — method on base class → overriding methods
   - `findImplementations.abc.fourslash.ts` — ABC → concrete subclasses
   - `findImplementations.concrete.fourslash.ts` — concrete class → empty result
3. Create `ImplementationProvider` class in `definitionProvider.ts`
4. Wire into `languageServerBase.ts` (capability + handler + setupConnection)
5. Run fourslash tests (GREEN)
6. Run full test suite

## Success Criteria

- [ ] `textDocument/implementation` returns concrete implementations of Protocols/ABCs
- [ ] Works on class names (returns subclasses) and method names (returns overriding methods)
- [ ] Registered in server capabilities (`implementationProvider: { workDoneProgress: true }`)
- [ ] Returns empty (not error) when cursor is on concrete class with no subclasses
- [ ] Fourslash tests for Protocol, ABC, method override, and concrete-class-returns-empty
- [ ] All existing tests pass

## Key Considerations

- **No reverse index:** The type system stores `baseClasses` (upward). Finding subclasses requires iterating all classes in the program. This is O(n) over source files — same cost as findReferences.
- **Protocol structural subtyping limitation (KNOWN):** `derivesFromClassRecursive` only finds nominal subclasses (classes that explicitly inherit from the target). A class that structurally conforms to a Protocol without inheriting from it won't be found. Checking structural conformance for every class in the workspace is expensive (runs the full protocol conformance checker per class). Phase 1 handles nominal inheritance only. Structural Protocol matching can be a follow-up.
- **Multi-level inheritance:** A → B → C. goToImplementation on A should return B and C (all descendants, not just direct subclasses).
- **Method overrides:** After finding subclasses, use `lookUpClassMember(subclass, methodName)` to check if the subclass defines (not just inherits) the method. Filter to declarations in the subclass itself, not inherited ones.
- **Memory management:** Call `program.handleMemoryHighUsage()` inside the source file loop (pattern from callHierarchyProvider and referencesProvider).
- **Filter to user code:** Only scan `isUserCode(sourceFileInfo) || sourceFileInfo.isOpenByClient` — don't search library internals.
- **Cursor on non-class symbols:** If cursor is on a decorator, string literal, TypeVar, function, module, or between tokens — return empty result, not error. Check `node.nodeType === ParseNodeType.Name` first, then check if type is ClassType.
- **Method parent resolution:** For methods, walk `node.parent` chain to find enclosing ClassNode. If not found (bare function, module-level), return empty. Don't handle dynamic method attachment.
- **`getDefinitions` helper compatibility:** Pass `DefinitionFilter.All` — the source/stub filter is irrelevant for implementation. The helper's shape (`DocumentRange[] | undefined`) matches our needs.

## Anti-Patterns

- Don't return goToDefinition results for goToImplementation — they answer different questions.
- Don't extend `DefinitionProviderBase.getDefinitionsForNode()` — its approach resolves declarations for a name node. ImplementationProvider needs to resolve the TYPE then search for implementors. Use the base class for scaffolding (constructor, sourceMapper) but override the core logic entirely.
- Don't use `findReferences` as the discovery mechanism — it finds text references, not type-hierarchy relationships. Walk source files and check `derivesFromClassRecursive` directly.
