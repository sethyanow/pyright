/// <reference path="typings/fourslash.d.ts" />

// @filename: test.py
//// from typing import Protocol
////
//// class Drawable(Protocol):
////     def /*marker1*/draw(self) -> None: ...
////
//// class [|Circle|](Drawable):
////     def [|draw|](self) -> None:
////         pass
////
//// class [|Square|](Drawable):
////     def [|draw|](self) -> None:
////         pass
////
//// class NotDrawable:
////     def move(self) -> None:
////         pass
////
//// x: /*marker2*/Drawable

{
    const rangeMap = helper.getRangesByText();

    helper.verifyFindImplementations({
        marker1: {
            implementations: rangeMap
                .get('draw')!
                .filter((r) => !r.marker)
                .map((r) => ({
                    path: r.fileName,
                    range: helper.convertPositionRange(r),
                })),
        },
        marker2: {
            implementations: ['Circle', 'Square'].flatMap((name) =>
                rangeMap
                    .get(name)!
                    .filter((r) => !r.marker)
                    .map((r) => ({
                        path: r.fileName,
                        range: helper.convertPositionRange(r),
                    }))
            ),
        },
    });
}
