---
id: pyr-mge
title: 'Phase 3: Semantic Tokens'
status: closed
type: epic
priority: 1
depends_on: [pyr-lfw, pyr-tc8, pyr-glm, pyr-db7, pyr-xgj, pyr-oaf]
parent: pyr-otr
---












## Context

Phase 3 of pyr-otr. The file-walking visitor pattern built here is reused by Phase 4 (Inlay Hints) and Phase 5 (Code Lens). Build it properly — each node resolved through the type evaluator, not syntax-only classification.

## Requirements

R4 from parent epic: `textDocument/semanticTokens/full` and `/range` — classify every resolved symbol (class, function, parameter, typeParameter, variable, property, decorator, etc.) for semantic highlighting.

## Success Criteria

- [x] `textDocument/semanticTokens/full` registered in capabilities, returns token classifications
- [x] `textDocument/semanticTokens/range` returns classifications for a given range
- [x] Tokens classified by resolved type, not syntax — a name that's a class in one context and a variable in another must be classified differently
- [x] Token types covered: class, function, parameter, typeParameter, variable, property, decorator, method, namespace
- [x] Fourslash tests covering: mixed symbol kinds in same file, type-dependent classification
- [x] Full test suite passes
- [x] Adapter layer updated — semantic tokens accessible through MCP + skill/scripts

## Key Considerations

- The visitor must resolve each node through the evaluator — syntax-only keyword matching is wrong
- This visitor pattern generalizes for Phases 4 and 5
- `SemanticTokensBuilder` from vscode-languageserver handles the encoding format

## Gate

- `cd packages/pyright-internal && npx jest fourSlashRunner.test --forceExit` → semantic tokens tests pass
- `npm run typecheck` → clean

## Demo

Show me the token classifications for a Python file with classes, functions, decorators, type parameters — demonstrate that the visitor correctly resolves each symbol kind.

## Log

- [2026-04-10T03:45:15Z] [Seth] Phase 3 complete. All 7 criteria met. Acceptance demo presented live via MCP. Namespace classification bug (pyr-oaf) caught and fixed during acceptance — was incorrectly checked off. 7 fourslash tests total (4 original + 3 namespace regression). Visitor pattern in semanticTokensProvider.ts ready for reuse in Phase 4/5.
