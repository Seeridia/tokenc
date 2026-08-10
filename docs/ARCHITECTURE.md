# Architecture

[English](ARCHITECTURE.md) | [简体中文](ARCHITECTURE.zh-CN.md)

`tokenc` is structured as a compiler. DTCG JSON is source code; the token graph is its semantic model; context resolution is evaluation; the checker is static analysis; and backends are code generators.

## Pipeline

```text
strict DTCG / tokenc compatibility document
  → dialect parser + normalizer
  → typed TokenNode[] + structured diagnostics
  → optional DTCG Resolver sets/modifiers/resolutionOrder
  → TokenGraph
  → context validation + reference type checking
  → lazy TokenResolver
  → Compilation IR
  → TokenBackend.emit(compilation)
  → OutputFile[]
```

The high-level `compile()` function performs loading and the full pipeline. `compileDocuments()` accepts virtual inputs. No core stage writes output or terminates a process.

## Dialect and normalization boundary

DTCG 2025.10 is the standard source language. The explicit `dtcg-2025.10` dialect validates strict structured values; the v0.x-default `tokenc` dialect retains conveniences such as CSS color strings. Both paths normalize before graph construction, so the checker, resolver, IR, and backends never branch on source syntax.

The parser is split from DTCG color and format validation. Color representation is preserved in core while serialization or conversion remains backend policy. The exact supported surface is documented in the [DTCG compatibility matrix](DTCG-COMPATIBILITY.md).

## Parser and source provenance

The parser consumes content and a source identity, not a filename to open. `jsonc-parser` provides an offset-preserving JSON AST. A lightweight line index converts every relevant AST offset into file, line, column, length, and source excerpt.

Every token and reference retains a `SourceLocation`. Diagnostics therefore remain useful after the raw JSON object representation is gone. Invalid JSON produces a structured diagnostic and an empty document, allowing watch mode to continue.

Groups pass their nearest `$type` to descendants. A property becomes a token only when it owns `$value`; an object containing both `$value` and children is diagnosed. Reserved `$root` tokens retain their explicit canonical path segment.

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

`color`, `dimension`, `fontFamily`, `number`, `duration`, and `fontWeight` have concrete internal value models and validators. `TokenExpression<T>`, `TokenNode<T>`, `ResolvedToken<T>`, and `CompiledToken<T>` carry the declared token type through the pipeline. Composite types retain JSON-safe data so later validators can become stricter without changing the graph or backend boundary.

## Token ID

`TokenId` is a branded canonical string. `parseTokenId`, `formatTokenId`, `parentTokenId`, `tokenIdFromSegments`, and `tokenIdSegments` define the boundary. Internals use canonical IDs as `Map` keys rather than repeatedly traversing `string[]` paths.

## Dependency graph

`TokenGraph` owns three indexes:

```text
Map<TokenId, TokenNode>       tokens
Map<TokenId, Set<TokenId>>    forward dependencies
Map<TokenId, Set<TokenId>>    reverse dependents
```

Lookup is O(1). A stable Kahn sort uses a lexical heap and costs O((V + E) log V); iterative cycle detection, affected traversal, and impact analysis cost O(V + E). Both `explain` and `usages` query this graph; they never scan source strings.

`TokenGraph.patch()` updates token, forward-edge, and reverse-edge indexes in place. It reports a graph delta and unions affected nodes from the pre-patch and post-patch reverse graph, preserving correctness when edges disappear or change target.

Cycles are reported as closed paths with related source locations. Unknown references are still retained as graph edges, which lets the checker provide nearby canonical-ID suggestions.

### Why model tokens as a graph?

An alias is not string interpolation—it is a semantic dependency. Once represented as an edge, cycle detection, evaluation order, reverse usage lookup, impact analysis, and incremental invalidation are the same underlying operation rather than separate features.

## Context resolver

Contexts are immutable key/value inputs such as `theme=dark` or `brand=enterprise`. Base values and sparse compatibility overrides remain attached to one node. Selection uses explicit precedence, specificity, then configured dimension order; equal matches no longer depend on JSON declaration order.

Resolution is lazy and cached by `(TokenId, Context)`. The compiler records only the default context and override combinations actually declared in source. It never materializes complete dictionaries for a theme × brand × density Cartesian product.

The namespaced `$extensions["org.token-compiler.contexts"]` form remains compatibility syntax and normalizes into typed context overrides consumed by the same `TokenResolver`.

## DTCG Resolver Module

`parseResolverDocument(content, source)` is an IO-independent frontend for DTCG 2025.10 resolver documents. It creates typed `TokenSet`, `ResolverModifier`, `ResolutionSource`, and ordered resolution items with source locations. The IO layer loads relative whole-file references; semantic resolution validates inputs, expands same-document set references, selects modifier contexts, and emits a source stream in exact `resolutionOrder`.

Conflicts follow the standard last-source-wins rule only inside a Resolver resolution. Ordinary multi-file compilation continues diagnosing duplicate canonical IDs. Aliases are parsed and checked after the selected stream is assembled, so a Resolver is not implemented as a global deep-merge hook.

### Why not global deep merge?

Deep merge destroys provenance, makes precedence an object-order side effect, duplicates unchanged values, and hides which modifier changed a token. Sparse overrides keep identity, type, source, and graph edges stable while context becomes an explicit evaluator input.

## Type checker and diagnostics

The checker validates that reference targets exist and that source and target types agree. Diagnostics contain a stable code, severity, message, primary source, related sources, and optional suggestions. Core code does not add terminal color or print; the CLI renders code frames or JSON.

Duplicate canonical IDs are detected across documents before output. Graph cycles are validated separately from recursive resolution, so a user receives a useful path instead of a stack error.

## Compiler IR

`Compilation` is the sole backend-facing input. It exposes topologically ordered `CompiledToken` values, typed `tokensOfType()` views, the validated graph, declared contexts, `resolveToken()`, and structured `explainToken()` traces. A backend does not parse, validate, merge, or search source documents.

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
3. Patch only added, changed, and removed graph nodes and adjacency edges.
4. Union reverse traversal from before and after the patch.
5. Check references and cycles in the affected region (falling back to a full check after an invalid build).
6. Seed the next resolver with cached evaluations whose IDs are outside the affected set.
7. Recompute affected evaluations lazily as IR/backends request them.

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
