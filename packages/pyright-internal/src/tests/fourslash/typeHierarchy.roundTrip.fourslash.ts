/// <reference path="typings/fourslash.d.ts" />

// Regression test: languageServerBase.ts supertypes/subtypes handlers create a
// new TypeHierarchyProvider using the item's range.start. The prepare step
// returns range covering the whole class (`class Foo:`) but the provider needs
// the position to land on a Name node. This test verifies the round-trip works
// by simulating exactly what the LSP handler does.

// @filename: test.py
//// class Base:
////     pass
////
//// class /*marker1*/Child(Base):
////     pass
////
//// class GrandChild(Child):
////     pass

{
    // Round-trip supertypes: prepare at marker, then use returned item's range.start
    helper.verifyTypeHierarchyRoundTripSupertypes({
        marker1: {
            items: [{ name: 'Base' }],
        },
    });

    // Round-trip subtypes: same round-trip, checking subtypes direction
    helper.verifyTypeHierarchyRoundTripSubtypes({
        marker1: {
            items: [{ name: 'GrandChild' }],
        },
    });
}
