/// <reference path="typings/fourslash.d.ts" />

// Tests transitive subclass discovery across multiple files.
// GoldenRetriever inherits from Dog which inherits from Animal.
// The file leaf.py does NOT mention "Animal" anywhere — only "Dog".
// This tests that the implementation provider correctly finds transitive subclasses
// even when the file containing the leaf class doesn't textually reference the base.

// @filename: base.py
//// from abc import ABC, abstractmethod
////
//// class /*animal*/Animal(ABC):
////     @abstractmethod
////     def speak(self) -> str: ...

// @filename: middle.py
//// from base import Animal
////
//// class Dog(Animal):
////     def speak(self) -> str:
////         return "woof"

// @filename: leaf.py
//// from middle import Dog
////
//// class GoldenRetriever(Dog):
////     def speak(self) -> str:
////         return "woof woof"

{
    // Animal should show 2 implementations: Dog and GoldenRetriever
    // Even though leaf.py never mentions "Animal" directly
    helper.verifyCodeLens({
        animal: { title: '2 implementations', kind: 'implementations' },
    });
}
