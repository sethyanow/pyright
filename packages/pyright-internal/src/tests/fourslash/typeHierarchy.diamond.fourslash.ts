/// <reference path="typings/fourslash.d.ts" />

// @filename: test.py
//// class /*marker1*/Base:
////     pass
////
//// class Left(Base):
////     pass
////
//// class Right(Base):
////     pass
////
//// class /*marker2*/Diamond(Left, Right):
////     pass

{
    // Diamond's direct supertypes are Left and Right (not Base).
    helper.verifyTypeHierarchySupertypes({
        marker2: {
            items: [{ name: 'Left' }, { name: 'Right' }],
        },
    });

    // Base's direct subtypes are Left and Right (not Diamond — that's transitive).
    helper.verifyTypeHierarchySubtypes({
        marker1: {
            items: [{ name: 'Left' }, { name: 'Right' }],
        },
    });
}
