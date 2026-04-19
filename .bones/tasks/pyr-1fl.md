---
id: pyr-1fl
title: Build file_intelligence MCP tool
status: closed
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

1. Register MCP tool `file_intelligence` with a single `path` input parameter (absolute `.py` path). Relative paths rejected with `isError: true` — the primary caller (Sub-task C hook) always passes absolute paths from Claude tool invocations.
2. Tool converts path to `file://` URI, opens the file via `didOpen` if not already open (reuse existing `openedUris` tracking pattern).
3. Tool sends three LSP requests in parallel via the shared `MessageConnection`:
   - `textDocument/codeLens` — fetches all code lenses for the file
   - For each lens returned, `codeLens/resolve` — resolves titles containing reference/implementation counts
   - `textDocument/inlayHint` — with full-file range (`{start: {line: 0, character: 0}, end: {line: <lineCount>, character: 0}}`)
   - `textDocument/semanticTokens/full` — returns encoded token stream
4. Decodes semantic tokens using the live `tokenLegend` (loaded at init, not hardcoded).
5. Filters inlay hints to Type hints only (`kind: 1`). Parameter hints (`kind: 2`) excluded — they're noise.
6. Formats result as a single `<file-intelligence>` block. Format must be compact, line-anchored, and scannable. See Format Specification below.
7. Returns error cleanly if file doesn't exist, isn't `.py`, not absolute, or LSP request fails (no crash).
8. Integration test against spawned Pyright with `sample.py` — verifies block contains codeLens counts, `abstract`/`protocol`/`override` classifications, and inferred types.

## Format Specification

Block structure (line-anchored, single-pass scannable):

```
<file-intelligence path="/abs/path/to/file.py">
L4:6 class Greeter [abstract] refs=3 impls=2
L5:8 method greet [abstract]
L9:6 class EnglishGreeter refs=1
L10:8 method greet [override]
L24:4 function add : int  # inferred
</file-intelligence>
```

Rules:
- One line per symbol with emissions
- `L<line>:<col>` prefix (1-indexed line, 1-indexed column matches editor) — compute from semantic token line/character (both 0-indexed) by adding 1
- Symbol kind (`class`, `method`, `function`) — derived from semantic token `tokenType`: `class` → `class`, `method` → `method`, `function` → `function`. Skip other kinds (variable, parameter, etc.) unless they have an inlay hint that attaches to them.
- Symbol name — the identifier text extracted from the decoded token position + length; the formatter is given the source file content to slice this out.
- `[modifiers]` when present (comma-separated; omit if empty). Modifiers come from the semantic token's `tokenModifiers` array.
- `refs=N impls=M` when codeLens provides counts (omit if 0 or missing). Count extracted via regex `^(\d+)\s+` against the resolved `lens.command.title` (titles are `"N references"` / `"N implementations"`, singular when N==1). `lens.data.kind` is the discriminator for refs-vs-impls attribution.
- `label` for inlay Type hints (verbatim from LSP — do NOT synthesize `->` for functions). Pyright currently emits `: <T>` for both return types and variable types (confirmed: inlayHintProvider.ts:114, 143). Only escape `<` if present in the label.
- **Symbol↔inlay attribution**: A Type inlay hint is attached to a symbol if they share the same 0-indexed source line AND the hint's column is strictly greater than the symbol's column (hint lands to the right of the name). When multiple symbols on one line could claim a hint, pick the nearest symbol with column ≤ hint column (rightmost match ≤ hint col). Attribution is best-effort: if no symbol matches, the hint is dropped (keeps the block symbol-anchored).
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
- `formatFileIntelligence(input)` returns `<file-intelligence>` block string
- Test cases: empty inputs, class with modifiers, method with override, function with Type return inlay attributed to function name on same line, sorted output, Parameter inlays pre-filtered by caller (formatter does not receive them), symbol with no emissions is skipped
- Signature: pure function taking parsed/decoded data, returns string. No LSP, no I/O.

Expected shape:
```typescript
interface ResolvedCodeLens {
  range: Range;            // LSP Range (0-indexed)
  count: number;           // Parsed from lens.command.title
  kind: 'references' | 'implementations';
}
interface TypeInlay {
  position: Position;      // LSP Position (0-indexed)
  label: string;           // Verbatim from LSP (e.g., ": int")
}
interface FileIntelligenceInput {
  path: string;            // Absolute path for the block attribute
  source: string;          // File contents — used to slice symbol names by (offset, length)
  codeLens: ResolvedCodeLens[];
  inlays: TypeInlay[];     // Pre-filtered to kind === InlayHintKind.Type
  tokens: DecodedToken[];  // From decodeSemanticTokens()
}
function formatFileIntelligence(input: FileIntelligenceInput): string;
```

