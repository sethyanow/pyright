/// <reference path="typings/fourslash.d.ts" />

// Verify that variable shadowing a module import in a function scope
// does NOT produce a namespace token. Pyright flow analysis treats the
// whole function scope as using the shadowed variable declaration.

// @filename: test.py
//// import os
////
//// # Module reference — namespace
//// /*modRef*/os.path.join("a", "b")
////
//// def uses_shadowed():
////     os = 42
////     x = /*localVar*/os + 1

{
    helper.verifySemanticTokens({
        modRef: 'namespace',
        localVar: 'variable',
    });
}
