---
id: pyr-e3e
title: Add goToImplementation provider
status: open
type: feature
priority: 1
depends_on: [pyr-b68]
parent: pyr-lo0
---




## Context

Pyright doesn't register `textDocument/implementation`. The LSP tool sends it, Pyright responds with "Unhandled method." Pylance has this — open-source Pyright doesn't.

goToImplementation answers: "given this Protocol/ABC/base class, where are the concrete implementations?" goToDefinition answers "where is this defined" — different question.

## Approach

Follow the existing TypeDefinitionProvider pattern in `definitionProvider.ts`:

1. **New class `ImplementationProvider`** in `definitionProvider.ts` extending `DefinitionProviderBase`. Given a symbol at cursor, resolve its type. If it's a class (Protocol, ABC, or regular base), find subclasses. If it's a method on such a class, find overriding methods in subclasses.

2. **Wire into server**: `languageServerBase.ts` — add `onImplementation` handler using the same `getDefinitions` helper that `onDefinition`/`onTypeDefinition` use. Register `implementationProvider: true` in capabilities (line ~660).

3. **Register on connection**: `setupConnection` — add `this.connection.onImplementation(...)` alongside the existing definition handlers.

The type evaluator already tracks class hierarchies and subclass relationships. The hard part is efficiently finding all subclasses across the workspace — `findReferences` on the base class name and filtering to class declarations that inherit from it is one approach.

## Success Criteria

- [ ] `textDocument/implementation` returns concrete implementations of Protocols/ABCs
- [ ] Works on class names (returns subclasses) and method names (returns overriding methods)
- [ ] Registered in server capabilities
- [ ] Fourslash test covering basic Protocol → implementation case
- [ ] All existing tests pass
