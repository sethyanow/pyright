/// <reference path="typings/fourslash.d.ts" />

// @filename: test.py
//// from abc import ABC, abstractmethod
//// from typing import Protocol, override
////
//// # Abstract class (has ABCMeta metaclass)
//// class /*abstractClass*/AbstractBase(ABC):
////     @abstractmethod
////     def /*abstractMethod*/must_implement(self) -> None:
////         pass
////
//// # Protocol class
//// class /*protocolClass*/Readable(Protocol):
////     def read(self) -> str:
////         ...
////
//// # Concrete class with explicit override
//// class /*concreteClass*/Concrete(AbstractBase):
////     @override
////     def /*explicitOverride*/must_implement(self) -> None:
////         pass
////
//// # Implicit override (no @override decorator but shadows parent)
//// class /*childClass*/Child(Concrete):
////     def /*implicitOverride*/must_implement(self) -> None:
////         pass
////
//// # Non-matching: regular class
//// class /*regularClass*/Regular:
////     def /*regularMethod*/normal_method(self) -> None:
////         pass

{
    helper.verifySemanticTokensWithModifiers({
        abstractClass: { type: 'class', modifiers: ['abstract'] },
        abstractMethod: { type: 'method', modifiers: ['abstract'] },
        protocolClass: { type: 'class', modifiers: ['protocol'] },
        concreteClass: { type: 'class', modifiers: [] },
        explicitOverride: { type: 'method', modifiers: ['override'] },
        childClass: { type: 'class', modifiers: [] },
        implicitOverride: { type: 'method', modifiers: ['override'] },
        regularClass: { type: 'class', modifiers: [] },
        regularMethod: { type: 'method', modifiers: [] },
    });
}
