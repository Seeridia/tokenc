# Architecture

[English](ARCHITECTURE.md) | [简体中文](ARCHITECTURE.zh-CN.md)

`tokenc` is structured as a compiler. DTCG JSON is source code; the token graph is its semantic model; context resolution is evaluation; the checker is static analysis; and backends are code generators.

## Pipeline

```text
DTCG 2025.10 token document
  → optional DTCG Resolver source composition
  → syntax parser + unresolved source model
  → reference linking (curly aliases, JSON Pointer $ref, group $extends)
  → reference-driven type resolution
  → typed TokenNode[] + structured diagnostics
  → TokenGraph
  → context validation + reference type checking
  → lazy TokenResolver
  → Compilation IR
  → TokenBackend.emit(compilation)
  → OutputFile[]
```

The high-level `compile()` function performs loading and the full pipeline. `compileDocuments()` accepts virtual inputs. No core stage writes output or terminates a process.

## One source language

tokenc intentionally supports one compiler source language: DTCG 2025.10. There is no compiler configuration switch for proprietary syntax. This keeps the parser, graph, resolver, checker, and backends operating on one well-defined language model. Non-DTCG token formats must be converted before compilation.

The DTCG version remains explicit in validation, diagnostics, Resolver documents, and documentation without becoming an end-user language selector. The parser is split from DTCG color and format validation. Color representation is preserved in core while serialization or conversion remains backend policy. The exact supported surface is documented in the [DTCG support matrix](DTCG-SUPPORT.md).

### Importer / migrator boundary

An optional importer sits outside the compiler:

```text
foreign or legacy syntax
  → importer / migrator
  → DTCG 2025.10 source
  → tokenc compiler
```

An importer understands foreign syntax, converts values, emits valid DTCG, and reports migration diagnostics. The compiler parses and validates DTCG, builds typed semantic nodes and graph edges, resolves and checks them, then emits platform artifacts. Importers must not bypass the DTCG parser by constructing `TokenNode` objects directly. No migrator is part of the compiler core in this release.

## Parser and source provenance

The parser consumes content and a source identity, not a filename to open. `jsonc-parser` provides an offset-preserving JSON AST. A lightweight line index converts every relevant AST offset into file, line, column, length, and source excerpt.

Every token and reference retains a `SourceLocation`. Diagnostics therefore remain useful after the raw JSON object representation is gone. Invalid JSON produces a structured diagnostic and an empty document, allowing watch mode to continue.

The syntax parser records explicit and inherited type candidates without requiring every token's
final type. The linking stage resolves forward, backward, chained, and cross-document aliases.
Final type precedence is explicit token `$type`, referenced token type, then inherited group type.
Only the resulting typed `TokenNode` reaches the graph, checker, resolver, or backends.

Groups pass their nearest `$type` to descendants. A property becomes a token when it owns `$value`
or is a `$ref` reference object; an object containing both a token definition and children is
diagnosed. Reserved `$root` tokens retain their explicit canonical path segment. Group `$extends`
is represented as an inheritance edge and effective membership, not a global object deep merge.

## Typed AST

The core model is explicit:

```text
TokenNode
  id: TokenId
  type: TokenType
  value: TokenLiteralExpression | TokenReference | JsonPointerReferenceExpression
  baseDependencies: TokenId[]
  overrides: ContextOverride[]
  dependencies: TokenId[]
  propertyReferences: JsonPointerDependency[]
  inheritance?: TokenInheritance
  source: SourceLocation
```

All standard token types have concrete internal value models and validators.
`cubicBezier`, `strokeStyle`, `border`, `transition`, `shadow`, `gradient`, and `typography` validate
their required fields, closed shapes, and applicable ranges. `TokenExpression<T>`, `TokenNode<T>`,
`ResolvedToken<T>`, and `CompiledToken<T>` carry the resolved token type through the pipeline.

