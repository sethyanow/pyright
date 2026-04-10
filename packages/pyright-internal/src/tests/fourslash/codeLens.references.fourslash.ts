/// <reference path="typings/fourslash.d.ts" />

// @filename: test.py
//// class /*cls*/MyClass:
////     pass
////
//// def /*func*/my_function() -> None:
////     pass
////
//// x = MyClass()
//// y = MyClass()
//// my_function()

{
    helper.verifyCodeLens({
        cls: { title: '2 references', kind: 'references' },
        func: { title: '1 reference', kind: 'references' },
    });
}
