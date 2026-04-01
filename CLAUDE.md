# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Test

```bash
# Install all packages (from repo root)
bun install

# Build the core library
cd packages/pyright-internal && bun run build

# Run all tests (builds test server first)
cd packages/pyright-internal && bun run test

# Run all tests without rebuilding the test server (faster iteration)
cd packages/pyright-internal && bun run test:norebuild

# Run a single test file
cd packages/pyright-internal && bunx jest typeEvaluator1.test --forceExit

# Run a single test by name
cd packages/pyright-internal && bunx jest -t "Generic1" --forceExit

# Build the CLI (webpack bundle)
bun run build:cli:dev

# Build the VS Code extension (webpack bundle)
bun run build:extension:dev
```

Jest requires `--forceExit` due to the test server. Tests need `--max-old-space-size=8192 --expose-gc` for large analysis runs (already configured in package.json scripts). Tests run from `packages/pyright-internal/`.

### Linting

```bash
bun run check              # syncpack + eslint + prettier
bun run check:eslint
bun run check:prettier
bun run fix:eslint
bun run fix:prettier
```

## Architecture

### Package Structure

- **`packages/pyright-internal`** — Core library: parser, binder, type evaluator, checker, language service. All logic and all tests live here.
- **`packages/pyright`** — CLI wrapper. Webpack-bundles `pyright-internal` into distributable npm package with `pyright` and `pyright-langserver` entry points.
- **`packages/vscode-pyright`** — VS Code extension client that communicates with the language server.

Monorepo managed by Lerna. Current version is synchronized across all three packages.

### Analysis Pipeline

Source files flow through these phases in order:

1. **Tokenizer** (`parser/tokenizer.ts`) — text to token stream
2. **Parser** (`parser/parser.ts`) — recursive descent parser; each `_parse*` method maps to a grammar production. Produces AST nodes defined in `parser/parseNodes.ts` (every node type has a `NodeType.create()` factory)
3. **Binder** (`analyzer/binder.ts`) — builds scopes, symbol tables, and reverse code flow graphs
4. **Checker** (`analyzer/checker.ts`) — walks every node, triggering type evaluation and reporting diagnostics
5. **Type Evaluator** (`analyzer/typeEvaluator.ts`) — type inference, constraint solving, type narrowing, overload resolution

All paths below are relative to `packages/pyright-internal/src/`.

### Key Design Patterns

**Type Evaluator closure pattern**: `typeEvaluator.ts` is the largest file in the codebase — a single `createTypeEvaluator()` factory function containing all type evaluation logic. Internal methods access the full closure for performance (same approach as the TypeScript compiler). The public API is the `TypeEvaluator` interface in `typeEvaluatorTypes.ts`. Navigate with LSP rather than reading in full.

**Service/Program/SourceFile hierarchy**: `Service` manages a `Program`, which tracks `SourceFile` instances. The `Program` coordinates analysis ordering, prioritizing open editor files and their dependencies.

**Typeshed fallback**: `packages/pyright-internal/typeshed-fallback/` contains bundled typeshed stubs for the Python stdlib when no external typeshed is configured.

**Localized diagnostics**: All user-facing diagnostic messages come from `localization/localize.ts`, not inline strings.

**Language service providers**: `languageService/` contains LSP feature implementations (completions, hover, go-to-definition, rename, etc.) that operate on analyzed program state.

## Test Conventions

### Sample-Based Tests

Most type checker tests follow this pattern (`typeEvaluator*.test.ts`, `checker.test.ts`):

1. Create a `.py` sample file in `src/tests/samples/` (e.g., `newFeature1.py`)
2. Add a test calling `TestUtils.typeAnalyzeSampleFiles(['newFeature1.py'])`
3. Assert with `TestUtils.validateResults(results, errorCount, warningCount, infoCount, unusedCode, unreachableCode, deprecated)`

Sample `.py` files use `# This should be an error` comments to document expected diagnostics; the actual assertion is the count passed to `validateResults`. Use `reveal_type(expr, expected_text="...")` to assert inferred types.

The `typeEvaluator*.test.ts` files (1 through 8) are split for parallel execution. Add new tests to whichever file is appropriate for the feature area.

### Fourslash Tests

Files in `src/tests/fourslash/` simulate LSP interactions (completions, hover, go-to-definition, rename). They use `// @filename:` markers to define virtual files and `////` prefix for embedded Python content.

### Test Policy

Tests are the specification for Pyright behavior. Never modify tests just to make CI pass. Any change that makes types less precise (`T` to `Unknown`, `list[int]` to `list[Any]`, `Literal["x"]` to `str`) is a regression by default. Fix Pyright behavior first, then fix incorrect typeshed stubs, then adjust tests only as a last resort. See `.github/agents/pyright-test-policy.md` for the full policy.

## Code Style

- **Formatting**: Prettier with 4-space indentation, single quotes, 120-char print width
- **Private members**: Must have leading underscore (`_privateMethod`). Protected and public must not.
- **Class member order**: fields, constructor, public getters/setters, public methods, protected, private (enforced by ESLint)
- **Imports**: Sorted by `simple-import-sort` ESLint plugin
- **No explicit `public`**: The `public` keyword is forbidden on class members
- **Strict TypeScript**: `strict: true`, `noImplicitReturns`, `noImplicitOverride`, target ES2020
