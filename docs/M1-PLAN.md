# M1 Execution Plan: Stable Semantic Compiler API

[简体中文](M1-PLAN.zh-CN.md)

> Status: planned, implementation not started. Updated 2026-08-25.
>
> Entry baseline: M0 is complete according to the [M0 acceptance record](M0-ACCEPTANCE.md), and npm
> `latest` is `0.3.0`.

## 1. Intended outcome

M1 is not a backend or command expansion milestone. It turns the existing correctness mechanisms
into stable, embeddable, and composable public interfaces. At exit, the CLI consumes the immutable
semantic snapshot and query API; the same boundary is ready for future CI reporters and the language
server without implementing those M2/M3 clients early.

M1 must produce five user-visible outcomes:

1. Dependencies can be queried by Context instead of exposing only the union of every branch.
2. Every resolved value has a stable trace explaining its source, override selection, and dependency
   path.
3. File changes atomically produce a new snapshot through a long-lived Session while old snapshots
   remain safe for concurrent reads.
4. Backends use shared capability and symbol contracts to complete representation checks before
   emit.
5. Differential tests prove incremental results equal full compilation, with observable cache and
   recomputation metrics.

These outcomes are the intended differentiation from Terrazzo: tokenc does not compete by adding
more transforms. It competes through provable conditional semantics, explainable change,
verifiable incrementality, and an embeddable compiler boundary.

## 2. Baseline and gaps

| Area                    | Available in `0.3.0`                                                                                                   | Boundary required in M1                                                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Conditional correctness | The checker finds cycles in active Context projections and bounds combinatorial work                                   | `TokenGraph` still stores unconditional `TokenId → TokenId` adjacency, so queries cannot return conditions or reference sources |
| Queries and explanation | `Compilation` exposes definition, completion, resolve, and explain; Graph exposes dependencies, dependents, and impact | APIs are dispersed, Context queries are incomplete, and traces have no stable schema/version                                    |
| Incremental compilation | `IncrementalCompiler` reparses changed files, patches the Graph, and seeds unaffected resolver results                 | Every update still relinks and scans signatures globally; the replaceable result is not an immutable snapshot                   |
| Backend safety          | `validate()`, a collision helper, and output-path collision protection exist                                           | Capability and symbol-allocation behavior remains duplicated across backends without a common conformance contract              |
| Diagnostics             | Stable codes, primary source, related locations, and suggestions exist                                                 | No schema version, stable fingerprint, documentation URL, structured fix, or serialization contract                             |
| Performance evidence    | Compile timings, affected/recomputed counts, and a synthetic benchmark exist                                           | No stage hit/miss data, repeated samples, p50/p95, peak memory, or Context-projection metrics                                   |
| Release                 | `0.3.0` was published through OIDC with five tags                                                                      | Retry identity checks, source/environment restrictions, and automated post-publish verification need hardening                  |

In one local 10k-token benchmark, a point edit recomputed only 12 tokens but still took about 173 ms.
M1 performance work must therefore include relinking, diffing, graph work, and diagnostics rather
than optimizing only the resolver cache.

## 3. Scope boundaries

M1 includes:

- Conditional edges, predicate algebra, and a read-only Query API.
- Public contracts for diagnostics, explain traces, backend capabilities, and symbol allocation.
- Immutable `CompilationSnapshot`, long-lived `CompilerSession`, in-process caches, and metrics.
- Migration of the CLI and bundled backends to those public interfaces.
- Differential, conformance, property, and performance tests.
- An injectable document-loading boundary; Core still performs no network requests itself.

M1 excludes:

- `tokenc diff`, SARIF, pull-request reports, and breaking-change policy; these belong to M2.
- A language server or VS Code extension; these belong to M3.
- A Terrazzo adapter, new importers, new backends, or a persistent disk cache.
- Arbitrary object transforms or extensions that mutate a linked snapshot.
- A general Boolean Context language before measurement and RFC review.

## 4. Delivery sequence

### Gate 0: release governance and measurement baseline

