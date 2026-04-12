/// <reference path="typings/fourslash.d.ts" />

// ADVERSARIAL: Deep inheritance chain (5 levels)
// Tests that BFS correctly discovers all levels of transitive inheritance.
// Each file only mentions its direct parent — BFS must chain through all.

// @filename: level0.py
//// from abc import ABC, abstractmethod
////
//// class /*base*/Level0(ABC):
////     @abstractmethod
////     def process(self) -> None: ...

// @filename: level1.py
//// from level0 import Level0
////
//// class Level1(Level0):
////     def process(self) -> None: pass

// @filename: level2.py
//// from level1 import Level1
////
//// class Level2(Level1):
////     def process(self) -> None: pass

// @filename: level3.py
//// from level2 import Level2
////
//// class Level3(Level2):
////     def process(self) -> None: pass

// @filename: level4.py
//// from level3 import Level3
////
//// class Level4(Level3):
////     def process(self) -> None: pass

{
    // Level0 should show 4 implementations: Level1, Level2, Level3, Level4
    // Each file only mentions its direct parent, so BFS must chain:
    // "Level0" → find Level1 → add "Level1" to search
    // "Level1" → find Level2 → add "Level2" to search
    // etc.
    helper.verifyCodeLens({
        base: { title: '4 implementations', kind: 'implementations' },
    });
}
