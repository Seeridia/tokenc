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
  → immutable CompilationIR
  → TokenBackend.prepare(ir) → BackendPlan
  → global capability, symbol, and artifact preflight
  → TokenBackend.emit(plan)
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
  baseCandidate: DependencyCandidateId
  overrides: ContextOverride[]
  dependencyOccurrences: DependencyOccurrence[]
  inheritance?: TokenInheritance
  source: SourceLocation
```

All standard token types have concrete internal value models and validators.
`cubicBezier`, `strokeStyle`, `border`, `transition`, `shadow`, `gradient`, and `typography` validate
their required fields, closed shapes, and applicable ranges. `TokenExpression<T>`, `TokenNode<T>`,
`ResolvedToken<T>`, and `CompiledToken<T>` carry the resolved token type through the pipeline.

The RFC 6901 engine is an IO-independent DTCG module. A pointer to a token or its complete `$value`
normalizes to a token reference. A pointer to a nested component retains its pointer expression and
resolved component value while producing a `DependencyOccurrence` with its field path and source
range. Backends never parse raw pointers and resolve component references when a platform cannot
preserve them.

## Token ID

`TokenId` is a branded canonical string. `parseTokenId`, `formatTokenId`, `parentTokenId`, `tokenIdFromSegments`, and `tokenIdSegments` define the boundary. Internals use canonical IDs as `Map` keys rather than repeatedly traversing `string[]` paths.

## Dependency graph

`TokenGraph` owns three categories of facts and indexes:

```text
Map<TokenId, TokenNode>       tokens
DependencyEdge[]              conditional edges
Map<TokenId, DependencyEdge[]> forward / reverse indexes
```

Before deduplication, the Frontend preserves every Alias, JSON Pointer, composite-field, and
inheritance occurrence. Each `DependencyEdge` carries owner, target, kind, field path, source range,
and the exact `ContextPredicate` where its candidate wins. A raw selector first subtracts every
higher-ranked candidate region, so it is never confused with its effective condition. Repeated
references remain separate edges.

Predicates are canonical, pairwise-disjoint DNF over a finite Context domain and are closed under
intersection, union, complement, subtraction, and satisfiability. A cycle exists exactly when all
edge conditions on a closed path have a satisfiable intersection. The checker first locates
structural strongly connected regions and then intersects Predicates symbolically; it no longer
enumerates the Context Cartesian product. Cycle diagnostics include the exact edge path, a witness
Context, and one related source location per occurrence.

Token and forward/reverse edge lookups are indexed. Stable Kahn ordering consumes only edges active
in the requested Context. Affected and dependency-closure traversal intersects Predicates while it
propagates, retaining the exact Context region where each Token is reachable.

Every compilation constructs a fresh private Graph. Publication clones and freezes a separate
Graph-backed Snapshot, so advancing a Session cannot mutate a retained snapshot.

Cycles are reported as closed paths with the active context and related source locations. Unknown references are still retained as graph edges, which lets the checker provide nearby canonical-ID suggestions.

Inherited tokens add an edge to their base token, and component pointers add an edge to the token
that owns the component. Consequently cycle detection, `explain`, `usages`, impact analysis, and
incremental invalidation use the same graph semantics for every reference form.

## Query API and Explain Trace v1

`snapshot.query` is the read-only consumer boundary for Token lookup, definitions, completion,
resolution, dependencies, usages, impact, graph projection, and explanation. Dependency and reverse
usage queries accept either a concrete Context or a `ContextPredicate`; without either they return
the original conditional regions. Results contain occurrence source locations and use stable lexical
ordering without exposing internal Maps or Sets.

`query.context(overrides)` returns the frozen effective Context after combining configured defaults,
the active DTCG Resolver selection, and caller overrides. Consumers do not inspect IR or Resolver
state to construct a Context.

Impact results separate changed, directly affected, and indirectly affected Tokens while preserving
the exact predicate attached to each result. Predicate intersections are propagated through the
graph, so two edges that only exist in mutually exclusive Contexts cannot create a false transitive
impact.

`ExplainTraceV1` includes its schema version, canonical Context, selected candidate and
base/override reason for every step, precedence and origin when present, source-located dependency
steps, Resolver steps, and final value. The CLI `explain`, `usages`, and `graph` commands consume only
this facade and support deterministic `--json` output.

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

The checker validates that reference targets exist and that source and target types agree. Every
stage emits `DiagnosticV1`: a complete `schemaVersion: "1"` value with a registry-owned code,
structured parameters, primary and related locations, a documentation URL, optional validated text
edits, and a SHA-256 base64url fingerprint. Fingerprints use canonical document identity, semantic
anchors, and the code registry's identity parameters; messages, severity, display ranges, fixes, and
timings never affect issue identity. Parse failures without a semantic anchor use their parser error
kind and original offset.

Core does not render or print diagnostics. The CLI renders code frames for humans and serializes the
fixed machine-readable envelope `{ "schemaVersion": "1", "diagnostics": [...] }`. Suggestion strings
are not part of the contract: non-mechanical guidance is documentation or related information, while
mechanical guidance uses ordered, non-overlapping edits guarded by a source-content digest.

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

CSS, Tailwind, and TypeScript are compilation targets, not formatting callbacks. A backend declares
`BackendCapabilities` and receives only the immutable `CompilationIR`; Graph and Resolver internals
are not exposed. `prepare(ir)` returns a `BackendPlan` containing every diagnostic, allocated symbol,
and ordered artifact identity/path. Core then performs one global preflight. If any plan has an error,
an unsupported capability, an invalid path, or a cross-backend collision, no backend is emitted.
`snapshot.prepare(backends)` performs this validation without generating files, which is how
`tokenc check` validates targets.

`emit(plan)` receives no compilation state and must return exactly the planned artifact identities and
paths. A missing, extra, renamed, or reordered artifact throws `BackendContractError` and discards the
complete in-memory output set. Artifact paths are normalized relative paths; unsafe paths are rejected,
and collision keys use Unicode NFC plus case folding so outputs are portable across filesystems.

All platform symbols go through `SymbolAllocator`. Each namespace defines its Unicode normalization,
case policy, reserved names, and validity pattern. The allocator reports source-backed collisions and
accepts only explicit rename maps; it never invents unstable numeric suffixes.

There are no public transform/filter/action hook taxonomies. This prevents platform rules from leaking into parsing or evaluation.

## Backends

### CSS

Emits canonical custom properties. `preserve` maps references to `var()`, while `resolve` inlines evaluated literals. Context selector blocks compare their emitted representation to the default and include differences only. Automatic selectors identify one complete canonical context; unsafe UTF-16 code units in its key use `%XXXX` encoding. They fail with `BACKEND_CONTEXT_COVERAGE` when a sparse predicate omits another varying dimension whose combinations have not all been declared. A custom base selector with automatic non-default contexts is rejected because the backend cannot prove the generated selectors will override it. A non-empty `selectors` map instead defines the explicit, validated context output set; different contexts cannot reuse the same selector, and a custom base with explicit variants must appear as the map's default-context entry.

Numbers retain their source precision, and sRGB uses hexadecimal only when every component can be represented exactly by 8 bits. Cubic Bézier, border, transition, and shadow values use valid CSS serialization; typography is split losslessly into suffixed variables, with control characters encoded using CSS string escapes. Negative fields that CSS forbids, unrepresentable font-family code units, and custom dash-array stroke styles produce `BACKEND_UNSUPPORTED_VALUE`. DTCG gradients contain stops but no CSS gradient function or geometry, so the backend rejects them until an explicit platform transform supplies that policy. Custom-property syntax, normalized names, and generated suffixes are checked before emit.

### TypeScript

Flat mode emits topologically ordered bindings and supports symbol references. Object mode emits a nested `as const` object; symbol mode uses private ordered bindings when necessary.

### Tailwind v4

Emits `--token-*` runtime properties, sparse context overrides, and `@theme` bindings. Tailwind variables point at the runtime layer so ordinary CSS and utilities share values and theme switching does not duplicate the semantic token store. It uses the same encoded, exact-context output contract and coverage checks as CSS instead of depending on source-order cascade between dimensions. The backend reuses the CSS value serializer, including its precision and unsupported-value policy. Tailwind theme names are canonicalized and collision checked; top-level namespace tokens use `default` instead of producing an empty suffix.

## Compilation snapshots

`compile()` and `compileDocuments()` publish a discriminated `CompilationSnapshot`. Every snapshot
has fixed document content, stable semantic diagnostics, statistics, source/configuration digests,
and monotonic builder revisions. Only a valid snapshot exposes immutable `CompilationIR` plus
`prepare()` and `emit()`; an invalid snapshot retains safe Graph queries while `resolve()` and
`explain()` return an explicit unavailable result. Backend operation diagnostics remain separate
from semantic diagnostics.

Each publication owns a cloned, frozen Graph view. Query results, resolved values, trace structures,
IR collections, and emitted output records cannot be used to mutate later observations. Backend
planning runs against exactly one IR and global path preflight completes before any backend emits.

## Compiler sessions and differential correctness

`CompilerSession` is the long-lived compilation boundary. Calls to `apply()` enter one FIFO queue
and atomically add, update, remove, or reconfigure documents. Requests are resolved through an
injectable `DocumentLoader`; duplicate requests in one transaction are loaded once. A semantic
failure commits the requested state and publishes an invalid `currentSnapshot` while retaining the
previous `lastSuccessfulSnapshot`. Loader failures and `AbortSignal` cancellation commit and publish
nothing. `close()` is idempotent and rejects later transactions.

M1-08a established an uncached full rebuild for every transaction. This gave stage-cache work one
correctness baseline instead of inheriting the removed mutable `IncrementalCompiler` and
Graph-patching model. The reusable differential oracle applies a deterministic transaction corpus
to a Session and compares each publication with a fresh compilation. It normalizes semantic
diagnostics, the conditional Graph, every resolved value and explain trace over bounded finite
Contexts, and Backend output bytes. Revisions, timings, and cache counters are excluded.

M1-08b layers caches onto that boundary. Parse entries use document identity, content, origin, and
parser version. The Linker partitions documents into conservative cross-document reference
components and reuses components whose ordered parse keys are unchanged; group inheritance falls
back to one safe global component. The conditional Graph is reused only when linked component keys
and `ContextDefinition` are identical. Resolver entries are keyed by Token ID plus canonical Context
and retained only when candidate changes and reverse conditional edges do not reach that exact
Context. Cache state is committed only with the transaction's snapshot. Backend plans stay uncached
because the current Backend contract has no stable key covering arbitrary callbacks.

## Measurement boundary

Every `CompilationSnapshot` includes observational work data in `stats`. `timings` reports
`parse`, `link`, `graph`, `check`, `resolve`, and `emit` durations plus end-to-end `total` time in
milliseconds. A Session transaction reports only the stage work it actually performs.
`session.metrics` reports per-stage hit, miss, reuse, recomputation, and invalidation data for the
latest committed transaction. These measurements cannot select compiler semantics, and every cache
remains gated by the differential oracle.

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

All CLI compilation commands create a `CompilerSession` and consume its snapshot. Dev mode keeps one
Session alive across token, configuration, and Resolver reloads. Its rebuild coordinator aborts
superseded work, suppresses stale output, and remains live after invalid input or configuration.
Architecture tests reject deep or relative imports from Core internals in the CLI and bundled
backends.
