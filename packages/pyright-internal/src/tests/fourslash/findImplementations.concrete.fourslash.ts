/// <reference path="typings/fourslash.d.ts" />

// @filename: test.py
//// class /*marker1*/ConcreteClass:
////     def /*marker2*/method(self) -> None:
////         pass

{
    helper.verifyFindImplementations({
        marker1: {
            implementations: [],
        },
        marker2: {
            implementations: [],
        },
    });
}
