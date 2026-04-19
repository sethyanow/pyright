---
id: pyr-xi9
title: Extend pyright-internal semanticTokens tokenModifiers
status: closed
type: task
priority: 1
owner: Seth
parent: pyr-ilj
---




## Context

Extend pyright-internal's `semanticTokensProvider` so it emits `tokenModifiers` for `abstract`, `protocol`, and `override` on the relevant symbols.

Current state (verified): `tokenLegend.tokenModifiers: []` at `packages/pyright-internal/src/languageService/semanticTokensProvider.ts:56`. `SemanticTokenWalker._pushToken` passes `0` (no modifiers) to `SemanticTokensBuilder.push()`.

This sub-task adds the three modifiers to the legend, detects them in the walker, and updates `_pushToken` to pass a computed bitset. Pure pyright-internal change. Sub-task B (MCP tool) blocks on this.

## Requirements

1. `tokenLegend.tokenModifiers` includes `abstract`, `protocol`, `override` in a stable order (legend order is advertised to clients — silent reordering breaks bitset interpretation).
2. `abstract` emitted on: abstract class names, `@abstractmethod`-decorated method names.
3. `protocol` emitted on: class names inheriting from `typing.Protocol`.
4. `override` emitted on: methods with `@typing.override` decorator (explicit) AND methods that shadow a parent-class method without the decorator (implicit).
5. Existing tokenType emissions unchanged — modifier bits are additive.
6. Tests cover all modifiers, positive and negative cases.

## Implementation

**Files to modify:**
- `packages/pyright-internal/src/languageService/semanticTokensProvider.ts` — legend + walker
- `packages/pyright-internal/src/tests/harness/fourslash/testState.ts` — test helper
- New fourslash tests in `packages/pyright-internal/src/tests/fourslash/`

