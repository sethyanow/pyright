/// <reference path="typings/fourslash.d.ts" />

// @filename: test.py
//// from typing import Protocol
////
//// class /*marker1*/MyProtocol(Protocol):
////     def method(self) -> int: ...
////
//// class /*marker2*/Impl(MyProtocol):
////     def method(self) -> int:
////         return 42
////
//// from abc import ABC, abstractmethod
////
//// class /*marker3*/MyABC(ABC):
////     @abstractmethod
////     def do_thing(self) -> None: ...
////
//// class ConcreteABC(MyABC):
////     def do_thing(self) -> None:
////         pass

{
    // Impl's supertypes include MyProtocol (nominal inheritance).
    helper.verifyTypeHierarchySupertypes({
        marker2: {
            items: [{ name: 'MyProtocol' }],
        },
    });

    // MyProtocol's subtypes include Impl (nominal subclass).
    helper.verifyTypeHierarchySubtypes({
        marker1: {
            items: [{ name: 'Impl' }],
        },
    });

    // MyABC's subtypes include ConcreteABC.
    helper.verifyTypeHierarchySubtypes({
        marker3: {
            items: [{ name: 'ConcreteABC' }],
        },
    });
}
