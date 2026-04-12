/// <reference path="typings/fourslash.d.ts" />

// ADVERSARIAL: Diamond inheritance pattern
// Tests that BFS handles multiple inheritance paths correctly.
//
//       Animal
//       /    \
//     Dog    Cat
//       \    /
//       Hybrid
//
// BFS should find all three subclasses, not double-count any.

// @filename: animal.py
//// from abc import ABC, abstractmethod
////
//// class /*animal*/Animal(ABC):
////     @abstractmethod
////     def speak(self) -> str: ...

// @filename: dog.py
//// from animal import Animal
////
//// class Dog(Animal):
////     def speak(self) -> str:
////         return "woof"

// @filename: cat.py
//// from animal import Animal
////
//// class Cat(Animal):
////     def speak(self) -> str:
////         return "meow"

// @filename: hybrid.py
//// from dog import Dog
//// from cat import Cat
////
//// class Hybrid(Dog, Cat):
////     def speak(self) -> str:
////         return "woofmeow"

{
    // Animal should show 3 implementations: Dog, Cat, Hybrid
    // Hybrid inherits from both Dog and Cat, which both inherit from Animal.
    // BFS via Dog: Animal → Dog → Hybrid
    // BFS via Cat: Animal → Cat → (Hybrid already processed via Dog path)
    helper.verifyCodeLens({
        animal: { title: '3 implementations', kind: 'implementations' },
    });
}
