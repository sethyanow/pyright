/// <reference path="typings/fourslash.d.ts" />

// ADVERSARIAL: Unicode class names
// Tests that string filter handles non-ASCII class names correctly.

// @filename: base.py
//// from abc import ABC, abstractmethod
////
//// class /*base*/Животное(ABC):  # "Animal" in Russian
////     @abstractmethod
////     def говорить(self) -> str: ...  # "speak" in Russian

// @filename: child.py
//// from base import Животное
////
//// class Собака(Животное):  # "Dog" in Russian
////     def говорить(self) -> str:
////         return "гав"  # "woof" in Russian

{
    // Животное should show 1 implementation: Собака
    helper.verifyCodeLens({
        base: { title: '1 implementation', kind: 'implementations' },
    });
}
