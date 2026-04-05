/// <reference path="typings/fourslash.d.ts" />

// @filename: test.py
//// # Basic cases
//// /*defMarker*/def [|foo|]():
////     pass
////
//// async /*asyncDefMarker*/def [|bar|]():
////     pass
////
//// /*classMarker*/class [|MyClass|]:
////     pass
////
//// # Adversarial: nested function
//// def outer():
////     /*nestedDefMarker*/def [|inner|]():
////         pass
////
//// # Adversarial: decorated function
//// def noop(f):
////     return f
////
//// @noop
//// /*decoratedDefMarker*/def [|decorated|]():
////     pass
////
//// # Adversarial: method inside class
//// class Host:
////     /*methodDefMarker*/def [|method|](self):
////         pass
////
//// # Control: usage-site markers (regression check)
//// x = [|/*usageFoo*/foo|]
//// y = [|/*usageBar*/bar|]
//// z = [|/*usageMyClass*/MyClass|]

{
    const rangeMap = helper.getRangesByText();

    helper.verifyFindDefinitions({
        // Basic: def keyword
        defMarker: {
            definitions: rangeMap
                .get('foo')!
                .filter((r) => !r.marker)
                .map((r) => {
                    return { path: r.fileName, range: helper.convertPositionRange(r) };
                }),
        },
        // Basic: async keyword
        asyncDefMarker: {
            definitions: rangeMap
                .get('bar')!
                .filter((r) => !r.marker)
                .map((r) => {
                    return { path: r.fileName, range: helper.convertPositionRange(r) };
                }),
        },
        // Basic: class keyword
        classMarker: {
            definitions: rangeMap
                .get('MyClass')!
                .filter((r) => !r.marker)
                .map((r) => {
                    return { path: r.fileName, range: helper.convertPositionRange(r) };
                }),
        },
        // Adversarial: nested function def keyword
        nestedDefMarker: {
            definitions: rangeMap
                .get('inner')!
                .filter((r) => !r.marker)
                .map((r) => {
                    return { path: r.fileName, range: helper.convertPositionRange(r) };
                }),
        },
        // Adversarial: decorated function def keyword
        decoratedDefMarker: {
            definitions: rangeMap
                .get('decorated')!
                .filter((r) => !r.marker)
                .map((r) => {
                    return { path: r.fileName, range: helper.convertPositionRange(r) };
                }),
        },
        // Adversarial: method def keyword
        methodDefMarker: {
            definitions: rangeMap
                .get('method')!
                .filter((r) => !r.marker)
                .map((r) => {
                    return { path: r.fileName, range: helper.convertPositionRange(r) };
                }),
        },
        // Control: usage site (regression)
        usageFoo: {
            definitions: rangeMap
                .get('foo')!
                .filter((r) => !r.marker)
                .map((r) => {
                    return { path: r.fileName, range: helper.convertPositionRange(r) };
                }),
        },
        usageBar: {
            definitions: rangeMap
                .get('bar')!
                .filter((r) => !r.marker)
                .map((r) => {
                    return { path: r.fileName, range: helper.convertPositionRange(r) };
                }),
        },
        usageMyClass: {
            definitions: rangeMap
                .get('MyClass')!
                .filter((r) => !r.marker)
                .map((r) => {
                    return { path: r.fileName, range: helper.convertPositionRange(r) };
                }),
        },
    });
}
