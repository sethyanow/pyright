/// <reference path="typings/fourslash.d.ts" />

// @filename: lib.py
//// def /*func*/helper() -> int:
////     return 42

// @filename: consumer1.py
//// from lib import helper
////
//// x = helper()

// @filename: consumer2.py
//// from lib import helper
////
//// y = helper()
//// z = helper()

{
    // helper() is referenced in consumer1.py (1 call) and consumer2.py (2 calls)
    // Plus the import statements. Total references across workspace (excluding declaration).
    // The exact count depends on what ReferencesProvider counts — imports + calls.
    // consumer1: import (1) + call (1) = 2
    // consumer2: import (1) + calls (2) = 3
    // Total: 5 references
    helper.verifyCodeLens({
        func: { title: '5 references', kind: 'references' },
    });
}