#### M1-00 — Close release-integrity gaps (P0)

Work:

- Add an executable preflight step in `publish.yml` that exits nonzero unless
  `github.ref == 'refs/heads/main'`; do not express this as a job-level `if` that reports a green
  skipped job.
- Configure a protected-branch deployment policy for the GitHub `npm` environment. Require an
  independent reviewer when one is available; a single-maintainer exception must be explicit in the
  release record rather than implied by an unprotected environment.
- Add one repository-owned `verify-release` command used locally and by the workflow. It verifies the
  exact five-package set and version, internal dependency ranges, requested dist-tag, locally packed
  candidate versus registry `dist.integrity`, provenance subject digest and source commit, and the
  five expected annotated tags peeling to the release commit.
- Do not silently skip an existing npm version. Verify the published artifact with that command
  before treating it as an idempotent success.
- When an identical version exists under another dist-tag, fail closed with an actionable promotion
  instruction. Automate `npm dist-tag` only after a separately reviewed authentication path proves
  that the trusted workflow is authorized for that operation.
- Handle partial-publication retries and bounded registry eventual consistency without accepting an
  unverifiable artifact.
- Protect package tags from rewriting with a repository ruleset.
- Pin every release-path `uses:` reference, including checkout, to a full commit SHA and enable the
  GitHub Actions ecosystem in Dependabot.
- Run packed-tarball consumer smoke before publish and registry-installed consumer smoke afterward.

Acceptance:

- A dispatch from any ref other than `main` fails in a visible preflight step before publish.
- Registry fixtures cover unpublished, already published and identical, mismatched artifact,
  dist-tag mismatch, partial publication, and delayed registry visibility.
- Tests reject an incorrect tarball digest, provenance subject/source commit, internal dependency,
  dist-tag, environment/ref policy, missing package, non-annotated tag, or tag that peels to another
  commit instead of producing a false green result.
- One documented command reproduces pre-publish and post-publish verification, and both consumer
  smoke modes run in CI/workflow automation.

Dependencies: none. It may run in parallel with M1-01, and local RFC experiments may begin, but M1-00
and M1-01 must both pass before a new public API implementation merges.

#### M1-01 — Characterization and benchmark baseline (P0)

Work:

- Add read-only conditional-cycle metrics: candidate regions, relevant dimensions,
  estimated/enumerated projections, early exits, and limit hits.
- Emit benchmark JSON containing commit, Node, CPU, warm-up, sample count, p50, p95, peak memory,
  parse/link/graph/check/resolve/emit time, and recomputation counts.
- Retain small, wide, deep, and fan-out fixtures; add multidimensional Context and override-heavy
  fixtures.
- Measure the pinned `dtcg-examples` corpus and at least one publishable representative project.
  Clearly label synthetic data when no real corpus is available.

Acceptance:

- One command produces a repeatable machine-readable report without affecting product semantics.
- Retaining or changing the 16,384 projection limit is supported by evidence and any change includes
  regression tests and a changeset.
- M1 pull requests have a common comparison method, but no performance claim against Terrazzo is
  published before repeated measurements.

Dependencies: none; it may run in parallel with M1-00.

### Gate 1: freeze semantic contracts first

#### M1-02 — Three focused RFCs (P0)

Complete and review these before changing public types:

1. **Conditional Graph RFC:** dependency occurrences and sources, edge kinds, raw selectors versus
   effective conditions, precedence, predicate union/complement/empty/canonical DNF or edge
   splitting, `matches/intersect/subtract/isSatisfiable`, complexity limits, and compatibility.
2. **Snapshot and Session RFC:** immutable Graph revisions, snapshot revision, update transactions,
   invalid-snapshot versus last-successful-snapshot behavior, concurrent reads, cancellation, loader
   boundary, cache ownership, and configuration changes.
3. **Backend and Diagnostic RFC:** capability negotiation, symbol namespaces, name normalization,
   `prepare/preflight → BackendPlan → emit`, artifact-path planning, Diagnostic v1, fingerprints, fix
   edits, serialization, and deprecation.

