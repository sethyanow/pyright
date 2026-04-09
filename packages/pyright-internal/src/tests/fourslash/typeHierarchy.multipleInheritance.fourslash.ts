/// <reference path="typings/fourslash.d.ts" />

// @filename: test.py
//// class Mixin1:
////     pass
////
//// class Mixin2:
////     pass
////
//// class /*marker1*/Child(Mixin1, Mixin2):
////     pass

{
    helper.verifyTypeHierarchySupertypes({
        marker1: {
            items: [{ name: 'Mixin1' }, { name: 'Mixin2' }],
        },
    });
}
