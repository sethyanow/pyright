/// <reference path="typings/fourslash.d.ts" />

// ADVERSARIAL: Class name substring collision
// "Cat" is a substring of "Caterpillar", "Concatenate", etc.
// The string filter uses includes() which matches substrings.
// This tests that we don't get false positives (we might, but behavior should still be correct).

// @filename: base.py
//// from abc import ABC, abstractmethod
////
//// class /*cat*/Cat(ABC):
////     @abstractmethod
////     def meow(self) -> None: ...

// @filename: kitten.py
//// from base import Cat
////
//// class Kitten(Cat):
////     def meow(self) -> None: pass

// @filename: unrelated.py
//// # This file mentions "Caterpillar" but has no relation to Cat
//// class Caterpillar:
////     def crawl(self) -> None: pass
////
//// class Concatenate:
////     def join(self) -> None: pass

{
    // Cat should show 1 implementation: Kitten
    // NOT Caterpillar or Concatenate (they don't inherit from Cat)
    helper.verifyCodeLens({
        cat: { title: '1 implementation', kind: 'implementations' },
    });
}