Acceptance:

- Every RFC covers the user problem, failure modes, invalidation, diagnostics, compatibility, tests,
  and explicitly rejected alternatives.
- Override precedence explains how raw selectors become the region where a dependency actually wins;
  a selector cannot simply be equated with its effective condition.
- The predicate representation closes over non-convex unions produced by subtracting higher-priority
  winner regions. It must not approximate them as one conjunction.
- The RFC decides whether repeated dependency occurrences remain separate edges or one edge with
  ordered source occurrences.
- Migration windows are defined for `compile`, `Compilation`, `IncrementalCompiler`, and
  `TokenGraph`.

Dependencies: the Conditional Graph RFC cannot be approved before M1-01 evidence exists. Drafting
of the Snapshot/Session and Backend/Diagnostic RFCs may proceed in parallel. No new public API merges
before Gate 1 passes.

### Wave 1: conditional semantics and stable facts

#### M1-03 — Dependency occurrences, Context predicates, and conditional edges (P0)

Deliver:

- Frontend/Linker output for every dependency occurrence before deduplication, including owner,
  base-or-override candidate identity, target, kind, field path, source range, and source order.
- A normalized internal `ContextPredicate` closed over empty sets and non-convex unions, with matching,
  intersection, complement/subtraction, satisfiability, and stable serialization.
- `DependencyEdge` with `from`, `to`, `kind`, `condition`, and `source`.
- Conditional Graph edges for aliases, JSON Pointers, inheritance, and composite fields.
- A cycle checker using the same edges and predicates instead of its own dependency-selection logic.
- ID-only adjacency retained as a compatibility view, not a second source of truth.

Acceptance:

- Every M0 cycle fixture remains unchanged.
- Tests cover partially overlapping selectors, edges hidden by higher precedence, defaults,
  three-dimensional intersections, repeated references to the same target from different composite
  fields, and exact source ranges.
- Predicate operations have truth-table/property tests and deterministic ordering/serialization.
- Complexity limits are checked before allocation and return stable diagnostics.

Dependencies: the M1-02 Conditional Graph RFC.

#### M1-04 — Public Query API and Explain Trace v1 (P0)

Deliver:

- A read-only query facade for token, definition, dependencies, usages, impact, resolve, and explain.
- Dependency, usage, and impact queries for either a concrete Context or a predicate region, returning
  edge sources.
- `ExplainTraceV1` containing base/override selection, precedence, Context, dependency steps, Resolver
  steps, and final value.
- Stable ordering for every collection and no mutable Map/Set in public results.

Acceptance:

- Repeating a query against one read-only facade yields byte-identical JSON.
- Usages and impact do not produce false positives across mutually exclusive Contexts. A query without
  a concrete Context returns conditions instead of discarding them.
- Existing CLI `explain`, `usages`, and `graph` output has compatibility fixtures.

Dependencies: M1-03.

#### M1-05 — Diagnostic schema v1 (P0)

Deliver:

- A versioned, JSON-serializable Diagnostic contract.
- Stable fingerprints, primary and related locations, documentation URLs, and optional structured
  fixes.
- A diagnostic-code registry recording stage, default severity, and policy-suppression eligibility.
- A compatibility or deprecation path for `suggestions: string[]`.

Acceptance:

- The same behavior receives the same fingerprint in cold and incremental compilation.
- Moving source lines does not create a new issue identity when semantic identity is unchanged, while
  a real semantic change remains distinguishable.
- Golden JSON contains a schema version and compatibility tests; Core emits no terminal text.

Dependencies: the M1-02 Backend and Diagnostic RFC. It may run in parallel with M1-03.

#### M1-06 — Backend planning, Symbol Allocator, and Capabilities (P0)

Deliver:

- Read-only `BackendCapabilities` for token types, reference strategies, and Context output models.
- A `SymbolAllocator` supporting namespaces, case policy, Unicode normalization, reserved names, and
  explicit rename maps.
