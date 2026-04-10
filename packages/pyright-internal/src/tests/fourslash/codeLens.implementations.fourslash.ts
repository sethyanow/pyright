/// <reference path="typings/fourslash.d.ts" />

// @filename: test.py
//// from abc import ABC, abstractmethod
////
//// class /*base*/Base(ABC):
////     @abstractmethod
////     def do_thing(self) -> None: ...
////
//// class Child1(Base):
////     def do_thing(self) -> None:
////         pass
////
//// class Child2(Base):
////     def do_thing(self) -> None:
////         pass

{
    helper.verifyCodeLens({
        base: { title: '2 implementations', kind: 'implementations' },
    });
}
