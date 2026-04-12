/// <reference path="typings/fourslash.d.ts" />

// Tests transitive method override discovery across multiple files.
// GoldenRetriever inherits from Dog which inherits from Animal.
// The file leaf.py does NOT mention "Animal" anywhere — only "Dog".
// This tests that the implementation provider correctly finds transitive method overrides.

// @filename: base.py
//// from abc import ABC, abstractmethod
////
//// class Animal(ABC):
////     @abstractmethod
////     def /*marker1*/speak(self) -> str: ...

// @filename: middle.py
//// from base import Animal
////
//// class [|Dog|](Animal):
////     def [|speak|](self) -> str:
////         return "woof"

// @filename: leaf.py
//// from middle import Dog
////
//// class [|GoldenRetriever|](Dog):
////     def [|speak|](self) -> str:
////         return "woof woof"

{
    const rangeMap = helper.getRangesByText();

    // goToImplementation on Animal.speak should find overrides in Dog and GoldenRetriever
    // Even though leaf.py never mentions "Animal" directly
    helper.verifyFindImplementations({
        marker1: {
            implementations: rangeMap
                .get('speak')!
                .filter((r) => !r.marker)
                .map((r) => ({
                    path: r.fileName,
                    range: helper.convertPositionRange(r),
                })),
        },
    });
}
