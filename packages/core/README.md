# @tokenc/core

The compiler core for tokenc: a typed, graph-based compiler for DTCG Design Tokens.

```bash
vp add -D @tokenc/core
```

```ts
import { compile, parseTokenId } from "@tokenc/core";

const snapshot = await compile({
  source: ["tokens/**/*.json"],
});

const impact = snapshot.query.impact([parseTokenId("color.blue.600")]);
```

The package exposes the DTCG 2025.10 token and Resolver document parsers, typed Token AST, immutable
Graph snapshots, context-aware resolution traces, affected-subgraph queries, compiler IR, and
Diagnostic v1. Diagnostics include registered metadata, semantic locations, stable fingerprints,
and validated fixes; the published JSON Schema is exported as
`@tokenc/core/diagnostic-v1.schema.json`. Explain traces are described by
`@tokenc/core/explain-trace-v1.schema.json`. Core performs no terminal output, process termination,
or artifact writes.

Consumer queries use `snapshot.query`: `token`, `definition`, `tokenAt`, `completions`, `resolve`,
`dependencies`, `usages`, `impact`, `graph`, and `explain`. Conditional queries accept a concrete
Context or a `ContextPredicate`; unscoped results retain their exact conditions. `explain` returns
the versioned `ExplainTraceV1` structure.

Context-aware cycle checking projects only the dimensions relevant to each cyclic candidate region.
It computes the projection size before enumeration and enforces the exported
`CONTEXT_CYCLE_PROJECTION_LIMIT` of 16,384 contexts per region. Larger projections fail with a
source-backed `TOKEN_CONTEXT_PROJECTION_LIMIT` error that identifies the region and dimensions;
the checker never silently skips an incomplete cycle analysis.

Every snapshot reports read-only measurement data in `snapshot.stats`. The `timings` object splits
work into `parse`, `link`, `graph`, `check`, `resolve`, and `emit` stages plus end-to-end `total`
milliseconds. `contextCycles` records candidate regions, relevant dimensions, estimated and
enumerated projections, static early exits, limit hits, and whether an estimate saturated at
`Number.MAX_SAFE_INTEGER`. These counters describe work performed; they never change compilation
semantics or replace diagnostics.

Backends declare `BackendCapabilities` and implement `prepare(CompilationIR) → BackendPlan` followed
by `emit(plan)`. `CompilationIR` is immutable and exposes no Graph or Resolver internals. Plans contain
all diagnostics, allocated symbols, and ordered artifact identities/paths. Core validates all plans
globally before any emit, and throws `BackendContractError` if emitted identities or paths differ from
the plan. The shared `SymbolAllocator` applies namespace-specific Unicode normalization, case policy,
reserved-name and pattern checks, collision detection, and explicit rename maps. Artifact paths must
be normalized relatives and are compared with portable NFC/case-folding rules.

`compile()` and `compileDocuments()` return an immutable `CompilationSnapshot`. A valid snapshot
owns the fixed IR and exposes `prepare(backends)` and `emit(backends)`; an invalid snapshot keeps
source and graph queries but has no IR or emit method. Backend diagnostics are returned by those
operations and never mutate the snapshot's semantic diagnostics. Public revisions are owned by
compilation and Session publication.

`createCompilerSession()` provides FIFO, atomic add/update/remove/reconfigure transactions over an
injectable `DocumentLoader`. It caches parsed documents by content, links independent cross-document
components separately, reuses an unchanged conditional Graph, and retains resolved `(TokenId,
Context)` entries outside the affected conditional region. `session.metrics` reports each stage's
hits, misses, reused/recomputed counts, and invalidation reasons; Backend plans remain uncached.
Failed semantic updates publish an invalid current snapshot while preserving
`lastSuccessfulSnapshot`; loading failures and cancellation publish nothing. Retained snapshots
remain immutable after later transactions.

`snapshot.query.context(overrides)` is the public way to derive the effective frozen Context from
configured defaults, the active Resolver selection, and caller overrides.

`planResolverPermutations(document, { filters, limit })` returns an immutable iterable
`ResolverPermutationPlanV1` without materializing the Cartesian product. Exact filters are validated
up front, and any enumeration with more than one combination requires an explicit positive limit.
`compileResolverPermutations(session, plan)` visits the plan through one ordered Session, preserving
parse/link cache reuse while Context-dependent Graph/resolve work is explicitly invalidated as
needed. `compareResolverPermutations(baseSession, headSession, plan)` compares matching Contexts via
Snapshot Diff v1. Optional batch Backend emission prepares every selected plan and rejects portable
cross-Context artifact-path collisions before the first `emit()` call.

`compareSnapshots(base, head, { context })` produces an immutable `SnapshotDiffV1` for one explicit
Context. It distinguishes add/remove, direct and propagated value, type, metadata, dependency, and
Context-coverage facts; merges impact from both revision Graphs; and keeps rename candidates
advisory. Optional trusted Backend pairs compare symbols and planned artifact paths through
`prepare()` without calling `emit()`. Invalid input or unavailable coverage returns `incomplete`
rather than an empty success. `serializeSnapshotDiff()` emits deterministic JSON, and the schema is
exported as `@tokenc/core/snapshot-diff-v1.schema.json`. Git acquisition and report rendering remain
outside Core.

`evaluateSnapshotPolicy(diff, policy)` evaluates the versioned breaking-change policy exclusively
from immutable `SnapshotDiffV1` facts. Defaults fail Token removal, type and Context-coverage
changes, and Backend symbol/artifact-path removal; direct and propagated value changes default to
warnings. Rule severity and Context scope are configurable. Allow entries retain findings for audit,
must reference a stable `changeId`, and cannot suppress compiler diagnostics. Unknown rules, stale
allow entries, invalid policy values, and incomplete comparisons fail closed. The authored policy
schema is exported as `@tokenc/core/breaking-policy-v1.schema.json`.

`buildImpactReport(snapshot, { documents, context?, base? })` maps canonical Snapshot document
identities to their owned Token IDs and returns direct and transitive reverse-Graph impact. An
optional base Snapshot retains removed Tokens and base-only consumers. Omitting `context` preserves
Predicate regions; invalid coverage and unknown sources fail closed. `serializeImpactReport()` is
byte-stable, and its schema is exported as `@tokenc/core/impact-report-v1.schema.json`.

The compiler has one source language: DTCG 2025.10. Foreign and legacy formats must be converted to DTCG before calling the parser or compiler.

The supported M1 entry points and breaking replacements are listed in the repository's
[`M1-API-STABILITY.md`](../../docs/M1-API-STABILITY.md). Deep imports and mutable Graph/Resolver
constructors are not public API.

Requires Node.js 22.13 or newer. Licensed under MIT.
