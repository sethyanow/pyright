---
id: pyr-mal
title: Add TypeHierarchyProvider with prepare, supertypes, and subtypes
status: closed
type: task
priority: 1
owner: Seth
parent: pyr-lfw
---






## Context

Phase 2 of pyr-otr (Add missing LSP providers). Phase 1 (pyr-lo0) delivered `ImplementationProvider` in `definitionProvider.ts` with workspace traversal using `derivesFromClassRecursive`. This task reuses that pattern for subtypes and adds the supertypes direction.

The type hierarchy LSP protocol has three requests:
- `textDocument/prepareTypeHierarchy` — resolve class at cursor to a `TypeHierarchyItem`
- `typeHierarchy/supertypes` — given an item, return its base classes
- `typeHierarchy/subtypes` — given an item, return its subclasses across workspace

The `connection.languages.typeHierarchy` API is available in vscode-languageserver with `onPrepare`, `onSupertypes`, `onSubtypes` — same shape as `connection.languages.callHierarchy`.

**Blocked by:** None (first task in phase)
**Unlocks:** pyr-lfw criteria 1-6; adapter layer task (criterion 7)

## Requirements

R3 from pyr-otr: `textDocument/prepareTypeHierarchy`, `typeHierarchy/supertypes`, `typeHierarchy/subtypes` — navigate class hierarchies both directions.

## Design

### Provider: `packages/pyright-internal/src/languageService/typeHierarchyProvider.ts`

New file. Single class `TypeHierarchyProvider` following `CallHierarchyProvider` pattern:

**Constructor:** `(program: ProgramView, fileUri: Uri, position: Position, token: CancellationToken)`
- Resolves `ParseFileResults` and finds node at position (same as `CallHierarchyProvider`)

**`onPrepare(): TypeHierarchyItem[] | null`**
- Find name node at cursor → resolve to class declaration
- Build `TypeHierarchyItem` with name, SymbolKind.Class, uri, range, selectionRange
- Store class data in `item.data` for supertypes/subtypes to use (uri + range is enough to relocate)
- Only works on class names (ClassNode name token) and type annotation references that resolve to classes

