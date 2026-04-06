/// <reference path="typings/fourslash.d.ts" />

// @filename: test.py
//// from abc import ABC, abstractmethod
////
//// class /*marker1*/Animal(ABC):
////     @abstractmethod
////     def /*marker2*/speak(self) -> str: ...
////
//// class [|Dog|](Animal):
////     def [|speak|](self) -> str:
////         return "woof"
////
//// class [|Cat|](Animal):
////     def [|speak|](self) -> str:
////         return "meow"

{
    const rangeMap = helper.getRangesByText();

    helper.verifyFindImplementations({
        marker1: {
            implementations: ['Dog', 'Cat'].flatMap((name) =>
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