- An immutable `CompilationIR`, adapted from the current `Compilation` before Snapshot exists, as the
  only backend input; it exposes no mutable Graph or Resolver internals.
- A `prepare/preflight(ir: Readonly<CompilationIR>) → BackendPlan` contract containing diagnostics,
  the allocated symbol table, authoritative ordered artifact identities and paths, and backend-owned
  immutable plan data. Emit consumes only a valid plan.
- `emit(plan)` returns exactly the artifacts declared by the plan and cannot introduce or rename a
  path. Prepare and emit diagnostics belong to the operation result and never mutate the input IR or
  a later snapshot.
- CSS, Tailwind, and TypeScript migrated to the IR/plan contract and shared allocator while retaining
  platform naming rules.
- A shared cross-backend conformance suite for collisions, unsupported values, and partial emission.

Acceptance:

- Every discoverable per-backend symbol, value-level representation, capability, path-validity, and
  within-plan collision error is returned before that backend's `emit()` call.
- Multi-error inputs report every discoverable issue and produce no output.
- Conformance tests assert that emitted artifact identities and paths exactly equal the plan; an
  unplanned artifact is a contract failure.
- All three bundled and a reference custom backend pass the shared suite; M0 golden output changes
  only with an explicit changeset.

Dependencies: the M1-02 Backend RFC, M1-03 conditional facts, and M1-05 Diagnostic v1. It may proceed
in parallel with M1-04.

### Wave 2: snapshots, sessions, and real incremental boundaries

#### M1-07 — Immutable CompilationSnapshot (P0)

Deliver:

- A snapshot with fixed revision, documents, diagnostics, immutable Compilation IR, query facade,
  and semantic-configuration identity.
- An immutable or copy-on-write Graph revision. A snapshot must never wrap the current mutable
  `TokenGraph.patch()` object directly.
- Safe reads after its Session advances; internal caches cannot change observable results.
- `emit(backends)` running preflight against exactly one snapshot, rejecting any cross-backend path
  collision before emit, and then atomically materializing only the planned artifacts.
- Backend operation diagnostics remain separate from the snapshot's fixed semantic diagnostics.
- An adapter migration for the existing `Compilation` API instead of a one-release break.

Acceptance:

- Concurrent resolve, explain, usages, and emit operations on one snapshot are deterministic and do
  not cross-contaminate.
- Building a second snapshot from changed inputs leaves the first snapshot's graph, queries, and
  serialization byte-identical, using a minimal builder harness before the Session exists.
- An unsuccessful snapshot exposes its own diagnostics and refuses emit; it never falls back to
  data from a different revision.
- If otherwise-valid plans from two backends collide, neither backend's emit function is called.

Dependencies: M1-03, M1-04, M1-05, and M1-06.

#### M1-08a — Uncached CompilerSession and differential oracle (P0)

Deliver:

- A correctness-first `CompilerSession` with uncached atomic add/update/remove/reconfigure
  transactions.
- An injectable `DocumentLoader` for filesystem, virtual, or host-provided content; Core adds no
  network IO.
- Failed updates publish a current diagnostic snapshot for the latest sources. An optional
  `lastSuccessfulSnapshot` is explicit and never mixed into current queries or emit.
- The existing `IncrementalCompiler` becomes a compatibility facade over the uncached Session.
- A reusable full-versus-incremental oracle that drives that Session.
- Normalized comparison of diagnostics, conditional edges, resolved values for every enumerated
  Context in bounded fixtures, traces, and output bytes. Timings and cache counters are excluded.
- A deterministic seed mutation corpus covering add, update, remove, invalid/recover, configuration,
  and Resolver changes.

Acceptance:

- The seed corpus has zero unexplained mismatch against full compilation.
- Normalization rules are documented and the oracle is callable from ordinary automated tests.
- Add, delete, invalid JSON, recovery, Resolver change, and backend configuration change have
  transaction and differential tests.
