---
id: pyr-tbs
title: Fix ImplementationProvider false positives on large workspaces
status: open
type: bug
priority: 1
parent: pyr-lo0
---




## Context

`ImplementationProvider._findSubclassLocations` at `definitionProvider.ts:389` uses `derivesFromClassRecursive(classTypeResult.classType, targetClass)` to find subclasses. On the test fixture (small workspace with just `Greeter(ABC)`, `EnglishGreeter(Greeter)`, `SpanishGreeter(Greeter)`), it correctly returns 2 results.

On the full repo workspace, it returns hundreds of results — every class that derives from `ABC` across typeshed and test samples. The check is matching subclasses of the *base class* (`ABC`) rather than subclasses of the *target class* (`Greeter`).

**Repro:** `node packages/pyright-mcp/dist/lsp-client.js textDocument/implementation '{"textDocument":{"uri":"file:///Volumes/code/pyright/packages/pyright-mcp/src/tests/fixtures/sample.py"},"position":{"line":3,"character":6}}'` from repo root.

## Requirements

R1. `textDocument/implementation` on `Greeter(ABC)` returns only `EnglishGreeter` and `SpanishGreeter` — not every ABC subclass in the workspace.

## Success Criteria

- [ ] Regression test: fourslash test with a multi-file workspace where the target class and an unrelated ABC subclass coexist — only the target's subclasses returned
- [ ] Existing implementation fourslash tests still pass
- [ ] CLI repro against full repo workspace returns only the 2 fixture subclasses
