/// <reference path="typings/fourslash.d.ts" />

// @filename: test.py
//// # Empty function body (ellipsis stub)
//// def stub_func(x: int): ...
////
//// # Non-recursive function with conditional return
//// def compute(n: int)/*rec*/:
////     if n > 0:
////         return n * 2
////     return 0
////
//// # __init__ — should NOT get return type hint
//// class Foo:
////     def __init__(self):
////         pass
////
//// # *args/**kwargs at call site — should stop emitting param hints
//// def multi(a: int, b: int, c: int) -> None:
////     pass
////
//// args = [1, 2, 3]
//// multi(/*ma*/1, *args)
////
//// # Keyword-only after * separator
//// def kw_only(*, key: str) -> None:
////     pass
////
//// # Nested call — parameter hint on outer, inner gets own treatment
//// def identity(val: int) -> int:
////     return val
////
//// identity(/*nested*/identity(1))
////
//// # Lambda — should NOT get return type hint (no FunctionNode)
//// fn = lambda x: x + 1
////
//// # Decorated function
//// def decorator(f):
////     return f
////
//// @decorator
//// def decorated(x: int)/*dec*/:
////     return x * 2
////
//// # Unicode variable name
//// def get_int() -> int:
////     return 1
//// café/*uni*/ = get_int()

{
    helper.verifyInlayHints({
        // Recursive function gets return type hint
        rec: { label: ': int', kind: 'type' },
        // *args stops param hints — only first positional gets hint
        ma: { label: 'a=', kind: 'parameter' },
        // Nested call — outer gets param hint
        nested: { label: 'val=', kind: 'parameter' },
        // Decorated function still gets return type hint
        dec: { label: ': int', kind: 'type' },
        // Unicode variable gets type hint
        uni: { label: ': int', kind: 'type' },
    });
}