- A retained old snapshot remains unchanged after Session updates, including failed updates.
- AbortSignal cancellation publishes no partial snapshot, and a later update still succeeds.
- The uncached Session and oracle merge before any cache or invalidation optimization.

Dependencies: M1-04, M1-05, M1-06, and M1-07.

#### M1-08b — Stage caches and metrics (P0)

Deliver:

- Explicit cache ownership and keys for parser, linker, conditional Graph, and resolver. Backend plan
  caching is disabled by default and is allowed only when a backend declares a stable cache key that
  covers its options, including user callbacks.
- `SessionMetrics` reporting per-stage hit/miss, reused/recomputed counts, and invalidation reasons.

Acceptance:

- Editing one file produces an unchanged-file parse count of zero.
- Local edits do not unconditionally relink every document; metrics and tests prove actual reuse.
- Every cache or invalidation change passes incremental-versus-full comparison before merge.
- Cache metrics reconcile exactly with the oracle's changed, reused, and recomputed semantic facts.

Dependencies: M1-08a. Every cache optimization remains gated by the oracle.

### Wave 3: migration and proof

#### M1-09 — Migrate the CLI and lock public consumer boundaries (P0)

Deliver:

- `build`, `check`, and `dev` use `CompilerSession` and snapshot emission.
- `explain`, `usages`, and `graph` use only the Query API, not mutable Graph or Resolver internals.
- CLI JSON output uses versioned Diagnostic and Trace schemas.
- Remove or mark private bypasses and add an architecture test preventing their return in either the
  CLI or the bundled backends migrated by M1-06.

Acceptance:

- CLI and direct Core API return identical diagnostic fingerprints, traces, and Context query results
  for the same input.
- Dev mode covers configuration reload, invalid-input recovery, rapid updates, and cancellation.
- An import-boundary check proves the CLI and bundled backends do not import modules marked internal.

Dependencies: M1-04, M1-06, M1-07, and M1-08b.

#### M1-10 — Differential proof, performance gates, and API stability docs (P0)

Deliver:

- Expansion of the M1-08a incremental-versus-full oracle across larger add/update/remove,
  invalid/recover, configuration, and Resolver mutation corpora.
- Comparison of normalized diagnostics, Graph edges, resolved values for every enumerated Context in
  bounded fixtures, traces, and output bytes; only timings and cache counters are ignored.
- Snapshot concurrency, determinism, high-fan-out, and Context-explosion tests.
- API stability/deprecation documentation, M1 migration notes, and public examples.
- Evidence-based regression thresholds derived from M1-01, with a stable low-noise subset in CI.

Acceptance:

- Differential mismatch is zero.
- Every official M1 exit criterion has automated evidence.
- Public API types and machine-readable schemas are locked by API snapshots or compatibility checks.
- `pnpm verify`, package dry-run, packed-tarball smoke test, and clean-worktree gate pass before the
  release candidate is approved.
- After publication, the registry-installed smoke test and M1-00 post-publish integrity checks pass
  before the M1 milestone is closed.

Dependencies: every preceding M1 task. This is the only exit to an M1 release candidate; publication
and registry verification are the final milestone-closure step.

## 5. Dependencies and parallel work

```text
M1-00 release integrity ───────────┐
                                   ├→ Gate 1 ─┬→ M1-03 occurrences/graph ─┬→ M1-04 query/trace ─┐
M1-01 measurements → M1-02 RFCs ──┘          │                           └→ M1-06 backend plans ─┤
                                              └→ M1-05 diagnostics ────────────────┘             ▼
                                                                                       M1-07 snapshot
                                                                                              │
                                                                                              ▼
                                                                                M1-08a uncached session/oracle
                                                                                              │
                                                                                              ▼
                                                                                     M1-08b caches/metrics
                                                                                              │
                                                                                              ▼
                                                                                   M1-09 consumer migration
                                                                                              │
                                                                                              ▼
                                                                                      M1-10 proof/release
```

