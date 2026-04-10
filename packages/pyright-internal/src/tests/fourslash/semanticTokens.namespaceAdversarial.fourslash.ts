/// <reference path="typings/fourslash.d.ts" />

// Adversarial tests for module/namespace token classification.
// Each case targets a specific assumption about how module references
// are resolved and classified.

// @filename: test.py
//// import os
//// import os as myos
//// from os import path
//// from os.path import join
////
//// # Aliased module — should still be namespace
//// /*aliasedMod*/myos.path.join("a", "b")
////
//// # From-imported submodule — should be namespace
//// /*fromSubmod*/path.join("a", "b")
////
//// # From-imported function — should be function, NOT namespace
//// /*fromFunc*/join("a", "b")
////
//// # Chained module access — intermediate `path` via member access
//// /*chainBase*/os./*chainMember*/path.sep
{
    helper.verifySemanticTokens({
        aliasedMod: 'namespace',
        fromSubmod: 'namespace',
        fromFunc: 'function',
        chainBase: 'namespace',
        chainMember: 'namespace',
    });
}
