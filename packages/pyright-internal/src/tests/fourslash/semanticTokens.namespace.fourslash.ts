/// <reference path="typings/fourslash.d.ts" />

// Regression test: module references at usage sites must be classified as namespace.
// Previously, `os` in `os.path.join()` emitted no token because alias resolution
// found a module but _classifyName had no case for modules.

// @filename: test.py
//// import os
//// import json
////
//// # Module used as attribute access base — should be namespace
//// /*osRef*/os.path.join("a", "b")
////
//// # Module used standalone (e.g. passed to function) — should be namespace
//// /*jsonRef*/json.dumps({})

{
    helper.verifySemanticTokens({
        osRef: 'namespace',
        jsonRef: 'namespace',
    });
}
