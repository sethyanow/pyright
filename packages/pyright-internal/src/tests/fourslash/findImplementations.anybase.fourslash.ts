/// <reference path="typings/fourslash.d.ts" />

// Regression test: classes with Any in their MRO should not appear as
// implementations of an unrelated ABC. See pyr-tbs.

// @filename: base.py
//// from abc import ABC, abstractmethod
////
//// class /*marker1*/Animal(ABC):
////     @abstractmethod
////     def /*marker2*/speak(self) -> str: ...

// @filename: impl.py
//// from base import Animal
////
//// class [|Dog|](Animal):
////     def [|speak|](self) -> str:
////         return "woof"

// @filename: decoy.py
//// from typing import Any
////
//// # This class has Any in its MRO — it should NOT appear as an
//// # implementation of Animal.
//// class Decoy(Any):
////     def speak(self) -> str:
////         return "I am not an Animal"

// @filename: hybrid.py
//// from typing import Any
//// from base import Animal
////
//// # Real subclass that also inherits from Any — should still appear
//// # because the Animal path is concrete.
//// class [|HybridDog|](Animal, Any):
////     def [|speak|](self) -> str:
////         return "woof (hybrid)"

{
    const rangeMap = helper.getRangesByText();

    helper.verifyFindImplementations({
        marker1: {
            implementations: ['Dog', 'HybridDog'].flatMap((name) =>
                rangeMap
                    .get(name)!
                    .filter((r) => !r.marker)
                    .map((r) => ({
                        path: r.fileName,
                        range: helper.convertPositionRange(r),
                    }))
            ),
        },
        marker2: {
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
