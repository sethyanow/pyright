/// <reference path="typings/fourslash.d.ts" />

// Adversarial test: unicode identifiers, nested dense structure,
// self-referential types, member access chains, decorator on class

// @filename: test.py
//// from __future__ import annotations
////
//// # Unicode identifiers
//// /*unicodeVar*/café = 42
//// def /*unicodeFunc*/grüßen():
////     pass
////
//// # Dense nesting
//// def /*outerDec*/my_dec(cls):
////     return cls
////
//// @my_dec
//// class /*outerClass*/Outer:
////     /*outerProp*/x: int = 1
////
////     class /*innerClass*/Inner:
////         /*innerProp*/y: str = "hello"
////
////         def /*innerMethod*/do_thing(self, /*innerParam*/arg: int) -> None:
////             /*innerVar*/z = arg + 1
////
//// # Self-referential class
//// class /*selfRefClass*/Node:
////     /*selfRefProp*/children: list[Node]
////
////     def /*selfRefMethod*/add(self, /*selfRefParam*/child: Node) -> None:
////         self./*memberAccess*/children.append(child)

{
    helper.verifySemanticTokens({
        // Unicode identifiers
        unicodeVar: 'variable',
        unicodeFunc: 'function',
        // Dense nesting
        outerDec: 'function',
        outerClass: 'class',
        outerProp: 'property',
        innerClass: 'class',
        innerProp: 'property',
        innerMethod: 'method',
        innerParam: 'parameter',
        innerVar: 'variable',
        // Self-referential
        selfRefClass: 'class',
        selfRefProp: 'property',
        selfRefMethod: 'method',
        selfRefParam: 'parameter',
        memberAccess: 'property',
    });
}
