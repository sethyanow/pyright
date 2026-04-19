---
id: pyr-1fl
title: Build file_intelligence MCP tool
status: open
type: task
priority: 1
parent: pyr-ilj
---

## Context

Sub-task B of Phase 5.5b (pyr-ilj). Sub-task A (pyr-xi9) shipped `tokenModifiers` for `abstract`, `protocol`, `override` in pyright-internal. This sub-task consumes those modifiers.

Build a `file_intelligence` MCP tool in `packages/pyright-mcp/src/mcp-server.ts` that accepts a `.py` file path and returns a formatted `<file-intelligence>` block combining codeLens counts, semantic classifications (from tokenModifiers), and inlay type hints for unannotated symbols.

Existing patterns to reuse (verified):
- `createMcpServer(lspConnection)` in mcp-server.ts — registers tools on McpServer
- `lsp()` tool pattern — opens file via didOpen before queries (mcp-server.ts:44-58)
- `decodeSemanticTokens(data, legend)` in decode-semantic-tokens.ts:14 — handles bitset decoding
- `TokenLegend` from decode-semantic-tokens.ts — loaded at init via `setTokenLegend`
- Test fixture `sample.py` in `packages/pyright-mcp/src/tests/fixtures/` has ABC, @abstractmethod, unannotated functions

Sub-task C (PostToolUse hook) blocks on this — the hook is a thin caller that invokes this tool.

## Requirements

1. Register MCP tool `file_intelligence` with a single `path` input parameter (absolute or workspace-relative `.py` path).
2. Tool converts path to `file://` URI, opens the file via `didOpen` if not already open (reuse existing `openedUris` tracking pattern).
3. Tool sends three LSP requests in parallel via the shared `MessageConnection`:
   - `textDocument/codeLens` — fetches all code lenses for the file
   - For each lens returned, `codeLens/resolve` — resolves titles containing reference/implementation counts
   - `textDocument/inlayHint` — with full-file range
   - `textDocument/semanticTokens/full` — returns encoded token stream
4. Decodes semantic tokens using the live `tokenLegend` (loaded at init, not hardcoded).
5. Filters inlay hints to Type hints only (`kind: 1`). Parameter hints (`kind: 2`) excluded — they're noise.
6. Formats result as a single `<file-intelligence>` block. Format must be compact, line-anchored, and scannable. See Format Specification below.
7. Returns error cleanly if file doesn't exist, isn't `.py`, or LSP request fails (no crash).
8. Integration test against spawned Pyright with `sample.py` — verifies block contains codeLens counts, `abstract`/`protocol`/`override` classifications, and inferred types.

## Format Specification

Block structure (line-anchored, single-pass scannable):

```
<file-intelligence path="/abs/path/to/file.py">
L4:6 class Greeter [abstract] refs=3 impls=2
L5:8 method greet [abstract]
L9:6 class EnglishGreeter refs=1
L10:8 method greet [override]
L24:4 function add -> int  # inferred
L24:8 param x: int  # inferred (skip — only Type hints)
</file-intelligence>
```

