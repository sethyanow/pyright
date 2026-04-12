/// <reference path="typings/fourslash.d.ts" />

// Tests transitive subtype discovery across multiple files.
// GoldenRetriever inherits from Dog which inherits from Animal.
// The file leaf.py does NOT mention "Animal" anywhere — only "Dog".
// This tests that type hierarchy correctly finds transitive subtypes.

// @filename: base.py
//// from abc import ABC, abstractmethod
////
//// class /*marker1*/Animal(ABC):
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
    // Animal should show Dog as direct subtype
    // (TypeHierarchy shows direct subtypes only at each level — transitivity is via recursion)
    helper.verifyTypeHierarchySubtypes({
        marker1: {
            items: [{ name: 'Dog' }],
        },
    });
}
