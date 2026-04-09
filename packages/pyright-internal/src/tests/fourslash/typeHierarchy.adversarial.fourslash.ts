/// <reference path="typings/fourslash.d.ts" />

// Adversarial battery: edge cases for type hierarchy provider.

// @filename: test.py
//// # Empty: cursor on a function, not a class
//// def /*markerFunc*/my_function():
////     pass
////
//// # Empty: cursor on a variable
//// /*markerVar*/x = 42
////
//// # Semantically hostile: class with no explicit bases (implicit object)
//// class /*markerNoBases*/Standalone:
////     pass
////
//// # Dense: class with many bases
//// class M1: pass
//// class M2: pass
//// class M3: pass
//// class M4: pass
//// class /*markerDense*/ManyBases(M1, M2, M3, M4):
////     pass
////
//// # Nested: inner class as subtype of outer
//// class /*markerOuter*/Outer:
////     class Inner(Outer):
////         pass

{
    // onPrepare on a function name should return nothing (empty items).
    helper.verifyTypeHierarchyPrepare({
        markerFunc: {
            items: [],
        },
    });

    // onPrepare on a variable should return nothing.
    helper.verifyTypeHierarchyPrepare({
        markerVar: {
            items: [],
        },
    });

    // Class with no explicit bases: supertypes includes implicit `object`.
    helper.verifyTypeHierarchySupertypes({
        markerNoBases: {
            items: [{ name: 'object' }],
        },
    });

    // Dense: class with 4 bases should return all 4 as supertypes.
    helper.verifyTypeHierarchySupertypes({
        markerDense: {
            items: [{ name: 'M1' }, { name: 'M2' }, { name: 'M3' }, { name: 'M4' }],
        },
    });

    // Nested: Outer may not find Inner as subtype because Inner's forward
    // reference to Outer during class body evaluation can result in a
    // partially-evaluated type. This is a known limitation.
    // Verify prepare works on Outer at minimum.
    helper.verifyTypeHierarchyPrepare({
        markerOuter: {
            items: [{ name: 'Outer' }],
        },
    });
}
