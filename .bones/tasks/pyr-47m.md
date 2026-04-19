---
id: pyr-47m
title: 'Phase 5.5b Task 3: custom semantic-token modifiers (abstract/protocol/override) + file-intelligence integration'
status: open
type: task
priority: 1
parent: pyr-ilj
---

## Context

Third task of Phase 5.5b (pyr-ilj). Builds on pyr-bay's combined `fetchFileIntelligence` (codeLens + inlayHint). Adds semantic classifications — `abstract` / `protocol` / `override` — to the `<file-intelligence>` block by extending Pyright's `SemanticTokensProvider` with custom LSP token modifiers AND consuming them in the pyright-mcp hook pipeline.

**Blocked by:** pyr-bay (closed — combined fetch + formatter pipeline in place)
**Unlocks:** Phase 5.5b acceptance task

**Scope-shaping decision (2026-04-19):** pyr-tcv's anti-pattern "Don't modify the Pyright language server itself for enrichment" is RELAXED for this task per user decision after adversarial verification found Pyright's `semanticTokensProvider.ts:56` ships `tokenModifiers: []` — no existing API surfaces ABC/Protocol/override. Alternatives (AST-scan at hook layer; defer classification) either miss inherited ABC status or leave R6's "semantic classifications" criterion permanently unchecked. Document the relaxation in pyr-tcv's anti-pattern section when closing this task. **User also flagged this decision for post-task discussion — revisit the anti-pattern's phrasing and scope after Task 3 ships.**

## Requirements

From pyr-tcv parent epic:
- R5 (partial): PostToolUse hook fetches `textDocument/semanticTokens/full` alongside existing codeLens + inlayHint.
- R6 (partial): block now carries semantic-classification tags on class / method lines: `abstract` on ABC classes, `protocol` on typing.Protocol classes, `override` on methods marked `@override` / `@typing.override`.
- R7: all existing tests pass (pyright-mcp + pyright-internal + typecheck); fourslash regression-free.

## Design

### Custom token modifiers in Pyright's legend

Today, `packages/pyright-internal/src/languageService/semanticTokensProvider.ts:56` declares `tokenModifiers: []` (empty). Extend to:

```ts
tokenModifiers: [
    'abstract',     // LSP-standard modifier — emitted on ABC classes
    'protocol',     // custom — emitted on typing.Protocol classes
    'override',     // custom — emitted on methods marked @override / @typing.override
],
```

Unknown modifiers are tolerated by LSP clients per spec §Capabilities. Our pyright-mcp `decode-semantic-tokens.ts` already walks the bitset against the legend array and produces strings — no decoder change needed.

### Emission logic

`SemanticTokenWalker` already walks parse nodes and assigns token types. Extend:

- Class-token branch (~line 172 in `semanticTokensProvider.ts`): compute a modifier bitset. Emit `abstract` via `isAbstractClass(classType)`. Emit `protocol` via `isProtocolClass(classType)`.
- Method/function branch (~line 176): emit `override` when the method has a decorator resolving (through the binder) to `typing.override` — NOT a raw string match on the decorator name.

Emission pattern:
```ts
const modifiers = this._computeModifiers(node, classType); // returns bitset
this._builder.push(line, char, length, typeIndex, modifiers);
```

### Decoder and consumer (pyright-mcp)

`decode-semantic-tokens.ts` already decodes modifiers into `string[]`. Unchanged.

In `packages/pyright-mcp/src/hooks/socket-lsp-client.ts`, extend:

```ts
interface FileIntelligence {
    codeLenses: ResolvedLens[];
    inlayHints: InlayTypeHint[];
    classifications: ClassificationHint[];  // NEW
}
interface ClassificationHint { line: number; tag: 'abstract' | 'protocol' | 'override' }
```

Capture the legend during `initialize` (from `capabilities.semanticTokensProvider.legend`) and pass to the decoder. Filter decoded tokens to the three target modifiers; collapse to `(line+1, tag)` tuples; dedupe.

Sequence in the outer try: `codeLens → inlay → semanticTokens`. Each failure preserves prior results (same structural pattern pyr-bay established).

### Block format extension

Classification tags attach INLINE to the codeLens line when they share a position. When no codeLens exists at that line, emit a standalone classification line.

