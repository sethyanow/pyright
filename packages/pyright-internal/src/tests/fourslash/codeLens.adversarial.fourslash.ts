/// <reference path="typings/fourslash.d.ts" />

// Adversarial: file with no classes or functions — only variables and imports
// Should produce zero code lenses

// @filename: test.py
//// import os
////
//// x = 42
//// y: str = "hello"
//// PI = 3.14

// @filename: nested.py
//// class /*outer*/Outer:
////     class /*inner*/Inner:
////         def /*method*/do_thing(self) -> None:
////             pass
////
//// def /*unused*/unused_func() -> None:
////     """Never called anywhere"""
////     pass

{
    // Test 1: nested.py — methods inside nested classes get lenses
    // Outer has 0 references (never instantiated), Inner has 0, method has 0, unused_func has 0
    helper.verifyCodeLens({
        outer: { title: '0 references', kind: 'references' },
        inner: { title: '0 references', kind: 'references' },
        method: { title: '0 references', kind: 'references' },
        unused: { title: '0 references', kind: 'references' },
    });
}
