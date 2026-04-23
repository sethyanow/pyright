/// <reference path="typings/fourslash.d.ts" />

// Adversarial stress test for semantic token modifiers
// Patterns: self-referential, redundant, encoding boundaries, sparse, dense

// @filename: test.py
//// from abc import ABC, abstractmethod
//// from typing import Protocol, override
////
//// # Self-referential: Protocol that references itself
//// class /*selfRefProtocol*/SelfRef(Protocol):
////     def get_next(self) -> "SelfRef":
////         ...
////
//// # Dense: Multiple inheritance with abstract + protocol
//// class /*denseAbstract*/DenseBase(ABC):
////     @abstractmethod
////     def /*denseAbstractMethod*/a(self) -> None: ...
////     @abstractmethod
////     def /*denseAbstractMethod2*/b(self) -> None: ...
////
//// class /*denseProtocol*/DenseProto(Protocol):
////     def c(self) -> None: ...
////
//// # Redundant: Class inheriting from both ABC and Protocol
//// class /*bothAbcProtocol*/Both(ABC, Protocol):
////     @abstractmethod
////     def /*bothMethod*/required(self) -> None: ...
////
//// # Sparse: Deep inheritance chain, only leaf overrides
//// class /*level1*/L1(ABC):
////     @abstractmethod
////     def /*l1Abstract*/method(self) -> None: ...
////
//// class /*level2*/L2(L1):
////     pass  # Does NOT override — still abstract
////
//// class /*level3*/L3(L2):
////     def /*l3Override*/method(self) -> None:
////         pass  # Finally overrides
////
//// # Encoding boundary: Unicode method names
//// class /*unicodeClass*/Über(ABC):
////     @abstractmethod
////     def /*unicodeMethod*/café(self) -> None: ...
////
//// # Empty: Class with no methods at all
//// class /*emptyClass*/Empty:
////     pass
////
//// # Singular: Protocol with exactly one method
//// class /*singularProtocol*/Single(Protocol):
////     def /*singularMethod*/only_one(self) -> None: ...
////
//// # Type boundary: __init__ in abstract class should NOT be abstract
//// class /*initAbstract*/WithInit(ABC):
////     def /*initMethod*/__init__(self) -> None:
////         pass
////     @abstractmethod
////     def /*mustOverride*/required(self) -> None: ...
////
//// # Multiple @override in same class
//// class /*multiOverrideParent*/Parent:
////     def /*parentA*/a(self) -> None: pass
////     def /*parentB*/b(self) -> None: pass
////
//// class /*multiOverrideChild*/Child(Parent):
////     @override
////     def /*childA*/a(self) -> None: pass
////     @override
////     def /*childB*/b(self) -> None: pass
////
//// # pyr-oq2: standalone class whose method structurally matches a Protocol's
//// # method. With NO inheritance relationship, the `override` modifier must
//// # not be emitted — structural compliance is not override.
//// class /*structProto*/StructProto(Protocol):
////     def /*structProtoMethod*/structured(self, x: int) -> int: ...
////
//// class /*structStandalone*/StructStandalone:
////     def /*structNonOverride*/structured(self, x: int) -> int:
////         return x

{
    helper.verifySemanticTokensWithModifiers({
        // Self-referential Protocol
        selfRefProtocol: { type: 'class', modifiers: ['protocol'] },

        // Dense abstract class
        denseAbstract: { type: 'class', modifiers: ['abstract'] },
        denseAbstractMethod: { type: 'method', modifiers: ['abstract'] },
        denseAbstractMethod2: { type: 'method', modifiers: ['abstract'] },
        denseProtocol: { type: 'class', modifiers: ['protocol'] },

        // Both ABC and Protocol — should get BOTH modifiers
        bothAbcProtocol: { type: 'class', modifiers: ['abstract', 'protocol'] },
        bothMethod: { type: 'method', modifiers: ['abstract'] },

        // Sparse inheritance: L1 is abstract, L2 inherits but doesn't override so still abstract-ish
        // Actually L2 doesn't DECLARE abstract methods, so no modifier
        level1: { type: 'class', modifiers: ['abstract'] },
        l1Abstract: { type: 'method', modifiers: ['abstract'] },
        level2: { type: 'class', modifiers: [] },  // Inherits but doesn't declare
        level3: { type: 'class', modifiers: [] },
        l3Override: { type: 'method', modifiers: ['override'] },  // Implicit override

        // Unicode names — should work identically
        unicodeClass: { type: 'class', modifiers: ['abstract'] },
        unicodeMethod: { type: 'method', modifiers: ['abstract'] },

        // Empty class — no modifiers
        emptyClass: { type: 'class', modifiers: [] },

        // Singular Protocol
        singularProtocol: { type: 'class', modifiers: ['protocol'] },
        singularMethod: { type: 'method', modifiers: [] },

        // __init__ should NOT be abstract even in ABC
        initAbstract: { type: 'class', modifiers: ['abstract'] },
        initMethod: { type: 'method', modifiers: [] },
        mustOverride: { type: 'method', modifiers: ['abstract'] },

        // Multiple overrides
        multiOverrideParent: { type: 'class', modifiers: [] },
        parentA: { type: 'method', modifiers: [] },
        parentB: { type: 'method', modifiers: [] },
        multiOverrideChild: { type: 'class', modifiers: [] },
        childA: { type: 'method', modifiers: ['override'] },
        childB: { type: 'method', modifiers: ['override'] },

        // pyr-oq2: structural-only match to Protocol ≠ override
        structProto: { type: 'class', modifiers: ['protocol'] },
        structProtoMethod: { type: 'method', modifiers: [] },
        structStandalone: { type: 'class', modifiers: [] },
        structNonOverride: { type: 'method', modifiers: [] },
    });
}
