/// <reference path="typings/fourslash.d.ts" />

// @filename: base.py
//// from abc import ABC, abstractmethod
////
//// class /*marker1*/Shape(ABC):
////     @abstractmethod
////     def /*marker2*/area(self) -> float: ...

// @filename: impl.py
//// from base import Shape
////
//// class [|Triangle|](Shape):
////     def [|area|](self) -> float:
////         return 0.0

{
    const rangeMap = helper.getRangesByText();

    helper.verifyFindImplementations({
        marker1: {
            implementations: rangeMap
                .get('Triangle')!
                .filter((r) => !r.marker)
                .map((r) => ({
                    path: r.fileName,
                    range: helper.convertPositionRange(r),
                })),
        },
        marker2: {
            implementations: rangeMap
                .get('area')!
                .filter((r) => !r.marker)
                .map((r) => ({
                    path: r.fileName,
                    range: helper.convertPositionRange(r),
                })),
        },
    });
}