The RFC 6901 engine is an IO-independent DTCG module. A pointer to a token or its complete `$value`
normalizes to a token reference. A pointer to a nested component retains its pointer expression and
resolved component value, while `TokenNode.dependencies` records the owning token ID. Backends never
parse raw pointers and resolve component references when a platform cannot preserve them.

## Token ID

`TokenId` is a branded canonical string. `parseTokenId`, `formatTokenId`, `parentTokenId`, `tokenIdFromSegments`, and `tokenIdSegments` define the boundary. Internals use canonical IDs as `Map` keys rather than repeatedly traversing `string[]` paths.

## Dependency graph

`TokenGraph` owns three indexes:

```text
Map<TokenId, TokenNode>       tokens
Map<TokenId, Set<TokenId>>    forward dependencies
Map<TokenId, Set<TokenId>>    reverse dependents
```

The forward and reverse indexes hold a conservative union of base and override dependencies for
usages, impact, and incremental invalidation. `TokenNode.baseDependencies` and each
`ContextOverride.dependencies` retain the dependencies of individual candidate expressions. The
checker first locates strongly connected candidate regions in the union graph, then lazily projects
only the context dimensions used by that region and applies the same selection rules as the
resolver. Mutually exclusive context edges therefore do not produce false cycles, while a real
cycle requiring a multi-dimensional context is still diagnosed. Projection cardinality is checked
before enumeration and is capped at the exported `CONTEXT_CYCLE_PROJECTION_LIMIT` of 16,384
contexts per candidate region. Exceeding that bound produces a source-backed
`TOKEN_CONTEXT_PROJECTION_LIMIT` error containing the region root, token count, relevant dimensions,
and limit; an incomplete cycle analysis is never accepted silently.

Lookup is O(1). A stable Kahn sort uses a lexical heap and costs O((V + E) log V); iterative cycle detection, affected traversal, and impact analysis cost O(V + E). Both `explain` and `usages` query this graph; they never scan source strings.

`TokenGraph.patch()` updates token, forward-edge, and reverse-edge indexes in place. It reports a graph delta and unions affected nodes from the pre-patch and post-patch reverse graph, preserving correctness when edges disappear or change target.

Cycles are reported as closed paths with the active context and related source locations. Unknown references are still retained as graph edges, which lets the checker provide nearby canonical-ID suggestions.

Inherited tokens add an edge to their base token, and component pointers add an edge to the token
that owns the component. Consequently cycle detection, `explain`, `usages`, impact analysis, and
incremental invalidation use the same graph semantics for every reference form.

### Why model tokens as a graph?

An alias is not string interpolation—it is a semantic dependency. Once represented as an edge, cycle detection, evaluation order, reverse usage lookup, impact analysis, and incremental invalidation are the same underlying operation rather than separate features.

## Context resolver

Contexts are immutable key/value inputs such as `theme=dark` or `brand=enterprise`. Base values and sparse extension overrides remain attached to one node. Selection uses explicit precedence, specificity, then configured dimension order; equal matches no longer depend on JSON declaration order.

Resolution is lazy and cached by `(TokenId, Context)`. The compiler records only the default context and override combinations actually declared in source. It never materializes complete dictionaries for a theme × brand × density Cartesian product.

The namespaced `$extensions["org.token-compiler.contexts"]` form is a non-standard tokenc extension.
Its dedicated interpreter produces typed context overrides consumed by the same `TokenResolver`;
standard DTCG token parsing does not depend on it. DTCG Resolver instead composes sources before
graph construction, so the two mechanisms have distinct semantics.

## DTCG Resolver Module