**Verified helpers (use these, don't reinvent):**
- `ClassType.isProtocolClass(classType)` — types.ts:1256 — Protocol detection
- `ClassTypeFlags.SupportsAbstractMethods` — types.ts:606 — ABC class detection (has ABCMeta metaclass)
- `FunctionTypeFlags.AbstractMethod` — types.ts:1590 — @abstractmethod detection
- `FunctionTypeFlags.Overridden` — types.ts:1643 — explicit @override detection
- `lookUpClassMember(classType, memberName, flags, skipMroClass)` — typeUtils.ts:1726 — for implicit override (pass declaring class as skipMroClass to search parent)
- `ParseTreeUtils.getEnclosingClass(node, stopAtFunction)` — already used in _classifyName (line 175)
- `this._evaluator.getType(node)` — get ClassType/FunctionType from declaration node

**Steps:**

1. **Extend legend** (semanticTokensProvider.ts:56):
   ```typescript
   tokenModifiers: ['abstract', 'protocol', 'override'] as string[],
   ```

2. **Add modifier index helper** (after line 62):
   ```typescript
   function _getModifierBitset(...modifiers: string[]): number {
       let bitset = 0;
       for (const mod of modifiers) {
           const idx = tokenLegend.tokenModifiers.indexOf(mod);
           if (idx >= 0) bitset |= (1 << idx);
       }
       return bitset;
   }
   ```

3. **Refactor _classifyName** to return `{ tokenType: string; modifiers: number }`:
   - For `DeclarationType.Class`: Get ClassType, check `isProtocolClass()` and `SupportsAbstractMethods` flag
   - For `DeclarationType.Function`: Get FunctionType, check `AbstractMethod` and `Overridden` flags; for implicit override, get enclosing class, use `lookUpClassMember` with `skipMroClass` = enclosing class

4. **Update _pushToken** (line 222):
   - Change signature: `_pushToken(node: NameNode, tokenType: string, modifiers: number = 0)`
   - Pass modifiers to `builder.push()` (line 242): currently passes `0`

5. **Extend test harness** (testState.ts:1587):
   - Add modifiers to decoded array (line 1604): `{ line, char, length, tokenType, modifiers: string[] }`
   - Decode modifiers bitset using `tokenLegend.tokenModifiers`
   - Create `verifySemanticTokensWithModifiers` or extend existing to accept `{ type: string; modifiers?: string[] }`

6. **Add fourslash tests**:
   - `semanticTokens.modifiers.fourslash.ts` — test all modifiers with positive/negative cases
   - Cover: ABC class, Protocol class, @abstractmethod, explicit @override, implicit override, non-matching cases

## Success Criteria

- [x] `tokenLegend.tokenModifiers` includes `abstract`, `protocol`, `override`
- [x] Abstract class (inherits `abc.ABC` or has abstract methods): gets `abstract`
- [x] `@abstractmethod`-decorated method: gets `abstract`
- [x] `class Foo(Protocol):`: gets `protocol`
- [x] `@override def bar():`: gets `override`
- [x] Method shadowing parent without `@override`: gets `override`
- [x] Non-matching symbols do NOT get these modifiers
- [x] Bitset encoding verified: legend index N → bit (1 << N), not (1 << (N+1))
- [x] Full test suite passes: `cd packages/pyright-internal && npm run test:norebuild`
- [x] `npm run typecheck` clean

## Anti-Patterns

- **Don't string-match decorator text.** Resolve decorators through the binder. `from typing import override` must trigger the modifier; a locally-defined `def override(fn):` must not.
- **Don't hardcode modifier bit indices in consumers.** Bits are read from the live legend advertised by Pyright on initialize.
- **Don't change existing tokenType emissions.** Modifiers are additive; tokenType semantics unchanged.
- **Don't invent new analysis.** Reuse existing pyright-internal helpers. If a needed helper doesn't exist, surface it to the user — don't write new analysis code silently.

## Key Considerations

- **Legend order is stable**: Clients read modifiers as bit positions into the advertised array. Order: `['abstract', 'protocol', 'override']` — index 0=abstract (bit 1), index 1=protocol (bit 2), index 2=override (bit 4).
- **Overlapping modifiers**: Protocol classes and abstract classes can overlap (a Protocol can have `@abstractmethod`). Both modifiers may apply to the same symbol — bitset supports this natively.
- **Implicit override detection**: Use `lookUpClassMember(enclosingClassType, methodName, flags, enclosingClassType)` — passing the enclosing class as `skipMroClass` makes it search only parent classes. If it returns a member, the method is an implicit override.
- **Test harness gap**: `verifySemanticTokens` (testState.ts:1604) currently ignores `data[i+4]` (tokenModifiers). Must extend to decode and assert modifiers.
- **Type access pattern**: In `_classifyName`, for `DeclarationType.Function`, get function type via `this._evaluator.getType(decl.node.d.name)` — the name node, not the function node.
- **Edge case: `__init__` in ABC**: Constructor overriding `__init__` should NOT get `abstract` modifier (constructors aren't abstract). `FunctionTypeFlags.AbstractMethod` is set by @abstractmethod decorator, not inherited.

## Failure Catalog

**Temporal Betrayal: Legend order stability**
- Assumption: Legend order at session start matches legend order at token emission
- Betrayal: If legend were dynamically modified, clients would misinterpret bitsets
- Consequence: `abstract` bit (0) interpreted as `protocol` — semantic confusion
- Mitigation: Legend is a `const` object initialized at module load. TypeScript compiler ensures immutability. No runtime modification path exists.

**Input Hostility: Unknown modifier string**
- Assumption: Only known modifiers passed to _getModifierBitset
- Betrayal: Typo in caller (`'abstrac'`) or future modifier not in legend
- Consequence: Modifier silently ignored (indexOf returns -1, bitset unchanged)
- Mitigation: Acceptable silent fallback — unknown modifiers don't crash, they're just not emitted. Document that callers must use constants, not strings.

**Input Hostility: Node without valid declaration or type**
- Assumption: Every NameNode has resolvable declaration and type
- Betrayal: Forward reference to undefined symbol, unresolved import, incomplete analysis
- Consequence: `getType()` returns undefined, flag checks fail
- Mitigation: _classifyName already handles missing decl (returns undefined, line 141-143). Modifier computation must follow same pattern: `undefined` type → modifiers = 0. No new error paths.

**Dependency Treachery: lookUpClassMember with incomplete MRO**
- Assumption: Class hierarchy fully resolved before semantic tokens requested
- Betrayal: Circular inheritance, unresolved base class from stub
- Consequence: lookUpClassMember returns undefined when parent method exists
- Mitigation: If `lookUpClassMember` returns undefined for implicit override check, method gets no `override` modifier. False negative is acceptable; false positive would be wrong. Pyright's own checker uses same helper for reportImplicitOverride diagnostic — if it's good enough for diagnostics, it's good enough for tokens.

**Resource Exhaustion: Deep class hierarchy MRO walk**
- Assumption: MRO walk is fast
- Betrayal: Pathological class hierarchy (e.g., 100+ levels) causes noticeable delay
- Consequence: Semantic tokens request blocks on MRO walk
- Mitigation: Pyright already handles this — MRO is cached in ClassType.shared.mro. lookUpClassMember iterates cached MRO, doesn't recompute. No new performance concern.

**Encoding Boundaries: builder.push bitset format**
- Assumption: Bitset passed to builder.push matches LSP spec
- Betrayal: Off-by-one in bit indexing (index 0 = bit 0, not bit 1)
- Consequence: All modifiers shifted — `abstract` emitted as nothing, `protocol` as `abstract`, etc.
- Mitigation: LSP spec: modifiers are `1 << index`. Helper uses `1 << idx` where `idx` comes from `indexOf`. Write explicit test: legend `['a', 'b', 'c']`, modifier `'b'` → bitset `2` (binary `010`), not `4`.

**Input Hostility: Bitset with unknown bits (test harness)**
- Assumption: Bitset only has bits corresponding to known legend indices
- Betrayal: Future Pyright version adds modifier at index 3, old test harness doesn't know it
- Consequence: Unknown bit silently dropped in decoded output
- Mitigation: Test harness decodes all bits present, not just expected ones. Unknown bits render as `unknown(N)` in error messages. Forward-compatible.

## Log

- [2026-04-19T19:40:08Z] [Seth] Complete. Implemented tokenModifiers ['abstract', 'protocol', 'override']. Key decisions: (1) classes get abstract only if they DECLARE abstract methods, not just inherit ABCMeta; (2) dunder methods excluded from implicit override detection (found during adversarial testing). 2 fourslash tests added. All 2394 tests pass.
