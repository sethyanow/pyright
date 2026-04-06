---
id: pyr-mge
title: 'Phase 3: Semantic Tokens'
status: open
type: epic
priority: 1
depends_on: [pyr-lfw]
parent: pyr-otr
---

## Context

Phase 3 of pyr-otr. The file-walking visitor pattern built here is reused by Phase 4 (Inlay Hints) and Phase 5 (Code Lens). Build it properly — each node resolved through the type evaluator, not syntax-only classification.

## Requirements

R4 from parent epic: `textDocument/semanticTokens/full` and `/range` — classify every resolved symbol (class, function, parameter, typeParameter, variable, property, decorator, etc.) for semantic highlighting.

## Success Criteria

- [ ] `textDocument/semanticTokens/full` registered in capabilities, returns token classifications
- [ ] `textDocument/semanticTokens/range` returns classifications for a given range
- [ ] Tokens classified by resolved type, not syntax — a name that's a class in one context and a variable in another must be classified differently
- [ ] Token types covered: class, function, parameter, typeParameter, variable, property, decorator, method, namespace
- [ ] Fourslash tests covering: mixed symbol kinds in same file, type-dependent classification
- [ ] Full test suite passes
- [ ] Adapter layer updated — semantic tokens accessible through MCP + skill/scripts

## Key Considerations

- The visitor must resolve each node through the evaluator — syntax-only keyword matching is wrong
- This visitor pattern generalizes for Phases 4 and 5
- `SemanticTokensBuilder` from vscode-languageserver handles the encoding format

## Gate

- `cd packages/pyright-internal && npx jest fourSlashRunner.test --forceExit` → semantic tokens tests pass
- `npm run typecheck` → clean

## Demo

Show me the token classifications for a Python file with classes, functions, decorators, type parameters — demonstrate that the visitor correctly resolves each symbol kind.
