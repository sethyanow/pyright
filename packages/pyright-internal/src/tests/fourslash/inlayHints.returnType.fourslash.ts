/// <reference path="typings/fourslash.d.ts" />

// @filename: test.py
//// def add(x: int, y: int)/*ret1*/:
////     return x + y
////
//// def greet(name: str) -> str:
////     return f"Hello {name}"

{
    // ret1: function without return annotation → should get `: int` hint
    // greet: function WITH return annotation → should NOT get a hint
    helper.verifyInlayHints({
        ret1: { label: ': int', kind: 'type' },
    });
}
