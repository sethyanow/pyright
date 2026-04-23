---
id: pyr-oq2
title: Semantic walker emits [override] on classes with no parent class
status: closed
type: bug
priority: 1
owner: Seth
parent: pyr-a7n
---











## Context

Surfaced during shakedown of pyr-a7n (Phase 5.5b acceptance). The PostToolUse enrichment hook produced a `<file-intelligence>` block on Read of `packages/pyright-internal/src/tests/samples/protocol1.py` containing:

```
L47:7 class Proto_Impl refs=1
L48:9 method m1 [override]
```

`Proto_Impl` (L47) has NO base class — it is `class Proto_Impl:` with no inheritance. Therefore `m1` cannot be overriding anything. The `[override]` modifier is a false positive.

Sub-task A (semantic token modifiers: abstract/protocol/override) extended pyright-internal's `semanticTokensProvider` walker to emit `override` for both explicit `@override` decorator and implicit parent-shadowing detection. The implicit-shadowing path is the suspect.

Likely failure modes (need walker code inspection to confirm):
- Walker checks "any same-named method in module scope" rather than "method in actual base class"
- Walker performs structural Protocol matching (Proto_Impl matches `Proto[T]` from protocol1.py via duck typing) and tags the protocol-conformant method as override
- Walker walks symbols incorrectly when there is no parent class

## Repro

Hot path (live session):
1. Ensure pyright-mcp plugin is installed (it is, on this dev machine)
2. Read `/Volumes/code/pyright/packages/pyright-internal/src/tests/samples/protocol1.py` via the Read tool
3. Observe `<file-intelligence>` block in the PostToolUse system-reminder
4. Confirm the line `L48:9 method m1 [override]` appears even though `Proto_Impl` (L47) has no base class

CLI path:
```bash
cd /Volumes/code/pyright/packages/pyright-mcp
PYRIGHT_PROXY_STATE_DIR=/tmp/pyright-bug-state node dist/mcp-server.js  # via MCP client
# or via hook directly:
echo '{"hook_event_name":"PostToolUse","tool_name":"Read","tool_input":{"file_path":"/Volumes/code/pyright/packages/pyright-internal/src/tests/samples/protocol1.py"}}' \
  | PYRIGHT_PROXY_STATE_DIR=/tmp/pyright-bug-state node dist/hooks/enrich-file.js \
  | jq -r '.hookSpecificOutput.additionalContext'
```

## Expected behavior

`[override]` modifier emitted only when:
- method has explicit `@override` decorator from `typing` (PEP 698), OR
- at least one direct or transitive base class declares a method with the same name (parent-shadowing)

Classes with NO base class declaration cannot have methods marked `[override]`. Period.

## Investigation pointers

- `packages/pyright-internal/src/languageService/semanticTokensProvider.ts` — walker that emits modifiers; check the override-detection branch
- The `SemanticTokenWalker` was extended in Sub-task A to compute modifier bitsets for `abstract`, `protocol`, `override`
- Compare to Pyright's own override-checking logic in `analyzer/checker.ts` (the override decorator validator) — it should already have the canonical "is this a parent-class shadow?" logic that the walker can borrow

## Success Criteria

- [x] Walker's override-detection branch reviewed — canonical: `FunctionTypeFlags.Overridden` set only by `@override` decorator (decorators.ts:96), implicit fallback uses `lookUpClassMember(cls, name, Default, skipMroClass=cls)` which skips MRO up to and including the declaring class. No structural-match path and no other flag mutator exists.
- [N/A] Fix applied — walker was already correct in current code. Transcript-session bug could not be reproduced across any path (CLI, live hook, MCP tool, raw LSP, cold-respawn). `pyright-internal.js` hash identical between installed plugin and local dist.
- [x] Repro test added: `StructStandalone` case in `semanticTokens.modifiers.adversarial.fourslash.ts` — standalone class whose method name matches a Protocol asserts `modifiers: []` on the non-inheriting method. Defensive regression guard.
- [x] Existing tests pass: `npm run test` → 57 suites / 2394 tests passed.
- [x] `npm run typecheck` clean.

## Anti-Patterns

- Don't disable the implicit-shadowing path entirely — that would lose `[override]` on legitimate parent-shadowing methods (tested in pyr-smw fixtures `sample.py` `EnglishGreeter.greet`/`SpanishGreeter.greet`)
- Don't widen `[override]` to mean "structural protocol conformance" — that's a different concept and would be confusing UX

## Key Considerations

- Sample-based regression test should pin both directions: (a) inheriting class with shadowing method → `[override]` present; (b) standalone class whose method happens to match a Protocol → `[override]` absent
- This blocks pyr-a7n acceptance. Incorrect semantic modifiers on definition-site tokens are wrong output, not noise — the agent reading the block infers "this method overrides something" and that is false.

## Log

- [2026-04-22T07:05:15Z] [Seth] Investigation findings — bug is real-but-intermittent, root cause NOT isolated. Evidence summary: (1) Transcript from prior session (820c702f-...jsonl) shows EVERY method in protocol1.py emitted [override] — not just Proto_Impl.m1 (L48) but also Box.content (L11), Box_Impl.content (L15), Sender.send (L26), Sender_Impl.send (L30), Proto.m1 (L41), Abstract1.do (L76), Concrete1.do (L80). Same transcript also shows subscripts stripped ('var : Proto' instead of 'var : Proto[float]') — both pyr-oq2 and the previously-dismissed #1 were symptoms of the same state. (2) Current runs reproduce neither bug. Raw Pyright semanticTokens for L47:8 (Proto_Impl.m1) returns 'tokenModifiers: []'. Walker code and pyright-internal.js hash are identical between installed plugin and local dist. Only decorators.ts:96 sets FunctionTypeFlags.Overridden, and only from @override decorator. lookUpClassMember with skipMroClass=enclosingClassType is correctly scoped. (3) Five-run stress test against warm shared Pyright: no reproduction. Fresh state dir: no reproduction. (4) Regression test added: semanticTokens.modifiers.adversarial.fourslash.ts now includes StructStandalone case (no base, method name matches Protocol). Test passes, full modifiers test suite passes (2/2), typecheck clean. OPEN QUESTION for user: root cause is unknown — same code, same binary, different output across sessions. Options: (a) accept regression test as defense-in-depth and close; (b) keep investigating root cause (Pyright state race? typeshed variance?); (c) leave open pending further repro.
- [2026-04-22T14:38:13Z] [Seth] Tried cold-respawn via live MCP: killed Pyright PID 95782, fresh hook fire on protocol1.py — still NO override false-positive. Walker behaves correctly across every reproduction path tested: (a) CLI probes via enrich-file.js with fresh state dir, (b) CLI probes via lsp-client.js, (c) live PostToolUse hook in organic Read flow (5+ runs this session, all correct), (d) live MCP server file_intelligence tool, (e) raw LSP textDocument/semanticTokens via MCP, (f) post-kill fresh-Pyright Read via hook. None reproduce the transcript's override false-positive. Decoder audit: legend ['abstract','protocol','override'] shared between server-publish and client-decode via same tokenLegend object reference in languageServerBase.ts:715 — bit-shift encoding symmetric, no mis-decode possible. Flag audit: FunctionTypeFlags.Overridden is set ONLY by decorators.ts:96 via @override decorator — no other mutator found in types.ts cloneAs*, no other site sets shared.flags|=Overridden anywhere. Cannot construct the environmental condition that produced the transcript bug. SIDE EFFECT: killing Pyright left MCP server (pid 30128) with stale PID file (17494 dead); MCP tools unavailable until session reload. Hook still works (spawns transient Pyrights).
