/// <reference path="typings/fourslash.d.ts" />

// @filename: test.py
//// class /*marker1*/MyClass:
////     pass

{
    helper.verifyTypeHierarchyPrepare({
        marker1: {
            items: [{ name: 'MyClass' }],
        },
    });
}
