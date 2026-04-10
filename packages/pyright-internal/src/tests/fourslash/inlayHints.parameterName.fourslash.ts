/// <reference path="typings/fourslash.d.ts" />

// @filename: test.py
//// def greet(name: str, greeting: str) -> str:
////     return f"{greeting} {name}"
////
//// greet(/*p1*/"Alice", /*p2*/"Hello")
////
//// greet(name="Alice", greeting="Hello")
////
//// class Point:
////     def __init__(self, x: int, y: int):
////         self.x = x
////         self.y = y
////
//// Point(/*p3*/1, /*p4*/2)

{
    // p1, p2: positional args → should get parameter name hints
    // keyword args → should NOT get hints
    // p3, p4: constructor call → should get parameter name hints (skipping self)
    helper.verifyInlayHints({
        p1: { label: 'name=', kind: 'parameter' },
        p2: { label: 'greeting=', kind: 'parameter' },
        p3: { label: 'x=', kind: 'parameter' },
        p4: { label: 'y=', kind: 'parameter' },
    });
}
