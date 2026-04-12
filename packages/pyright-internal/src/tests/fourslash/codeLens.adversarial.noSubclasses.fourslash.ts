/// <reference path="typings/fourslash.d.ts" />

// ADVERSARIAL: Class with no subclasses (empty case)
// Tests that BFS terminates correctly when no subclasses exist.

// @filename: lonely.py
//// class /*lonely*/LonelyClass:
////     def alone(self) -> None:
////         pass

// @filename: other.py
//// # Unrelated class — shares no inheritance with LonelyClass
//// class OtherClass:
////     pass

{
    // LonelyClass has no subclasses — should show no code lens
    // (or "0 implementations" depending on provider behavior)
    helper.verifyCodeLens({
        lonely: { title: '0 implementations', kind: 'implementations' },
    });
}
