/// <reference path="typings/fourslash.d.ts" />

// @filename: test.py
//// class Base:
////     def /*marker1*/process(self) -> None:
////         pass
////
//// class [|Middle|](Base):
////     def [|process|](self) -> None:
////         pass
////
//// class [|Leaf|](Middle):
////     def [|process|](self) -> None:
////         pass

{
    const rangeMap = helper.getRangesByText();

    // goToImplementation on Base.process should find overrides in Middle and Leaf
    helper.verifyFindImplementations({
        marker1: {
            implementations: rangeMap
                .get('process')!
                .filter((r) => !r.marker)
                .map((r) => ({
                    path: r.fileName,
                    range: helper.convertPositionRange(r),
                })),
        },
    });
}