```
<file-intelligence path="/.../sample.py">
L4   Greeter         refs=3  impls=2  abstract
L9   EnglishGreeter  refs=0  impls=0
L10  greet           refs=0           override
L14  SpanishGreeter  refs=0  impls=0
L15  greet           refs=0           override
L24  add             refs=1
L28  multiply        refs=1
L32  : Literal[3]
L33  : int
</file-intelligence>
```

Rules:
- CodeLens line matches classification line: append tag(s) space-separated after existing columns.
- Multiple classifications at same line: alphabetic order (`abstract < override < protocol`).
- Classification without codeLens peer: standalone line `L{line}  {tag}` (rare).
- Dedupe + MAX_LINES combined cap still apply. Inline classifications consume no slots (they extend a codeLens line). Standalone classifications claim slots from remaining-budget BEFORE inlay does — classifications are higher-signal than per-local type hints.

### What `override` detection catches (and what it misses)

In scope: explicit `@override` / `@typing.override` decorators (PEP 698, Python 3.12+).

Out of scope: implicit overrides (methods shadowing parent without the decorator). Detecting these requires walking the MRO and reusing `checker.ts:6477`'s `reportImplicitOverride` logic — threads checker state into the provider, bigger surgery than this task can afford. Follow-up only if observed in practice.

## Implementation

### Step 1: RED — failing fourslash test for abstract/protocol modifiers

File: `packages/pyright-internal/src/tests/fourslash/semanticTokens.classifications.fourslash.ts` (new)

Existing `verifySemanticTokens` in `testState.ts:1587` checks only tokenType. Add a parallel helper `verifySemanticTokenModifiers(map: { [marker: string]: string[] })` next to it — same marker/position pattern but asserts modifier string-array equality at each marker.

Test fixture (embedded fourslash):
```python
from abc import ABC, abstractmethod
from typing import Protocol

class /*abc_class*/AbstractBase(ABC):
    @abstractmethod
    def greet(self) -> str: ...

class /*proto_class*/Speaker(Protocol):
    def speak(self) -> str: ...

class /*plain_class*/Plain:
    pass
```

Assertions:
- `abc_class` → modifiers include `abstract`
- `proto_class` → modifiers include `protocol`
- `plain_class` → empty

Run: `cd packages/pyright-internal && npx jest -t "semanticTokens.classifications" --forceExit` — expect helper-not-found or empty-modifier failure.

### Step 2: GREEN — extend `tokenLegend.tokenModifiers` + add bitset helper

File: `packages/pyright-internal/src/languageService/semanticTokensProvider.ts`

- Change `tokenModifiers: []` → `tokenModifiers: ['abstract', 'protocol', 'override']`.
- Add module-scope helper `_modifierBitset(modifiers: string[]): number` that OR's `1 << tokenLegend.tokenModifiers.indexOf(name)` for each name, skipping unknowns.

### Step 3: GREEN — emit `abstract` / `protocol` for class tokens

File: `packages/pyright-internal/src/languageService/semanticTokensProvider.ts`

In the class-emission branch (locate via `LSP.goToDefinition` on existing `SemanticTokenTypes.class` push — do NOT guess the line). Compute:
```ts
const modNames: string[] = [];
if (isAbstractClass(classType)) modNames.push('abstract');
if (isProtocolClass(classType)) modNames.push('protocol');
builder.push(line, char, length, classTypeIndex, _modifierBitset(modNames));
```

Verify `isAbstractClass` and `isProtocolClass` exports via `LSP.hover` against `packages/pyright-internal/src/analyzer/types.ts` at authoring time. `isProtocolClass` confirmed at `types.ts:1256`; `isAbstractClass` presence not yet confirmed — if missing, use inline `ClassTypeFlags` bit check, do not invent an export.

Run: `cd packages/pyright-internal && npx jest -t "semanticTokens.classifications" --forceExit` — expect `abc_class` / `proto_class` pass, `plain_class` already passes.

### Step 4: RED — extend fourslash fixture with override cases

Extend the same fourslash file:
```python
class Base:
    def /*base_method*/foo(self) -> None: ...

class Derived(Base):
    @override
    def /*override_method*/foo(self) -> None: ...

    def /*non_override*/bar(self) -> None: ...
```

Assertions:
- `override_method` → modifiers include `override`
- `base_method` → empty
- `non_override` → empty

