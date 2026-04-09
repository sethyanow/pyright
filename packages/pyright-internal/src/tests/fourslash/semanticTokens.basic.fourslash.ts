/// <reference path="typings/fourslash.d.ts" />

// @filename: test.py
//// from enum import Enum
////
//// def /*decorator*/my_decorator(func):
////     return func
////
//// class /*cls*/MyClass[/*typeParam*/T]:
////     /*property*/name: str = "hello"
////
////     def /*method*/greet(self, /*param*/message: str) -> None:
////         /*variable*/result = f"Hello {message}"
////
//// class /*enum*/Color(Enum):
////     /*enumMember*/RED = 1

{
    helper.verifySemanticTokens({
        decorator: 'function',
        cls: 'class',
        typeParam: 'typeParameter',
        property: 'property',
        method: 'method',
        param: 'parameter',
        variable: 'variable',
        enum: 'class',
        enumMember: 'enumMember',
    });
}
