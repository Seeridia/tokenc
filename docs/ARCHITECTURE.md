# Architecture

[English](ARCHITECTURE.md) | [简体中文](ARCHITECTURE.zh-CN.md)

`tokenc` is structured as a compiler. DTCG JSON is source code; the token graph is its semantic model; context resolution is evaluation; the checker is static analysis; and backends are code generators.

## Pipeline

```text
DTCG document
  → parseTokenDocument(content, source)
  → typed TokenNode[] + structured diagnostics
  → TokenGraph
  → context validation + reference type checking
  → lazy TokenResolver
  → Compilation IR
  → TokenBackend.emit(compilation)
  → OutputFile[]
```

The high-level `compile()` function performs loading and the full pipeline. `compileDocuments()` accepts virtual inputs. No core stage writes output or terminates a process.

## Parser and source provenance

The parser consumes content and a source identity, not a filename to open. `jsonc-parser` provides an offset-preserving JSON AST. A lightweight line index converts every relevant AST offset into file, line, column, length, and source excerpt.

Every token and reference retains a `SourceLocation`. Diagnostics therefore remain useful after the raw JSON object representation is gone. Invalid JSON produces a structured diagnostic and an empty document, allowing watch mode to continue.

Groups pass their nearest `$type` to descendants. A property becomes a token only when it owns `$value`; groups are never confused with token nodes.

## Typed AST

The core model is explicit:

```text
TokenNode
  id: TokenId
  type: TokenType
  value: TokenLiteralExpression | TokenReference
  overrides: ContextOverride[]
  dependencies: TokenId[]
  source: SourceLocation
```

`color`, `dimension`, `number`, `duration`, and `fontWeight` have concrete internal value models and validators. Composite types retain JSON-safe data in v0.1 so later validators can become stricter without changing the graph or backend boundary.

## Token ID

`TokenId` is a branded canonical string. `parseTokenId`, `formatTokenId`, `parentTokenId`, `tokenIdFromSegments`, and `tokenIdSegments` define the boundary. Internals use canonical IDs as `Map` keys rather than repeatedly traversing `string[]` paths.

## Dependency graph

`TokenGraph` owns three indexes:

```text
Map<TokenId, TokenNode>       tokens
Map<TokenId, Set<TokenId>>    forward dependencies
Map<TokenId, Set<TokenId>>    reverse dependents
```

Lookup is O(1). Topological sorting, cycle detection, affected-node traversal, and impact analysis are O(V + E). Both `explain` and `usages` query this graph; they never scan source strings.

Cycles are reported as closed paths with related source locations. Unknown references are still retained as graph edges, which lets the checker provide nearby canonical-ID suggestions.

### Why model tokens as a graph?

An alias is not string interpolation—it is a semantic dependency. Once represented as an edge, cycle detection, evaluation order, reverse usage lookup, impact analysis, and incremental invalidation are the same underlying operation rather than separate features.

## Context resolver

Contexts are immutable key/value inputs such as `theme=dark` or `brand=enterprise`. Base values and sparse token overrides remain attached to one node. The resolver selects the matching override with the greatest specificity, then evaluates references through the graph.

Resolution is lazy and cached by `(TokenId, Context)`. The compiler records only the default context and override combinations actually declared in source. It never materializes complete dictionaries for a theme × brand × density Cartesian product.

The v0.1 context source form is the namespaced `$extensions["org.token-compiler.contexts"]` object. This is an isolated extension point pending broader standardization in the DTCG Resolver Module.

### Why not global deep merge?

Deep merge destroys provenance, makes precedence an object-order side effect, duplicates unchanged values, and hides which modifier changed a token. Sparse overrides keep identity, type, source, and graph edges stable while context becomes an explicit evaluator input.

## Type checker and diagnostics

The checker validates that reference targets exist and that source and target types agree. Diagnostics contain a stable code, severity, message, primary source, related sources, and optional suggestions. Core code does not add terminal color or print; the CLI renders code frames or JSON.

Duplicate canonical IDs are detected across documents before output. Graph cycles are validated separately from recursive resolution, so a user receives a useful path instead of a stack error.

## Compiler IR

`Compilation` is the sole backend-facing input. It exposes topologically ordered `CompiledToken` values, the validated graph, declared contexts, and a context-aware `resolveToken` operation. A backend does not parse, validate, merge, or search source documents.

This boundary keeps source-language concerns on the frontend and platform policy on the backend.

## Reference resolution is backend policy

Global alias resolution would erase useful semantics. CSS wants `var(--dependency)`, TypeScript may want a symbol, while a static target may require a literal. Backends select one of three conceptual strategies:

- `preserve` — emit the target in the platform's reference syntax.
- `symbol` — emit a language binding reference.
- `resolve` — emit the evaluated literal.

The resolver can always provide a value, but the chosen expression remains in IR so a backend decides whether to preserve the edge.

## Why platform outputs are backends

CSS and TypeScript are compilation targets, not formatting callbacks. A backend receives a complete semantic compilation and returns `OutputFile[]` through one method. There are no public transform/filter/action hook taxonomies. This prevents platform rules from leaking into parsing or evaluation.

## Backends

### CSS

Emits canonical custom properties. `preserve` maps references to `var()`, while `resolve` inlines evaluated literals. Context selector blocks compare their emitted representation to the default and include differences only.

### TypeScript

Flat mode emits topologically ordered bindings and supports symbol references. Object mode emits a nested `as const` object; symbol mode uses private ordered bindings when necessary.

### Tailwind v4

Emits `--token-*` runtime properties, sparse context overrides, and `@theme` bindings. Tailwind variables point at the runtime layer so ordinary CSS and utilities share values and theme switching does not duplicate the semantic token store.

## Incremental compilation

`IncrementalCompiler` caches parsed documents by source. On update:

1. Parse only the changed document.
2. Compare semantic node signatures to identify changed IDs.
3. Traverse reverse edges in both the old and new graphs.
4. Union those sets to cover changed, removed, and newly connected nodes.
5. Seed the next resolver with cached evaluations whose IDs are outside the affected set.
6. Recompute affected evaluations lazily as IR/backends request them.

Backends may rewrite a complete output file in v0.1, but that does not reparse or reevaluate unrelated tokens. Add, change, and remove share the same invalidation path. Invalid JSON replaces only that cached document, reports diagnostics, and can recover on the next edit.

## Impact API

`TokenGraph.analyzeImpact(changedIds)` separates direct from indirect dependents. It is intentionally a core API even though a `diff` CLI is not included yet; CI and pull-request review can use the same semantic graph.

## Computed-token extension point

The current expression union contains literal and reference nodes. A future `ComputedTokenNode` can be added as a third expression kind and contribute dependency edges before graph construction. Function parsing and evaluation would be compiler stages; backends would continue consuming the same resolved IR. v0.1 does not introduce a non-standard function syntax.

## Package boundaries

```text
@tokenc/core
  ↑
  ├─ @tokenc/backend-css
  ├─ @tokenc/backend-tailwind
  ├─ @tokenc/backend-typescript
  └─ @tokenc/cli → backends
```

Core never imports the CLI or a backend. Backends depend only on public core IR. The CLI owns configuration loading, filesystem writes, terminal output, signals, and watch lifecycle.