`parseResolverDocument(content, source)` is an IO-independent frontend for DTCG 2025.10 resolver
documents. It creates typed `TokenSet`, `ResolverModifier`, `ResolutionSource`, and ordered
resolution items with source locations. Resolver reference objects reuse the canonical RFC 6901
parser. Local sibling fields form a shallow semantic view over the referenced set or modifier:
objects and arrays replace the referenced field, the original is not mutated, and provenance for
both locations is retained. The IO layer loads relative whole-file references; semantic resolution
validates runtime inputs, expands same-document set references, selects modifier contexts, and emits
a source stream in exact `resolutionOrder`.

Conflicts follow the standard last-source-wins rule only inside a Resolver resolution. Ordinary multi-file compilation continues diagnosing duplicate canonical IDs. Aliases are parsed and checked after the selected stream is assembled, so a Resolver is not implemented as a global deep-merge hook.

### Why not global deep merge?

Deep merge destroys provenance, makes precedence an object-order side effect, duplicates unchanged values, and hides which modifier changed a token. Sparse overrides keep identity, type, source, and graph edges stable while context becomes an explicit evaluator input.

## Type checker and diagnostics

The checker validates that reference targets exist and that source and target types agree. Diagnostics contain a stable code, severity, message, primary source, related sources, and optional suggestions. Core code does not add terminal color or print; the CLI renders code frames or JSON.

Duplicate canonical IDs are detected across documents before output. Graph cycles are validated separately from recursive resolution, so a user receives a useful path instead of a stack error.

## Compiler IR

`Compilation` is the sole backend-facing input. Token order is computed from the active dependency
projection of the default context, so symbol targets are declared first even when the conservative
union graph contains mutually exclusive conditional cycles. It also exposes typed `tokensOfType()`
views, the validated graph, declared contexts, `resolveToken()`, and structured `explainToken()`
traces. A backend does not parse, validate, merge, or search source documents.

This boundary keeps source-language concerns on the frontend and platform policy on the backend.

## Reference resolution is backend policy

Global alias resolution would erase useful semantics. CSS wants `var(--dependency)`, TypeScript may want a symbol, while a static target may require a literal. Backends select one of three conceptual strategies:

- `preserve` — emit the target in the platform's reference syntax.
- `symbol` — emit a language binding reference.
- `resolve` — emit the evaluated literal.

The resolver can always provide a value, but the chosen expression remains in IR so a backend decides whether to preserve the edge.

## Why platform outputs are backends

CSS and TypeScript are compilation targets, not formatting callbacks. A backend receives a complete semantic compilation and returns `OutputFile[]`. An optional `validate(compilation)` preflight reports target namespace collisions and platform capability errors before any backend emits. If one backend returns an error, the compilation fails and no partial artifacts are generated. `compile(config, { emit: false })` still runs this preflight, which is how `tokenc check` validates targets without generating files. Artifact collision keys use resolved absolute paths normalized to Unicode NFC and lowercase, so case-only and canonically equivalent paths fail the compilation before the CLI writes anything, regardless of the current filesystem's case behavior. Backend diagnostics use the same structure and appear in both `CompilationResult` and the final `Compilation`.

There are no public transform/filter/action hook taxonomies. This prevents platform rules from leaking into parsing or evaluation.

## Backends

### CSS

Emits canonical custom properties. `preserve` maps references to `var()`, while `resolve` inlines evaluated literals. Context selector blocks compare their emitted representation to the default and include differences only. Automatic selectors identify one complete canonical context; unsafe UTF-16 code units in its key use `%XXXX` encoding. They fail with `BACKEND_CONTEXT_COVERAGE` when a sparse predicate omits another varying dimension whose combinations have not all been declared. A custom base selector with automatic non-default contexts is rejected because the backend cannot prove the generated selectors will override it. A non-empty `selectors` map instead defines the explicit, validated context output set; different contexts cannot reuse the same selector, and a custom base with explicit variants must appear as the map's default-context entry.

