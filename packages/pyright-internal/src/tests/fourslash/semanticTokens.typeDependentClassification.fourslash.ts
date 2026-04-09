/// <reference path="typings/fourslash.d.ts" />

// @filename: test.py
//// class Foo:
////     pass
////
//// def test():
////     # Foo shadows the class with a local variable
////     /*varFoo*/Foo = 42
////     return Foo
////
//// # Foo here still refers to the class
//// x: /*classFoo*/Foo = test()

{
    helper.verifySemanticTokens({
        varFoo: 'variable',
        classFoo: 'class',
    });
}
