/// <reference path="typings/fourslash.d.ts" />

// @filename: test.py
//// class MyClass:
////     pass
////
//// def /*func*/my_function(/*param*/x: int) -> None:
////     pass

{
    // Verify range filtering: request only the line with the function def
    // The class token should be excluded
    helper.verifySemanticTokensRange('func', 'param', {
        func: 'function',
        param: 'parameter',
    });
}
