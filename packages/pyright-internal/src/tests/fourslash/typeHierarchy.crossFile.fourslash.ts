/// <reference path="typings/fourslash.d.ts" />

// @filename: base.py
//// class /*marker1*/Base:
////     pass

// @filename: child.py
//// from base import Base
////
//// class Child(Base):
////     pass

{
    // Subtypes work across files.
    helper.verifyTypeHierarchySubtypes({
        marker1: {
            items: [{ name: 'Child' }],
        },
    });
}
