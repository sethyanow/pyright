/// <reference path="typings/fourslash.d.ts" />

// @filename: test.py
//// class /*marker1*/Base:
////     pass
////
//// # Diamond: D inherits from both B and C, both inherit from Base
//// class [|B|](Base):
////     pass
////
//// class [|C|](Base):
////     pass
////
//// class [|D|](B, C):
////     pass

{
    const rangeMap = helper.getRangesByText();

    // Diamond inheritance — all three subclasses should appear
    helper.verifyFindImplementations({
        marker1: {
            implementations: ['B', 'C', 'D'].flatMap((name) =>
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