Rules:
- One line per symbol with emissions
- `L<line>:<col>` prefix (1-indexed line, 1-indexed column matches editor)
- Symbol kind (class/method/function)
- Symbol name
- `[modifiers]` when present (comma-separated; omit if empty)
- `refs=N impls=M` when codeLens provides counts (omit if 0 or missing)
- `-> T` or `: T` for inlay Type hints (verbatim from LSP, don't re-escape)
- Skip symbols with no emissions (no modifiers, no counts, no inlay)
- Output sorted by (line, column) ascending

## Implementation

**Files to modify:**
- `packages/pyright-mcp/src/mcp-server.ts` — register new tool
- `packages/pyright-mcp/src/tests/mcp-server.test.ts` — add integration test

**New file:**
- `packages/pyright-mcp/src/format-file-intelligence.ts` — pure formatting helper (enables unit tests without LSP)

**Verified APIs:**
- `server.registerTool(name, {description, inputSchema}, handler)` — mcp-server.ts:23
- `lspConnection.sendRequest(requestType, params)` — mcp-server.ts:68
- `RequestType<Params, Result, void>(method)` — mcp-server.ts:66
- `decodeSemanticTokens(data, legend)` — decode-semantic-tokens.ts:14
- `openedUris` Set pattern — mcp-server.ts:20, 56
- `readFileSync(filePath, 'utf-8')` for didOpen content — mcp-server.ts:52

**TDD Steps (each step is RED-GREEN-REFACTOR):**

### Step 1: Pure formatter unit tests (enables TDD without LSP)

Create `packages/pyright-mcp/src/tests/format-file-intelligence.test.ts`.

Test intent:
- `formatFileIntelligence(path, codeLens, inlays, tokens)` returns `<file-intelligence>` block string
- Test cases: empty inputs, class with modifiers, method with override, function with return inlay, sorted output, parameter inlays filtered out
- Signature: pure function taking parsed/decoded data, returns string

Expected shape:
```typescript
interface FileIntelligenceInput {
  path: string;
  codeLens: Array<{ range: Range; title: string; kind: 'references' | 'implementations' }>;
  inlays: Array<{ position: Position; label: string; kind: 1 | 2 }>;
  tokens: Array<DecodedToken>;
}
function formatFileIntelligence(input: FileIntelligenceInput): string;
```

### Step 2: Implement formatter

Create `packages/pyright-mcp/src/format-file-intelligence.ts`. Pure function — no LSP calls, no side effects. Merges inputs by line/column into sorted symbol entries, emits block per Format Specification.

### Step 3: Integration test for file_intelligence tool (RED)

Add test to `mcp-server.test.ts` that calls `file_intelligence` via MCP client against `sample.py`. Assert block contains:
- `Greeter` with `abstract` modifier
- `EnglishGreeter` with refs/impls counts
- `greet` in EnglishGreeter with `override` modifier
- `add` function with inferred return type `-> int`

Expected to fail — tool doesn't exist yet.

### Step 4: Register file_intelligence tool — minimal passthrough

In `mcp-server.ts`, register `file_intelligence` tool. Inputs: `{ path: z.string() }`. Handler:
- Validate `.py` extension and path exists
- Convert to `file://` URI
- Open file via didOpen (reuse `openedUris` pattern)
- Return placeholder block to satisfy minimal signature

Integration test should now fail on content assertions, not on tool-not-found.

### Step 5: Wire LSP requests

In handler, send three parallel requests:
```typescript
const [codeLenses, inlays, tokens] = await Promise.all([...]);
```

For codeLens: resolve each lens via `codeLens/resolve`. Filter/sort results.
For semanticTokens: decode with `decodeSemanticTokens(data, tokenLegend)`.

### Step 6: Call formatter, return block

Pass collected data to `formatFileIntelligence()`. Return `{ content: [{ type: 'text', text: block }] }`.

Integration test should now pass.

### Step 7: Error handling

Handle: file doesn't exist, not `.py`, LSP request times out, tokenLegend not loaded. Each returns `isError: true` with a clear message, not a crash.

### Step 8: Build + full test suite

Run:
```bash
cd packages/pyright-mcp && npm run build
cd packages/pyright-mcp && npx jest --forceExit
cd /Volumes/code/pyright && npm run typecheck
```

## Success Criteria

- [ ] `file_intelligence` tool registered on MCP server with `path` input parameter
- [ ] Tool returns `<file-intelligence>` block for a valid `.py` path
- [ ] Block includes codeLens reference/implementation counts where present
- [ ] Block includes semantic classifications from `tokenModifiers` (abstract, protocol, override)
- [ ] Block includes inlay Type hints for unannotated symbols (parameter hints excluded)
- [ ] Block is line-anchored (L<line>:<col> prefix), sorted, compact
- [ ] Invalid path returns `isError: true` (no crash)
- [ ] Non-`.py` path returns `isError: true`
- [ ] Pure formatter has unit tests independent of LSP
- [ ] Integration test against `sample.py` passes
- [ ] Bitset decoding uses live `tokenLegend`, not hardcoded indices
- [ ] `packages/pyright-mcp` builds clean: `npm run build`
- [ ] `npm run typecheck` clean
- [ ] All existing tests still pass

## Anti-Patterns

- **Don't hardcode modifier bit indices.** Use the live legend set via `setTokenLegend()` at init. Hardcoding breaks when legend order changes.
- **Don't return raw LSP responses.** The point of this tool is to synthesize a formatted block; if the agent wanted raw LSP output, it would call `lsp()`.
- **Don't implement custom LSP transport.** Use the existing `MessageConnection` passed to `createMcpServer`.
- **Don't split the tool across files unnecessarily.** Keep the MCP registration in `mcp-server.ts`; only extract the pure formatter to its own module.
- **Don't include parameter inlay hints.** The spec says Type hints only. Parameter hints are noise.
- **Don't block on slow LSP.** Wrap requests in the same 30s timeout pattern used by `lsp()` tool.
- **Don't re-emit symbols with zero enrichments.** Skip lines that would have no modifiers, no counts, no inlay.

## Key Considerations

- **codeLens resolve is per-lens**: `textDocument/codeLens` returns unresolved lenses; each needs `codeLens/resolve` to get the title with counts. Batch these with `Promise.all` for speed.
- **CodeLens kind**: Pyright's code lens titles look like `"3 references"` or `"2 implementations"` — parse these to extract counts. The provider distinguishes via a `data` field; check existing codeLens tests for the exact shape.
- **Inlay hint filtering**: `InlayHintKind.Type = 1`, `InlayHintKind.Parameter = 2`. Only emit Type hints in the block.
- **Label escaping**: Existing memory notes (`feedback_xml_escape_only_lt.md`) says don't escape `>` — preserves `-> int` verbatim. Only escape `<`.
- **Pyright analysis timing**: The existing test uses a polling loop to wait for Pyright to finish analyzing. The new integration test should reuse or extend this pattern.
- **tokenLegend race**: `setTokenLegend` is called AFTER `createMcpServer` in existing flow. If `file_intelligence` is called before legend is set, handler must detect and return error — don't decode with empty legend.

## Failure Catalog

**Dependency Treachery: codeLens resolve returns error**
- Assumption: Every unresolved lens can be resolved
- Betrayal: Resolve fails for a lens (e.g., stale position after edit)
- Consequence: Promise.all rejects, entire block fails
- Mitigation: Use `Promise.allSettled` for resolves; include resolved lenses, skip failed ones with a comment.

**Temporal Betrayal: tokenLegend unset**
- Assumption: `setTokenLegend` called before any tool invocation
- Betrayal: Race condition — tool called during init before legend propagates
- Consequence: All tokens decode as `unknown`, no modifiers emitted
- Mitigation: Check `tokenLegend` at handler entry; return `isError: true` with clear message if not set.

**Input Hostility: Empty file**
- Assumption: File has at least one symbol
- Betrayal: Empty `.py` file or file with only comments
- Consequence: All three LSP requests return empty; formatter emits empty block
- Mitigation: Acceptable — empty block `<file-intelligence path="..."></file-intelligence>` is valid output.

**Encoding Boundaries: Non-UTF-8 path**
- Assumption: Path is valid UTF-8
- Betrayal: Path contains surrogates or invalid sequences
- Consequence: `readFileSync` throws, or URL construction fails
- Mitigation: Catch, return `isError: true`. Don't pre-validate — let the filesystem/URL constructor decide.

**Resource Exhaustion: Very large file (>10k lines)**
- Assumption: File fits in reasonable analysis time
- Betrayal: Huge codebase with thousands of classes
- Consequence: codeLens resolve fanout exhausts LSP, request times out
- Mitigation: 30s timeout matches `lsp()` tool. If needed in a later task, add `maxLines` cap; not required now.