Run: `cd packages/pyright-internal && npx jest -t "semanticTokens.classifications" --forceExit` — expect new assertions to fail.

### Step 5: GREEN — emit `override` for `@override`-decorated methods

File: `packages/pyright-internal/src/languageService/semanticTokensProvider.ts`

Add helper `hasOverrideDecorator(funcNode): boolean` at module scope. For each decorator expression on the function node, resolve the decorator name through the binder/evaluator (use `evaluator.getDeclarationsForNameNode` or equivalent — verify the correct primitive via `LSP.hover`). Return true iff any resolved declaration's canonical module path is `typing` AND its symbol name is `override`.

Do NOT string-compare on the raw decorator token text.

In the method-emission branch:
```ts
const modNames: string[] = [];
if (hasOverrideDecorator(funcNode)) modNames.push('override');
builder.push(line, char, length, methodTypeIndex, _modifierBitset(modNames));
```

Run: `cd packages/pyright-internal && npx jest -t "semanticTokens.classifications" --forceExit` — expect pass.

### Step 6: Full pyright-internal suite

Run: `cd packages/pyright-internal && npm run test:norebuild` — all ~2,392 tests pass. Zero regression on other `semanticTokens.*.fourslash.ts` tests (they don't assert empty modifiers today — verify by reading the files).

### Step 7: RED — fetchFileIntelligence classifications test

File: `packages/pyright-mcp/src/tests/hooks/socket-lsp-client.test.ts`

Extend the `fetchFileIntelligence` describe: assert `intel.classifications` is a non-empty array; at least one entry has `tag: 'abstract'` and `line` matching Greeter's line (L4 in `fixtures/sample.py`).

Run: `cd packages/pyright-mcp && npx jest socket-lsp-client --forceExit` — expect TS error ("`classifications` not on `FileIntelligence`").

### Step 8: GREEN — implement semanticTokens fetch + modifier decoding

File: `packages/pyright-mcp/src/hooks/socket-lsp-client.ts`

1. Add `classifications: ClassificationHint[]` to `FileIntelligence` interface (in `format-block.ts`, re-exported here). Add `ClassificationHint` type.
2. Add `fetchClassifications(conn, uri, text, token, legend)`: calls `textDocument/semanticTokens/full`, decodes with captured legend (from initialize response), filters to tokens whose `tokenModifiers` contains one of `abstract|protocol|override`, produces `{ line: position.line+1, tag }` tuples, dedupes.
3. Capture legend during `initialize`: the `InitializeResult.capabilities.semanticTokensProvider.legend` (may be present as `full` or `range` variant). Store in closure variable; pass to `fetchClassifications`.
4. In `fetchFileIntelligence`, add third try-block:
   ```ts
   try {
       result.classifications = await fetchClassifications(conn, uri, text, token, legend);
   } catch { /* leave at [] */ }
   ```
5. Add unit test simulating semanticTokens failure mid-request (destroy socket after codeLens + inlay responses but before semanticTokens). Assert `result.classifications === []` and codeLens + inlay still populated.

Run: `cd packages/pyright-mcp && npx jest socket-lsp-client --forceExit` — expect pass.

### Step 9: RED — formatFileIntelligenceBlock classifications tests

File: `packages/pyright-mcp/src/tests/hooks/format-block.test.ts`

Extend `formatFileIntelligenceBlock` describe with:
- Classification with same line as a codeLens: tag appended inline (space-separated). Assert `/L4.*Greeter.*refs=3.*impls=2.*abstract/`.
- Standalone classification (no codeLens peer): body contains `/L99\s+protocol/`.
- Multiple classifications at same line: alphabetic order — `abstract override protocol`.
- Inline classifications consume NO slot budget; standalone classifications claim slots from remaining-budget BEFORE inlay does (test: 100 codeLens + 50 inlay + 5 standalone classifications → output has all classifications visible; some inlay truncated).
- Combined MAX_LINES cap still enforced.

Run: `cd packages/pyright-mcp && npx jest format-block --forceExit` — expect failures (current formatter ignores `classifications`).

### Step 10: GREEN — classification rendering

File: `packages/pyright-mcp/src/hooks/format-block.ts`

1. Extend `FileIntelligence` type with `classifications: ClassificationHint[]`.
2. Build `Map<line, string[]>` keyed by line of classifications. For each visible codeLens, look up tags at that line, sort alphabetic, append to rendered string space-separated.
3. Classifications without a codeLens peer become MergedEntry kind `'classification'`; tiebreak at same line: `lens < inlay < classification`.
4. Remaining-budget allocation order: (a) all codeLens up to MAX_LINES by score; (b) standalone classifications up to remaining; (c) inlay up to remaining. Dedupe classifications by `(line, tag)`.
5. `formatFileIntelligence(path, lenses)` legacy wrapper stays unchanged (delegates with `inlayHints: [], classifications: []`).

Run: `cd packages/pyright-mcp && npx jest format-block --forceExit` — expect pass.

### Step 11: RED — enrich-file end-to-end

File: `packages/pyright-mcp/src/tests/hooks/enrich-file.test.ts`

Extend the existing sample.py happy-path test: `additionalContext` matches `/L4[^\n]*Greeter[^\n]*abstract/`.

Run: `cd packages/pyright-mcp && npx jest enrich-file --forceExit` — expect failure (classifications not flowing end-to-end yet).

### Step 12: GREEN — wire enrich-file empty-suppression gate

File: `packages/pyright-mcp/src/hooks/enrich-file.ts`

Update gate to three lists: `if (intel.codeLenses.length === 0 && intel.inlayHints.length === 0 && intel.classifications.length === 0) return {};`. No other change — `formatFileIntelligenceBlock` already consumes the full intel.

Run: `cd packages/pyright-mcp && npx jest enrich-file --forceExit` — expect pass.

### Step 13: Full verify + bundle rebuild + e2e

1. `cd packages/pyright-mcp && npx jest --forceExit` — all pass.
2. `cd packages/pyright-internal && npm run test:norebuild` — all pass, zero regressions.
3. `cd /Volumes/code/pyright && npm run typecheck` — clean.
4. `cd packages/pyright-mcp && npm run webpack` — rebuild bundle.
5. Re-run `/tmp/verify-enrich.sh` — confirm sample.py block shows `L4  Greeter  refs=3  impls=2  abstract` alongside existing inlay lines. Non-Python Read still returns `{}`.

## Success Criteria

- [ ] `tokenModifiers` in `tokenLegend` extended to `['abstract', 'protocol', 'override']`
- [ ] SemanticTokensProvider emits `abstract` modifier when `isAbstractClass(classType)`
- [ ] SemanticTokensProvider emits `protocol` modifier when `isProtocolClass(classType)`
- [ ] SemanticTokensProvider emits `override` modifier when the method has a `@override` / `@typing.override` decorator resolved through the binder (NOT a raw string match)
- [ ] Fourslash test `semanticTokens.classifications.fourslash.ts` covers all three modifiers and passes
- [ ] `testState.ts` gains `verifySemanticTokenModifiers` helper alongside `verifySemanticTokens`
- [ ] pyright-internal full suite passes — no regression in existing `semanticTokens.*.fourslash.ts` tests
- [ ] `FileIntelligence` interface gains `classifications: ClassificationHint[]` field
- [ ] `fetchFileIntelligence` calls `textDocument/semanticTokens/full`, decodes with legend captured at initialize, filters to the three target modifiers
- [ ] semanticTokens failure preserves codeLens + inlay — third try-block returns empty `classifications: []` on throw; unit test covers mid-request socket destruction
- [ ] `formatFileIntelligenceBlock` appends classification tags inline on codeLens lines when positions match; emits standalone `L{line}  {tag}` lines otherwise; alphabetic order for multiple tags at the same line
- [ ] Combined MAX_LINES cap still enforced — inline classifications free; standalone classifications claim slots before inlay
- [ ] `formatFileIntelligence` legacy wrapper still produces identical output to pyr-noe tests (backward compat preserved)
- [ ] Block for `sample.py` contains `abstract` tag on the `Greeter` line (L4) end-to-end
- [ ] `cd packages/pyright-mcp && npx jest --forceExit` — all tests pass
- [ ] `npm run typecheck` — clean
- [ ] End-to-end scripted verify shows classification tags in the bundled output

## Anti-Patterns

- **Don't extend `tokenTypes`.** The three target classifications are token MODIFIERS, not new kinds of symbols. Adding them as types would break existing fourslash tests that assert specific type strings.
- **Don't string-match decorator names.** Resolve through the binder. `from typing import override` must trigger; `def override(fn): ...` defined locally must NOT.
- **Don't introduce a fourth fetch call for classifications only.** `textDocument/semanticTokens/full` already covers it — decode the modifier bitset.
- **Don't emit classifications without line positions.** Malformed entries get dropped at the hook layer.
- **Don't modify pyr-tcv's anti-pattern silently.** When closing this task, update pyr-tcv's anti-pattern section to document the relaxation scope (semantic-tokens legend extension, NOT general enrichment-in-language-server).

## Key Considerations

- **Legend capture timing:** Pyright provides the legend statically in `InitializeResult.capabilities.semanticTokensProvider.legend`. If absent on some server variant, skip classification fetch entirely (graceful degradation).
- **`abstract` semantics in LSP spec:** the standard `abstract` modifier applies to "abstract classes / methods." Scope stays class-level for this task; abstract-method emission is a second-order concern.
- **Protocol and override are custom modifiers:** LSP clients that enforce strict-legend validation may log warnings. Node.js `vscode-jsonrpc` does NOT enforce; our MCP decoder doesn't either.
- **Cold-cache semantics:** Similar to pyr-bay's inlay finding — first `textDocument/semanticTokens/full` on cold Pyright may return fewer modifiers than warm. Document as Temporal Betrayal if observed during Step 13 verify. Fail-open is correct; do not add extra polling.
- **Bundle rebuild required:** after pyright-internal change flows through the bundle (see `reference_rebuild_dist_for_mcp` memory). Step 13 covers.

## Failure Catalog

### semanticTokensProvider.ts extension

**Dependency Treachery: `isAbstractClass` / `isProtocolClass` API drift**
- Assumption: `types.ts` exports `isAbstractClass` and `isProtocolClass` with current signatures.
- Betrayal: Only `isProtocolClass` is confirmed at `types.ts:1256`; `isAbstractClass` presence not yet verified. Pyright-internal may have renamed or removed it.
- Consequence: Compile error; task cannot proceed.
- Mitigation (structural): Step 3 opens implementation with `LSP.hover` verification of both primitives. If `isAbstractClass` is missing, use inline `ClassTypeFlags` bit check — do not invent a new export.

**Input Hostility: Decorator name collisions**
- Assumption: Only `typing.override` should trigger the `override` modifier.
- Betrayal: User code can define `def override(fn): ...` locally, import from a non-typing module, or alias `from typing import override as decorate`.
- Consequence: False positives or false negatives.
- Mitigation (structural): Step 5 resolves decorator name through the binder to canonical declaration. Accept only symbols whose declaration module is `typing` and name is `override`. Anti-pattern explicitly rejects string comparison.

### socket-lsp-client.ts

**Temporal Betrayal: Legend not captured before semanticTokens request**
- Assumption: `initialize` response carries the legend before the first semanticTokens call.
- Betrayal: If initialize is awaited correctly, this is safe — but a refactor could race them.
- Consequence: Decoder falls back to `unknown(idx)` strings; filter drops all entries; classifications silently empty.
- Mitigation (structural): Await initialize completion; store legend in local variable scoped to the same `try`. Do not use a module-level cache — each fetch is a fresh connection with its own legend.

### format-block.ts

**Resource Exhaustion: Classifications dilute inlay budget**
- Assumption: Classifications mostly attach to existing codeLens lines (inline), consuming no budget.
- Betrayal: Some classifications may be standalone (e.g., Protocol class whose codeLens was truncated by score-cap).
- Consequence: Standalone classifications compete with inlay for remaining-budget slots.
- Mitigation (structural): Budget allocation order: codeLens (score-cap) → standalone classifications → inlay. Classifications are higher-signal than per-local type hints; they claim slots first. Structural test asserts the prioritization (e.g., 100 codeLens + 50 inlay + 5 standalone classifications → classifications visible, some inlay truncated).

### enrich-file.ts

**State Corruption: Empty-suppression gate extended to three lists**
- Assumption: Updating the gate is mechanical.
- Betrayal: Half-refactor leaves gate at two lists; a classification-only file produces empty block.
- Consequence: Rare but real — a module defining only abstract classes with no concrete implementations would suppress.
- Mitigation (structural): Regression test covers all-three-empty vs any-non-empty; same structural pattern pyr-bay established.

## Log

(None yet — to be added during execution.)