Numbers retain their source precision, and sRGB uses hexadecimal only when every component can be represented exactly by 8 bits. Cubic Bézier, border, transition, and shadow values use valid CSS serialization; typography is split losslessly into suffixed variables, with control characters encoded using CSS string escapes. Negative fields that CSS forbids, unrepresentable font-family code units, and custom dash-array stroke styles produce `BACKEND_UNSUPPORTED_VALUE`. DTCG gradients contain stops but no CSS gradient function or geometry, so the backend rejects them until an explicit platform transform supplies that policy. Custom-property syntax, normalized names, and generated suffixes are checked before emit.

### TypeScript

Flat mode emits topologically ordered bindings and supports symbol references. Object mode emits a nested `as const` object; symbol mode uses private ordered bindings when necessary.

### Tailwind v4

Emits `--token-*` runtime properties, sparse context overrides, and `@theme` bindings. Tailwind variables point at the runtime layer so ordinary CSS and utilities share values and theme switching does not duplicate the semantic token store. It uses the same encoded, exact-context output contract and coverage checks as CSS instead of depending on source-order cascade between dimensions. The backend reuses the CSS value serializer, including its precision and unsupported-value policy. Tailwind theme names are canonicalized and collision checked; top-level namespace tokens use `default` instead of producing an empty suffix.

## Incremental compilation

`IncrementalCompiler` caches parsed documents by source. On update:

1. Parse only the changed document into the unresolved source cache.
2. Relink cached syntax documents so cross-document inference, pointers, and inheritance observe the
   new semantic state without reparsing unchanged files.
3. Compare semantic node signatures to identify changed IDs.
4. Patch only added, changed, and removed graph nodes and adjacency edges.
5. Union reverse traversal from before and after the patch.
6. Check references and cycles in the affected region (falling back to a full check after an invalid build).
7. Seed the next resolver with cached evaluations whose IDs are outside the affected set.
8. Recompute affected evaluations lazily as IR/backends request them.

Backends may rewrite a complete output file in v0.1, but that does not reparse or reevaluate unrelated tokens. Add, change, and remove share the same invalidation path. Invalid JSON replaces only that cached document, reports diagnostics, and can recover on the next edit.

## Measurement boundary

Every `CompilationResult` includes observational work data in `stats`. `timings` reports
`parse`, `link`, `graph`, `check`, `resolve`, and `emit` durations plus end-to-end `total` time in
milliseconds. Incremental updates assign changed-document parsing to `parse`, whole-batch semantic
relinking to `link`, signature comparison and graph patching to `graph`, and resolver-seed preparation
to `resolve`.

`contextCycles` reports candidate strongly connected regions, the sum of their relevant dimensions,
estimated and enumerated projections, static-cycle early exits, projection-limit hits, and estimate
saturation. These values describe work already performed; neither timings nor counters select a
compiler behavior or suppress a diagnostic. The versioned benchmark harness in `benchmarks/` records
the same boundary with isolated timing and peak-memory samples.

## Impact API

`TokenGraph.analyzeImpact(changedIds)` separates direct from indirect dependents. It is intentionally a core API even though a `diff` CLI is not included yet; CI and pull-request review can use the same semantic graph.

## Computed-token extension point

The current expression union contains literal, whole-token reference, and resolved JSON Pointer
component nodes. A future `ComputedTokenNode` can be added as another expression kind and contribute
dependency edges before graph construction. Function parsing and evaluation would be compiler
stages; backends would continue consuming the same resolved IR. v0.1 does not introduce a
non-standard function syntax.

## Package boundaries

```text
@tokenc/core
  ↑
  ├─ @tokenc/backend-css
  │    ↑
  │    └─ @tokenc/backend-tailwind
  ├─ @tokenc/backend-typescript
  └─ @tokenc/cli → backends
```

Core never imports the CLI or a backend. Backends depend only on public core IR. The CLI owns configuration loading, filesystem writes, terminal output, signals, and watch lifecycle.
The Tailwind backend additionally reuses the CSS backend's public value serializer, while still
reading Core IR without mutating either the CSS backend or Compilation state.
