/// <reference path="typings/fourslash.d.ts" />

// @filename: test.py
//// class Base:
////     pass
////
//// class /*marker1*/Child(Base):
////     pass

{
    helper.verifyTypeHierarchySupertypes({
        marker1: {
            items: [{ name: 'Base' }],
        },
    });
}
