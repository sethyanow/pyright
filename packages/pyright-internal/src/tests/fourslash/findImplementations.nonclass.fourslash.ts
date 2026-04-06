/// <reference path="typings/fourslash.d.ts" />

// @filename: test.py
//// def /*marker1*/standalone_func() -> None:
////     pass
////
//// /*marker2*/x = 42
////
//// class Foo:
////     /*marker3*/value = 10

{
    // Cursor on a function, variable, and class field — all should return empty
    helper.verifyFindImplementations({
        marker1: {
            implementations: [],
        },
        marker2: {
            implementations: [],
        },
        marker3: {
            implementations: [],
        },
    });
}
