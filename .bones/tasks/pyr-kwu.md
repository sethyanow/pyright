---
id: pyr-kwu
title: 'Phase 1 Acceptance: Foundation — goToImplementation + workspaceSymbol fix'
status: open
type: task
priority: 1
parent: pyr-lo0
---

## Context

Phase 1 of pyr-otr (Add missing LSP providers). All implementation tasks closed:
- pyr-rcy: workspaceSymbol empty query fix (closed)
- pyr-e3e: goToImplementation provider (closed)

## Deliverables

### Agent Documentation
- [ ] CLAUDE.md: update capabilities list in Architecture section — none exists currently, so "none expected"
- [ ] No other docs expected

### User Demo
Demonstrate all Phase 1 features live via the LSP tool in this conversation:

1. **goToImplementation on a Protocol** — show finding concrete classes that inherit from a Protocol
2. **goToImplementation on a method** — show finding overriding methods in subclasses
3. **goToImplementation on a concrete class** — show empty result (not error)
4. **workspaceSymbol with empty query** — show it returning symbols from user code files

## Success Criteria
- [ ] Demo presented to user in conversation
- [ ] User confirms acceptance (closes this task + sub-epic)
