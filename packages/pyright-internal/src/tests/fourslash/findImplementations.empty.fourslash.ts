/// <reference path="typings/fourslash.d.ts" />

// @filename: test.py
//// from abc import ABC, abstractmethod
////
//// class /*marker1*/Empty(ABC):
////     @abstractmethod
////     def /*marker2*/do_something(self) -> None: ...

{
    // No implementations exist anywhere — should return empty, not error
    helper.verifyFindImplementations({
        marker1: {
            implementations: [],
        },
        marker2: {
            implementations: [],
        },
    });
}