**`getSupertypes(): TypeHierarchyItem[] | null`**
- Walk `classType.shared.mro` (skip self, skip `object` unless it's the only base)
- For each MRO entry that's a ClassType, build a `TypeHierarchyItem` pointing to the class definition
- Use `classType.shared.baseClasses` for direct bases (not full MRO) since LSP clients call supertypes recursively (one level at a time). Return only direct base classes.

**`getSubtypes(): TypeHierarchyItem[] | null`**
- Reuse `ImplementationProvider._findSubclassLocations` pattern: iterate `program.getSourceFileInfoList()`, filter to user code, walk statements, check `derivesFromClassRecursive` with `SkipBaseClasses` equivalent (only direct subclasses, not transitive)
- For direct-only: iterate `candidateClass.shared.baseClasses` and check if any matches the target via `ClassType.isSameGenericClass` (instead of `derivesFromClassRecursive` which is transitive). LSP clients call subtypes recursively, so return only direct subclasses.

### Server wiring: `packages/pyright-internal/src/languageServerBase.ts`

1. In `setupConnection()`: add `const typeHierarchy = this.connection.languages.typeHierarchy;` block with three handlers (same pattern as callHierarchy at line 553)
2. In `initialize()` capabilities: add `typeHierarchyProvider: true` (same as `callHierarchyProvider: true` at line 683)
3. Add three handler methods: `onTypeHierarchyPrepare`, `onTypeHierarchySupertypes`, `onTypeHierarchySubtypes` (follow `onCallHierarchy*` pattern at lines 1061-1103)

### Test harness: `packages/pyright-internal/src/tests/harness/fourslash/testState.ts`

Add three verification helpers:
- `verifyTypeHierarchyPrepare(map)` — marker → expected items (name, kind, uri)
- `verifyTypeHierarchySupertypes(map)` — marker → expected items
- `verifyTypeHierarchySubtypes(map)` — marker → expected items

Each instantiates `TypeHierarchyProvider`, calls the method, asserts results.

### Type declarations: `packages/pyright-internal/src/tests/fourslash/typings/fourslash.d.ts`

Add `FourSlashTypeHierarchyItem` interface and three verification method signatures to the `Fourslash` interface.

### Fourslash tests: `packages/pyright-internal/src/tests/fourslash/`

- `typeHierarchy.prepare.fourslash.ts` — class at cursor returns correct item
- `typeHierarchy.singleInheritance.fourslash.ts` — A → B, supertypes of B = [A], subtypes of A = [B]
- `typeHierarchy.multipleInheritance.fourslash.ts` — class with multiple bases
- `typeHierarchy.diamond.fourslash.ts` — diamond pattern
- `typeHierarchy.protocol.fourslash.ts` — Protocol/ABC classes
- `typeHierarchy.crossFile.fourslash.ts` — subtypes in different files

## Implementation

### Step 1: Write failing fourslash test for prepare
Create `typeHierarchy.prepare.fourslash.ts` with a simple class and marker on the class name. Use `helper.verifyTypeHierarchyPrepare()` (doesn't exist yet — test will fail to compile).

### Step 2: Add test harness helpers
Add `FourSlashTypeHierarchyItem` type to `fourslash.d.ts`. Add `verifyTypeHierarchyPrepare`, `verifyTypeHierarchySupertypes`, `verifyTypeHierarchySubtypes` to both `fourslash.d.ts` and `testState.ts`. Import `TypeHierarchyProvider` in testState.ts.

### Step 3: Create TypeHierarchyProvider with onPrepare
Create `typeHierarchyProvider.ts` with the class, constructor, and `onPrepare()` method. The prepare method resolves the class at cursor and returns a `TypeHierarchyItem`.

### Step 4: Run prepare test — verify it passes
`cd packages/pyright-internal && npx jest fourSlashRunner.test --forceExit -t "typeHierarchy.prepare"`

### Step 5: Write failing tests for supertypes
Create `typeHierarchy.singleInheritance.fourslash.ts` testing both supertypes and subtypes directions.

### Step 6: Implement getSupertypes
Walk direct base classes from `shared.n`, build `TypeHierarchyItem` for each.

### Step 7: Run supertypes tests — verify pass

### Step 8: Write failing tests for subtypes
Add subtypes assertions to existing tests or create new ones.

### Step 9: Implement getSubtypes
Workspace traversal pattern from `ImplementationProvider` — iterate source files, find direct subclasses.

### Step 10: Run subtypes tests — verify pass

### Step 11: Write remaining fourslash tests
Multiple inheritance, diamond, Protocol/ABC, cross-file.

### Step 12: Wire into languageServerBase.ts
Add capability, connection handlers, and handler methods.

### Step 13: Run full test suite
`cd packages/pyright-internal && npm run test:norebuild`

### Step 14: Run typecheck
`npm run typecheck`

## Success Criteria

- [x] `TypeHierarchyProvider` class in `typeHierarchyProvider.ts` with `onPrepare`, `getSupertypes`, `getSubtypes`
- [x] `typeHierarchyProvider: true` in server capabilities
- [x] Connection handlers wired for all three requests
- [x] Test harness helpers: `verifyTypeHierarchyPrepare`, `verifyTypeHierarchySupertypes`, `verifyTypeHierarchySubtypes`
- [x] Fourslash tests: prepare, single inheritance, multiple inheritance, diamond, Protocol/ABC, cross-file
- [x] `npm run typecheck` clean
- [x] `npm run test:norebuild` passes (full suite)

## Key Considerations (Failure Catalog)

**onPrepare: non-class nodes**
- Filter via declaration type. Return null for anything that isn't DeclarationType.Class. Handle cursor on base class references in `class Foo(Base)` — resolve the name, not the class statement.

**getSupertypes: non-ClassType entries in shared.baseClasses**
- Dynamic bases, AnyType, UnknownType can appear. Filter with `isClass()` type guard before building items. Skip non-ClassType entries silently.

**getSupertypes: unnavigable declarations**
- Built-in types (`object`, `type`) and some stub types may lack navigable source. Check declaration exists and `canNavigateToFile` returns true before including. Skip unnavigable bases.

**getSubtypes: unevaluated files**
- `getTypeOfClass` returns undefined for not-yet-analyzed ClassNodes. Skip these — same as ImplementationProvider pattern.

**Server wiring: stale position after file edit**
- File may change between prepare and supertypes/subtypes call. Reconstruct from `params.item.uri` + `params.item.range.start` (same as CallHierarchy). Stale position → null is correct behavior.

## Anti-Patterns

- Don't return transitive subclasses/supertypes — LSP clients call recursively, so return only direct relatives
- Don't limit to open files — subtypes must search entire workspace (anti-pattern from parent epic)
- Don't copy ImplementationProvider wholesale — reuse the pattern (workspace traversal + derivesFromClassRecursive for filtering) but the subtype check needs to be direct-only

## Gate

- `cd packages/pyright-internal && npx jest fourSlashRunner.test --forceExit` → all type hierarchy tests pass
- `npm run typecheck` → clean
- `cd packages/pyright-internal && npm run test:norebuild` → full suite passes

## Log

- [2026-04-09T00:25:58Z] [Seth] Task scoped from pyr-lfw Phase 2. Codebase verified: connection.languages.typeHierarchy API available, CallHierarchyProvider pattern confirmed, ImplementationProvider workspace traversal pattern confirmed. Key decision: direct-only sub/supertypes since LSP clients recurse.
