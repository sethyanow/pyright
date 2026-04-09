/// <reference path="typings/fourslash.d.ts" />

// @filename: test.py
//// class /*marker1*/Base:
////     pass
////
//// class Child(Base):
////     pass

{
    helper.verifyTypeHierarchySubtypes({
        marker1: {
            items: [{ name: 'Child' }],
        },
    });
}
