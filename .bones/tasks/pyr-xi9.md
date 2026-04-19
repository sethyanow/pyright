---
id: pyr-xi9
title: Extend pyright-internal semanticTokens tokenModifiers
status: open
type: task
priority: 1
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

SRE refinement in the next `executing-plans` session will turn these into concrete steps with verified file paths and helper references.

- Extend `tokenLegend.tokenModifiers` array in `semanticTokensProvider.ts`.
- Compute modifier bitset in `_classifyName` (or a new helper); return alongside tokenType.
- Change `_pushToken` signature to accept a bitset; pass it to `builder.push`.
- Use existing pyright-internal helpers for detection (`isProtocolClass`, `ClassType` flags, `reportImplicitOverride` logic in `checker.ts`). Do NOT string-match decorators — resolve through the binder.
- Test via fourslash harness; may need a new `verifySemanticTokenModifiers` helper (existing `verifySemanticTokens` only asserts tokenType).

## Success Criteria

- [ ] `tokenLegend.tokenModifiers` includes `abstract`, `protocol`, `override`
- [ ] Abstract class (inherits `abc.ABC` or has abstract methods): gets `abstract`
- [ ] `@abstractmethod`-decorated method: gets `abstract`
- [ ] `class Foo(Protocol):`: gets `protocol`
- [ ] `@override def bar():`: gets `override`
- [ ] Method shadowing parent without `@override`: gets `override`
- [ ] Non-matching symbols do NOT get these modifiers
- [ ] Full test suite passes: `cd packages/pyright-internal && npm run test:norebuild`
- [ ] `npm run typecheck` clean

## Anti-Patterns

- **Don't string-match decorator text.** Resolve decorators through the binder. `from typing import override` must trigger the modifier; a locally-defined `def override(fn):` must not.
- **Don't hardcode modifier bit indices in consumers.** Bits are read from the live legend advertised by Pyright on initialize.
- **Don't change existing tokenType emissions.** Modifiers are additive; tokenType semantics unchanged.
- **Don't invent new analysis.** Reuse existing pyright-internal helpers. If a needed helper doesn't exist, surface it to the user — don't write new analysis code silently.

## Key Considerations

- The legend order matters — clients read modifiers as bit positions into the advertised array. Pick the order once and don't change it.
- Protocol classes and abstract classes can overlap (a Protocol can have `@abstractmethod`). Both modifiers may apply to the same symbol — bitset supports this natively.
- Implicit-override detection needs access to parent-class methods. Check how `reportImplicitOverride` in `checker.ts` resolves this — reuse the resolution path rather than re-walking the MRO.
- Fourslash test harness currently only verifies tokenType. Adding modifier assertions requires a parallel helper — treat this as part of sub-task scope.