- M1-00 and M1-01 may start immediately in parallel.
- M1-02 RFC drafting may also begin immediately. Arrows into Gate 1 mean approval/public-API merge
  eligibility, not permission to draft.
- M1-03 and M1-05 may proceed in parallel after RFC review.
- M1-06 can run alongside M1-04 after M1-03 and M1-05. Its immutable Compilation IR input avoids a
  dependency on the later `CompilationSnapshot` type.
- Snapshot, Session, and consumer migration remain sequential to avoid maintaining two unstable
  public models at once.

## 6. Recommended pull-request slices

| Order | Pull request          | Primary scope                                                                       | Merge gate                                         |
| ----- | --------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------- |
| 1     | Release integrity     | ref/environment guard, idempotent verification, post-publish checks, action pinning | registry fixtures and workflow static validation   |
| 2     | Measurement baseline  | benchmark JSON, Context projection metrics, representative fixtures                 | repeatable report and proof of no semantic change  |
| 3     | RFC bundle            | three RFCs and migration policy                                                     | every open question decided or explicitly deferred |
| 4     | Occurrences/predicate | occurrence provenance plus union/complement-safe predicate algebra                  | source-preservation and property tests             |
| 5     | Conditional edges     | edge model, indexes, and cycle migration                                            | M0 fixtures and exact source assertions            |
| 6     | Query and trace       | query facade, Context usages/impact, Trace v1                                       | deterministic JSON fixtures                        |
| 7     | Diagnostic v1         | fingerprints, fixes, registry, and serialization                                    | cold/incremental identity tests                    |
| 8     | Backend contracts     | immutable IR, BackendPlan, authoritative paths, allocator, and conformance          | bundled/custom plan-to-emit equality               |
| 9     | Snapshot              | immutable revisions, concurrent reads, and atomic multi-backend planning            | isolation and cross-backend zero-emit tests        |
| 10    | Uncached Session      | transactions, loader, failure semantics, and differential oracle                    | full mutation corpus has zero mismatch             |
| 11    | Caches and metrics    | stage ownership, metrics, and exact invalidation                                    | oracle-backed cache assertions                     |
| 12    | CLI/boundary lock     | move CLI to public APIs; enforce CLI and bundled-backend import boundaries          | parity and internal-import boundary tests          |
| 13    | M1 release gate       | API docs, deprecation, benchmark thresholds, and changeset                          | every exit criterion passes                        |

Each pull request introduces at most one cohesive public API layer and includes its tests and
documentation. Do not publish a type name first and repeatedly redefine its semantics in later pull
requests.

## 7. M1 acceptance matrix

| Official exit criterion                              | Required automated evidence                                                                                     |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| A one-file edit does not reparse unchanged files     | Parser cache counter and identity fixture asserting zero unchanged-file parses                                  |
| Incremental output equals full compilation           | Deterministic mutation corpus plus property sequences comparing diagnostics, edges, values, traces, and outputs |
| Concurrent reads from one snapshot are deterministic | Parallel query/resolve/emit tests and old-snapshot isolation tests                                              |
| Backends find all planning errors before emit        | Bundled/custom conformance for symbol, value, capability, path, and exact plan-to-emit equality                 |
| Public consumers have no private bypass              | CLI/Core parity plus internal-import boundary checks covering CLI and bundled backends                          |

An M1 release candidate must additionally satisfy:

- No unexplained M0 fixture regression.
- Versioned Diagnostic and trace JSON with compatibility notes.
- Performance reports containing p50, p95, peak memory, and actual recomputation counts.
- No attempt to substitute new backends, an LSP, or an adapter for closure of the Core API.

## 8. Start here

1. Complete M1-00 so the next release cannot enter an unverifiable state.
2. Complete M1-01 and use data to determine the real cost of Context projection and full relinking.
3. Submit the M1-02 RFCs using that evidence; begin the public conditional-edge model only after RFC
   approval.

Implementation status belongs in this document. The overall product direction and milestone exit
criteria remain in the [roadmap](ROADMAP.md).
