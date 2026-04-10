/// <reference path="typings/fourslash.d.ts" />

// @filename: test.py
//// def get_count() -> int:
////     return 42
////
//// def get_name() -> str:
////     return "hello"
////
//// x/*var1*/ = get_count()
////
//// y: int = get_count()
////
//// name/*var2*/ = get_name()

{
    // var1: unannotated assignment → `: int` hint
    // y: annotated assignment → should NOT get a hint
    // var2: unannotated assignment → `: str` hint
    helper.verifyInlayHints({
        var1: { label: ': int', kind: 'type' },
        var2: { label: ': str', kind: 'type' },
    });
}
