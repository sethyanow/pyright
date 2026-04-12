/// <reference path="typings/fourslash.d.ts" />

// Transitive subclass discovery: leaf.py imports from middle.py, NOT from base.py.
// The codeLens implementation count on Base must still find both subclasses
// even though leaf.py has no direct import relationship with base.py.

// @filename: base.py
//// from abc import ABC, abstractmethod
////
//// class /*base*/Base(ABC):
////     @abstractmethod
////     def method(self) -> None: ...

// @filename: middle.py
//// from base import Base
////
//// class Middle(Base):
////     def method(self) -> None:
////         pass

// @filename: leaf.py
//// from middle import Middle
////
//// class Leaf(Middle):
////     def method(self) -> None:
////         pass

{
    // Base should show 2 implementations (Middle + Leaf)
    // even though leaf.py doesn't directly import base.py.
    // This verifies transitive subclass discovery works across the import graph.
    helper.verifyCodeLens({
        base: { title: '2 implementations', kind: 'implementations' },
    });
}