Caller responsibility (tool handler): parse lens titles to counts, filter inlays to Type kind, decode tokens. Formatter consumes already-cleaned data.

### Step 2: Implement formatter

Create `packages/pyright-mcp/src/format-file-intelligence.ts`. Pure function — no LSP calls, no side effects. Merges inputs by line/column into sorted symbol entries, emits block per Format Specification.

### Step 3: Integration test for file_intelligence tool (RED)

Add test to `mcp-server.test.ts` that calls `file_intelligence` via MCP client against `sample.py`. Assert block contains (as substring checks on the returned text):
- `class Greeter` line containing `[abstract`  (comma-separated modifier list — just check substring)
- `class EnglishGreeter` line containing `refs=` and `impls=` (exact counts not asserted to avoid brittle tests tied to Pyright analysis output)
- `method greet` line in EnglishGreeter's position range containing `[override`
- `function add` line containing `: int` (Pyright's verbatim inlay label for the inferred return type)
- Block starts with `<file-intelligence path="` and ends with `</file-intelligence>`

Expected to fail — tool doesn't exist yet. Reuse the existing `beforeAll` polling setup so Pyright has finished analyzing `sample.py` before the test runs.

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

- [x] `file_intelligence` tool registered on MCP server with `path` input parameter
- [x] Tool returns `<file-intelligence>` block for a valid `.py` path
- [x] Block includes codeLens reference/implementation counts where present
- [x] Block includes semantic classifications from `tokenModifiers` (abstract, protocol, override)
- [x] Block includes inlay Type hints for unannotated symbols (parameter hints excluded)
- [x] Block is line-anchored (L<line>:<col> prefix), sorted, compact
- [x] Invalid path returns `isError: true` (no crash)
- [x] Non-`.py` path returns `isError: true`
- [x] Pure formatter has unit tests independent of LSP
- [x] Integration test against `sample.py` passes
- [x] Bitset decoding uses live `tokenLegend`, not hardcoded indices
- [x] Partial-failure resilience: if one of the three LSP branches fails (simulated via malformed request or transport error), the tool still returns a valid block with the successful branches' data — verified by unit test using a mocked `MessageConnection` where one branch rejects
- [x] XML-ish escaping: path attribute escapes `<`/`&`/`"`; content escapes `<`/`&`; `>` passes through — verified in formatter unit tests
- [x] `packages/pyright-mcp` builds clean: `npm run build`
- [x] `npm run typecheck` clean
- [x] All existing tests still pass

## Anti-Patterns

- **Don't hardcode modifier bit indices.** Use the live legend set via `setTokenLegend()` at init. Hardcoding breaks when legend order changes.
- **Don't return raw LSP responses.** The point of this tool is to synthesize a formatted block; if the agent wanted raw LSP output, it would call `lsp()`.
- **Don't implement custom LSP transport.** Use the existing `MessageConnection` passed to `createMcpServer`.
- **Don't split the tool across files unnecessarily.** Keep the MCP registration in `mcp-server.ts`; only extract the pure formatter to its own module.
- **Don't include parameter inlay hints.** The spec says Type hints only. Parameter hints are noise.
- **Don't block on slow LSP.** Wrap requests in the same 30s timeout pattern used by `lsp()` tool.
- **Don't re-emit symbols with zero enrichments.** Skip lines that would have no modifiers, no counts, no inlay.

## Key Considerations

- **codeLens resolve is per-lens**: `textDocument/codeLens` returns unresolved lenses; each needs `codeLens/resolve` to get the title with counts. Batch these with `Promise.allSettled` for speed and resilience (see Failure Catalog: resolve errors shouldn't sink the whole response).
- **CodeLens title shape (verified)**: `codeLensProvider.ts:127-133` sets `lens.command.title` to `"<N> reference(s)"` or `"<N> implementation(s)"` (singular when N==1). `lens.data.kind` (`'references' | 'implementations'`) is the discriminator — use it directly. Count extraction: regex `/^(\d+)\s+/` against the title.
- **CodeLens resolve request shape**: The request method is `codeLens/resolve` (not `textDocument/codeLens/resolve`), and the params ARE the lens object itself (not wrapped). See LSP spec 3.17.
- **Inlay hint kinds**: `InlayHintKind.Type = 1`, `InlayHintKind.Parameter = 2`. Tool handler filters to Type BEFORE passing to formatter.
- **Inlay label format (verified)**: `inlayHintProvider.ts:114, 143` emits `label: ": <typeStr>"` for BOTH return types and variable types. No `->` prefix is ever emitted by Pyright. The formatter passes this through verbatim.
- **Label escaping**: `<` must be escaped to `&lt;` to avoid breaking the XML-ish block wrapper. `>` is NOT escaped (preserves `-> T` if Pyright's behavior ever changes, and avoids the failure mode in memory `feedback_xml_escape_only_lt.md`). Label may contain `<` in generic types like `list<int>` — Pyright's printType uses brackets `list[int]` so this is rare but still worth handling.
- **Symbol-name extraction**: Decoded tokens have `{line, character, length}` (0-indexed). Slice the file source at that offset range to get the identifier text.
- **Pyright analysis timing**: The existing test uses a polling loop in `beforeAll` — reuse it. codeLens counts only populate after Pyright finishes binding + type-checking the workspace.
- **tokenLegend race**: `setTokenLegend` is called AFTER `createMcpServer` in existing flow. If `file_intelligence` is called before legend is set, handler must detect and return error — don't decode with empty legend.
- **Full-file inlayHint range**: The LSP inlayHint request requires a `range`. Use `{start: {line: 0, character: 0}, end: {line: <totalLines>, character: 0}}` — compute `<totalLines>` by counting newlines in the file content (which is already read for didOpen). Extra lines are harmless; Pyright clamps.

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

**Dependency Treachery: Null LSP responses**
- Assumption: LSP responses are arrays (even if empty)
- Betrayal: Pyright returns `null` when no code lenses / inlays / tokens exist for the file
- Consequence: downstream `.map()` / `.filter()` crashes with TypeError on null
- Mitigation: normalize at the LSP seam — `const lenses = (await sendRequest(...)) ?? []` for each of the three branches before any downstream use. Not scattered throughout the formatter.

**Dependency Treachery: Partial request failure (one of three succeeds)**
- Assumption: All three LSP requests either succeed or the tool errors out
- Betrayal: codeLens resolves fine but semanticTokens hits an internal Pyright error (stale parse cache, or provider disabled at runtime)
- Consequence: `Promise.all` rejects the whole triple, losing the successful codeLens + inlay data; agent gets `isError` instead of partial intelligence
- Mitigation: `Promise.allSettled` at the top level. Rejected branches become empty arrays; the block shows only the enrichment types that succeeded. Only return `isError` when ALL three fail OR pre-flight check (path/legend) fails.

**Encoding Boundaries: XML-ish wrapper escaping**
- Assumption: Path and inlay labels are safe to interpolate into the `<file-intelligence path="...">` wrapper verbatim
- Betrayal: Path contains `&` or `"` (rare but legal on Unix); inlay label contains `<` (e.g., Pyright's `printType` of a generic TypeVar might include `<` in some edge cases)
- Consequence: The emitted block has broken XML-ish structure; downstream consumers (hook, tests) see malformed output
- Mitigation: escape `<`→`&lt;`, `&`→`&amp;`, `"`→`&quot;` when emitting into attribute context (path). Escape `<`→`&lt;` and `&`→`&amp;` inside content (labels). Never escape `>` — preserves verbatim inlay text per memory `feedback_xml_escape_only_lt.md`.

**Resource Exhaustion: O(symbols × inlays) attribution**
- Assumption: Attribution loop is inexpensive because source files are small
- Betrayal: A 10k-line file has hundreds of symbols and dozens of inlays; naive nested loop is O(n·m)
- Consequence: Formatter time dominates the request; visible latency even within the 30s budget
- Mitigation: preprocess inlays into a `Map<lineNumber, TypeInlay[]>` before attribution; look up by symbol's line — O(n) amortized. Sort inlays within each line-bucket once so rightmost-match is a single linear scan.

**Temporal Betrayal: File edited after didOpen**
- Assumption: `openedUris` tracking means Pyright has current file content
- Betrayal: File was opened earlier with version 1; disk content has changed; we skip didOpen; Pyright returns analysis of stale content
- Consequence: counts/classifications/hints reflect pre-edit state
- Mitigation: ACCEPTED out of scope. Sub-task C hook fires PostToolUse (after Read/Edit/Write), so by the time the hook calls this tool, disk content is canonical and Pyright will have received a didChange from the LSP passthrough path. Direct MCP callers can re-invoke `lsp()` with `textDocument/didChange` if they need freshness — not this tool's job.
