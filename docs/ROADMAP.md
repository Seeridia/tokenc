# tokenc Product Strategy and Roadmap

[English](ROADMAP.md) | [简体中文](ROADMAP.zh-CN.md)

> Status: directional plan, not a release commitment. Updated: 2026-08-31.

This document defines tokenc's intended market position, architecture evolution, delivery order,
and exit criteria. It complements [Architecture](ARCHITECTURE.md), which describes how the system
works today, and the [DTCG support matrix](DTCG-SUPPORT.md), which records current implementation
coverage.

## Executive summary

tokenc should not become a smaller Terrazzo, and the number of backends or importers should not be
its primary competitive measure. Its intended position is:

> **A DTCG semantic compiler for large design systems: strict, explainable, incremental, and
> embeddable in IDEs, CI, and build systems.**

Terrazzo already offers a mature plugin lifecycle, format conversion, resolver permutations,
Figma import, and broad platform output. tokenc's stronger foundations are its typed frontend,
source provenance, explicit dependency graph, lazy context evaluation, structured diagnostics,
and incremental invalidation. The roadmap turns those foundations into user-visible capabilities:

1. Prove that tokens are correct in every valid context.
2. Explain where a value came from, why it changed, and what it affects.
3. Recompute only the semantic region affected by an edit.
4. Let editors, CI, and other tools share one compiler source of truth through stable APIs.
5. Coexist with existing DTCG and Terrazzo workflows to reduce adoption cost.

The first milestones must close known correctness gaps before expanding ecosystem surface. A tool
that supports many outputs but silently emits colliding symbols or invalid composite values is not
a trustworthy compiler.

## 1. Position and boundaries

### 1.1 Division of responsibility with Terrazzo

| Dimension            | Terrazzo strength                        | tokenc target strength                       |
| -------------------- | ---------------------------------------- | -------------------------------------------- |
| Product shape        | Complete token toolchain                 | Embeddable semantic compiler core            |
| Inputs               | YAML, remote references, Figma, bundling | Strict DTCG with traceable provenance        |
| Extensibility        | Flexible plugin transforms               | Typed, staged, cache-safe contracts          |
| Output ecosystem     | Mature multi-platform plugins            | A small set of reference-quality backends    |
| Dependency analysis  | Alias metadata                           | Conditional graph, reverse queries, impact   |
| Incrementality       | Full parse/build watch cycles            | File and Token/Context-level sessions        |
| Errors               | Logger and lint output                   | Stable codes, related ranges, traces, fixes  |
| Developer experience | Broad CLI workflow                       | Shared semantic APIs for IDE, CI, and builds |

Differentiation does not mean rejecting interoperability. The lowest-friction adoption path is to
let teams keep their generation pipeline while using tokenc for strict checks, IDE intelligence,
and pull-request impact reports. Output migration should only be recommended once a corresponding
backend is reference-quality.

### 1.2 Primary users

- Large design-system teams with themes, brands, platforms, or density dimensions.
- Infrastructure teams that need token change impact inside a monorepo.
- Editor authors that need completion, navigation, rename, and live diagnostics.
- Internal design-platform, CI, and build-tool authors embedding a DTCG compiler.
- Enterprises that require reproducible builds, audit trails, and breaking-change controls.

Near-term non-targets include one-off JSON-to-CSS conversion, pipelines that depend on arbitrary
stateful transforms, and general-purpose design asset management or visual authoring.

### 1.3 Product promises

- **Correct** — identical inputs produce identical results; no silent data loss or collisions.
- **Explainable** — every value and diagnostic traces back to source, context, and dependency path.
- **Incremental** — edit cost follows the affected subgraph rather than total repository size.
- **Embeddable** — CLI, language server, and CI are clients of the same public API.

## 2. Principles and non-goals

The following principles remain mandatory:

1. DTCG is the only Core source language. Importers produce DTCG and cannot bypass the frontend.
2. Compilation IR is the only backend input. Backends do not parse, merge, or mutate tokens.
3. Core returns structured results; it does not print, exit, perform network IO, or write files.
4. Canonical token identity, backend symbols, and serialized names are separate concepts.
5. Extensions declare their stage and capabilities. Importers, rules, resolver providers, and
   backends have different contracts.
6. Correctness beats implicit compatibility. Compatibility behavior is explicit and diagnosable.
7. Performance claims require repeatable benchmarks on identical fixtures and environments.

The project will not build an arbitrary object-transform pipeline, put Figma or network IO in Core,
materialize the full context Cartesian product, trade output validity for backend count, build a GUI
before stable APIs, or present `org.token-compiler.contexts` as a standard DTCG feature.

## 3. Target architecture

```text
Foreign / legacy sources
        │
        ▼
Importer SDK ──────────────→ Valid DTCG documents
                                  │
                                  ▼
                         Frontend + provenance
                                  │
                                  ▼
                        Typed semantic model
                                  │
                                  ▼
                    Conditional dependency graph
                                  │
                 ┌────────────────┼────────────────┐
                 ▼                ▼                ▼
          Checker / lint    Incremental session   Query engine
                 │                │          explain / usages / impact
                 └────────────────┼────────────────┘
                                  ▼
                         Immutable Compilation IR
                                  │
                 ┌────────────────┼────────────────┐
                 ▼                ▼                ▼
          Backend SDK       Language Server      CI reporters
                 │                                  │
                 ▼                                  ▼
       CSS / TS / platform files             JSON / SARIF / PR
```

Expected public boundaries are `@tokenc/core`, a long-lived `@tokenc/session`,
`@tokenc/language-server`, `@tokenc/ci`, platform backends, and external-format importers. These
names do not require immediate package splits. Implement modules inside Core until their APIs are
stable; do not create packages merely to match the diagram.

## 4. Core technical workstreams

### 4.1 Conditional dependency graph

Edges must evolve from an unconditional `from → to` pair into semantic records:

```ts
interface DependencyEdge {
  readonly from: TokenId;
  readonly to: TokenId;
  readonly kind: "alias" | "json-pointer" | "inheritance" | "composite-field";
  readonly condition: ContextPredicate;
  readonly source: SourceLocation;
}
```

Cycle detection must operate on satisfiable context projections and report the triggering
condition. Reverse usages and impact results include edge conditions. Incremental invalidation only
drops affected `(TokenId, Context)` entries. Fixtures must cover mutually exclusive overrides,
overlapping predicates, multiple dimensions, base/override paths, and true conditional cycles.

### 4.2 Name and symbol allocation

Every backend performs an allocation pass before serialization:

```text
Canonical TokenId → naming policy → symbol table → collision diagnostics → serialization
```

The shared model handles case sensitivity, punctuation normalization, reserved words, invalid
leading characters, and Unicode normalization. Diagnostics point to both tokens. Explicit rename
maps may resolve collisions; unstable numeric suffixes are not the default. CSS custom properties,
Tailwind namespaces, and TypeScript bindings use separate symbol tables that query and IDE APIs can
inspect.

### 4.3 Type and value serialization

Backends declare supported token types, reference strategies, and context modes:

```ts
interface BackendCapabilities {
  readonly tokenTypes: ReadonlySet<TokenType>;
  readonly references: ReadonlySet<"preserve" | "symbol" | "resolve">;
  readonly contexts: "none" | "selectors" | "files";
}
```

An unrepresentable composite or color space produces a diagnostic rather than `JSON.stringify` or
silent degradation. The CSS backend is the reference implementation and should first complete
legal serialization for border, shadow, gradient, transition, and typography values. Lossy output
requires an explicit, documented policy.

### 4.4 Compiler Session

The target API is a long-lived, snapshot-based session:

```ts
const session = await createCompilerSession(config);
await session.update({ source: "tokens/color.json", content });

const snapshot = session.snapshot();
snapshot.diagnostics;
snapshot.analyzeImpact(changedIds);
snapshot.explain(tokenId, context);
await snapshot.emitAffected([cssBackend]);
```

The design must define immutable snapshot reads, transactional add/change/remove and recovery,
cache ownership across compiler stages, resolver invalidation, configuration and compiler-version
cache keys, and behavior after a failed build. Start with in-process caching. Persistent caching is
enabled only after deterministic output and cache-correctness fixtures exist.

### 4.5 Resolver permutations

Keep one-input compilation as the simple API, then add lazy planning and batch analysis:

```ts
const plan = await compiler.planResolverInputs();
for (const permutation of plan.validPermutations()) {
  await session.compilePermutation(permutation);
}
```

Enumeration is explicit and supports filters or limits; it does not materialize a Cartesian product
by default. Permutations share source, linker, and graph caches. Output collisions are checked before
writes, and two permutations can be semantically diffed. Remote resolution comes from an injected
loader; Core performs no network IO.

### 4.6 Diagnostics and lint policy

Compiler errors, backend capability errors, and optional organizational lint are distinct levels.
Lint rules read a semantic snapshot and return `Diagnostic[]`; they cannot mutate tokens or change
resolution order. The diagnostic schema should grow rule IDs, documentation URLs, fix edits,
suppression reasons, and stable fingerprints shared by IDE, SARIF, and incremental deduplication.

### 4.7 Queries, diff, and CI

`explain`, `usages`, and `graph` should be clients of a public Query API. Planned commands include:

```bash
tokenc explain color.action.primary --context theme=dark
tokenc usages color.brand --context theme=light
tokenc impact tokens/brand.json --format json
tokenc diff --base main --head HEAD
tokenc check --format sarif
```

Semantic diff distinguishes additions, removals, rename candidates, direct and propagated value
changes, type and metadata changes, context coverage, backend symbols, affected output files, and
potential breaking changes. Git integration stays in CLI/CI; Core compares two snapshots without
running Git.

### 4.8 Language Server

The language server consumes Compiler Session rather than maintaining another parser. Its first
release covers diagnostics, alias completion, definition, references, hover, workspace symbols,
collision-safe rename, and structured code actions. Context switching UI, inline previews, graph
views, and rich diff views follow later. The VS Code extension stays thin so functionality is not
bound to one editor.

### 4.9 Interoperability

tokenc should accept standard DTCG projects with low friction: recognize root `$schema`, preserve
unknown `$extensions`, distinguish unsupported features from invalid syntax, and expose a
`DocumentLoader` for virtual or remote sources. An optional Terrazzo adapter may feed standard DTCG
into tokenc or consume a bundled input for checks, LSP, and impact analysis. It must not import the
Terrazzo transform pipeline into Core or promise to reproduce arbitrary plugin side effects.

## 5. Milestone roadmap

Release numbers will be assigned during release planning. Milestones use exit criteria instead of
dates so elapsed time is not confused with completion.

### M0 — Trustworthy baseline

**Goal:** remove behavior that silently produces incorrect output or rejects common DTCG input.

**Status (2026-08-25): complete.** All exit criteria passed, and the five public packages were
published as `0.3.0` with npm provenance and annotated package tags. Backend validation during
`tokenc check`, output-path collision protection, safeguards for incomplete multi-dimensional
CSS/Tailwind context output, and a pinned categorized ecosystem baseline are all part of the
released behavior. Evidence and release-governance follow-ups are recorded in the
[M0 acceptance record](M0-ACCEPTANCE.md).

Deliverables:

- Cross-backend collision detection.
- Context-aware cycle detection with a deterministic 16,384-projection limit per candidate region.
- Root `$schema` support.
- Valid composite CSS/Tailwind output or explicit unsupported diagnostics.
- Correct top-level Tailwind namespace naming.
- Consistent package versions, Core `VERSION`, release docs, and generated-file policy.
- Clean-checkout CI that prevents declarations leaking into `src`.
- Categorized coverage of a pinned DTCG ecosystem example corpus.

Exit criteria:

- Collision and conditional-cycle fixtures pass.
- No backend silently emits composite JSON as a platform value.
- Check, build, and test pass on a clean checkout and leave it clean.
- Support documentation matches behavior and every unsupported case is diagnosed.
- A release ships the fixes with migration notes.

### M1 — Stable semantic compiler API

**Goal:** expose the differentiated compiler behavior as reliable public APIs.

**Status (2026-08-31): implementation complete; 0.4.0 release candidate.** Ordered work packages,
dependencies, and automated acceptance evidence are recorded in the [M1 execution plan](M1-PLAN.md).
The [M1 acceptance record](M1-ACCEPTANCE.md) accepts the local candidate. Publication and
post-publish registry verification remain before milestone closure.

Deliverables:

- Conditional edges and context-aware graph queries.
- Shared symbol allocation and backend capability contracts.
- Stable explain-trace schema.
- Immutable `CompilationSnapshot` and in-process `CompilerSession`.
- Cache metrics for parse, link, graph, and resolve stages.
- Diagnostic schema v1 with fingerprints, related ranges, and optional fixes.
- API stability and direct breaking-replacement policy.

Exit criteria:

- A one-file edit does not reparse unchanged files.
- Differential tests prove incremental output equals a full build.
- Concurrent reads from one snapshot are deterministic.
- Backends discover all symbol, value-representation, capability, and output-path errors before emit.
- CLI and bundled backends use public Session, Query, IR, and planning APIs without private bypasses.

### M2 — CI and change intelligence

**Goal:** make tokenc valuable as a safety layer for existing token pipelines.

**Status (2026-09-01): complete; `0.5.0` is published under the `next` dist-tag and M2 is closed.** The
change-intelligence contract, evidence baseline, public Snapshot Diff v1 and Impact Report v1 APIs,
JSON Schemas, `tokenc impact`, the read-only Git-backed `tokenc diff`, and Breaking-change Policy v1
are complete. Shared Report v1 text/JSON/SARIF rendering and lazy Resolver permutation planning,
Session compilation, Snapshot Diff comparison, and batch Backend preflight are also complete. The
commit-pinned CI reference workflow, fork-safe artifact path, and executable four-outcome fixture
are complete. The bounded, public-API-only Terrazzo handoff and explicit unsupported-extension
classification, independent differential proof, semantic-work gates, public contract lock, and
packed release evidence are complete. Registry, provenance, dist-tag, and annotated-tag verification
passed in the authorized release workflow; see the [M2 acceptance record](M2-ACCEPTANCE.md).

Deliverables:

- `tokenc diff` and `tokenc impact`.
- Stable text, JSON, and SARIF output.
- Configurable breaking-change policy.
- Resolver permutation enumeration, filtering, and comparison.
- GitHub Actions examples and generic CI documentation.
- Terrazzo coexistence guide and experimental adapter.

Exit criteria:

- Reports distinguish direct, propagated, and context-specific impact.
- SARIF points to accurate source locations in GitHub code scanning.
- Diff output has a versioned schema and snapshot tests.
- A realistic medium/large fixture validates complete impact traversal.
- Adapter failures cannot change Core semantics; unknown extensions are clearly classified.

### M3 — IDE-first experience

**Goal:** bring the shared compiler source of truth into the edit loop.

**Status (2026-09-01): execution plan accepted; M3-00 is next.** The milestone targets the `0.6.0`
release line, a public `@tokenc/language-server`, and a thin installable VS Code client. Contract,
workspace, trust, cancellation, feature, benchmark, and release sequencing are fixed in the
[M3 execution plan](M3-PLAN.md).

Deliverables:

- `@tokenc/language-server` and a thin VS Code extension.
- Completion, definition, references, hover, rename, and code action.
- Context-aware diagnostics and resolved-value previews.
- Performance budgets for startup, updates, cancellation, and high-fan-out edits.

Exit criteria:

- LSP and CLI return identical diagnostics for the same snapshot.
- Rename detects canonical and target-backend collisions before writing.
- Invalid JSON does not crash the service and recovery is automatic.
- Benchmarks cover cold start, one-file edits, and high-fan-out edits.
- The protocol layer does not duplicate frontend or graph logic.

### M4 — Controlled ecosystem expansion

**Goal:** expand platform coverage after the core contracts stabilize.

Candidates, ordered by demonstrated user demand:

- Read-only Lint Rule SDK.
- Importer SDK and one reference importer.
- One of Sass, Swift, or Kotlin at a time.
- Vite, esbuild, or Rollup integration.
- Optional persistent build cache.
- Read-only web graph or CI report viewer.

Exit criteria:

- Third-party extensions have a compatibility test kit.
- Extension APIs define version compatibility and capability negotiation.
- Plugins cannot mutate linked semantic snapshots.
- New backends pass the shared type/reference/context conformance suite.
- Persistent cache on and off produce byte-identical output.

## 6. Cross-milestone sequencing

| Workstream          | M0                   | M1                   | M2               | M3                  | M4               |
| ------------------- | -------------------- | -------------------- | ---------------- | ------------------- | ---------------- |
| DTCG conformance    | Baseline and gaps    | More fixtures        | Permutations     | IDE diagnostics     | Maintenance      |
| Conditional graph   | Correct cycles       | Queries/invalidation | Diff/impact      | References/rename   | Rule queries     |
| Backend correctness | CSS/Tailwind fixes   | Capabilities/symbols | Output impact    | Rename preview      | New backend      |
| Incremental engine  | Correctness fixtures | Session API          | Snapshot diff    | LSP-held session    | Persistent cache |
| Diagnostics         | Source accuracy      | Schema v1/fixes      | SARIF            | Code actions        | Lint SDK         |
| Interop             | `$schema`/extensions | Loader API           | Terrazzo adapter | Workspace discovery | Importer SDK     |

Prioritize work by asking whether it prevents silent error or data loss; reinforces correctness,
explainability, incrementality, or embeddability; serves multiple clients; and can be verified by
conformance, differential testing, or benchmarks. Features that only increase surface area without
strengthening those promises wait.

## 7. Test and quality strategy

The test pyramid includes DTCG parser conformance, semantic fixtures, incremental-versus-full
differential tests, backend conformance, serialization goldens, property/fuzz tests for IDs,
pointers, graph patching and predicates, performance benchmarks, and CLI/LSP end-to-end tests.

Maintain at least four benchmark classes:

| Fixture               | Purpose                                    |
| --------------------- | ------------------------------------------ |
| Small conformance     | Fast coverage of every semantic rule       |
| Wide graph            | Independent tokens and parse/link cost     |
| Deep graph            | Alias chains, cycles, and stack safety     |
| High-fan-out contexts | Impact traversal and Token/Context caching |

Any comparison with Terrazzo fixes Node version, hardware, fixture, cache state, output target, and
run count, then reports median, p95, peak memory, and tokens actually recomputed. A finer-grained
architecture is not automatically faster in measured workloads.

Every public release requires a clean checkout to pass format, lint, typecheck, build, and tests;
synchronized support documentation; bilingual public docs and a changeset for behavior changes;
compatibility notes for machine-readable schemas; deterministic backend output; and no unexplained
regression in agreed performance budgets.

## 8. Success metrics

Correctness metrics include categorized DTCG example coverage, zero known silent-invalid-output
cases, zero differential mismatches, and stable codes plus primary locations for semantic errors.

Performance metrics include cold compile time and peak memory, percentage of files reparsed after an
edit, percentage of Token/Context entries rechecked or reevaluated, p50/p95 latency for low- and
high-fan-out edits, and Compiler Session cache hit rate. Concrete budgets follow a published
baseline rather than an arbitrary millisecond target.

Adoption metrics include projects using check/diff without backends, active LSP workspaces and
diagnostic latency, breaking changes caught in CI, percentage of Core APIs reused across CLI/LSP/CI,
and whether third-party extensions can use public APIs only. Download and backend counts are
secondary metrics, not the north star.

## 9. Risks and controls

| Risk                            | Consequence                         | Control                                                |
| ------------------------------- | ----------------------------------- | ------------------------------------------------------ |
| Copying Terrazzo too early      | Diffuse effort and unclear identity | Filter work through the four promises                  |
| Conditional-graph complexity    | Unprovable cycle/impact behavior    | Define predicate algebra and truth fixtures first      |
| Premature package splits        | Repeated compatibility breaks       | Modularize internally before publishing                |
| Excessive strictness            | Existing projects cannot adopt      | Separate standard errors, unknown extensions, and lint |
| Mutable plugins                 | Non-reproducible caches and output  | Read-only, staged, capability-declared extensions      |
| CLI/LSP drift                   | Different answers for one project   | Require a shared Session snapshot                      |
| Unsupported performance claims  | Loss of trust                       | Publish fixtures, commands, and methodology            |
| Excessive scope for maintainers | Milestones never complete           | Finish exit criteria before expanding ecosystem        |

## 10. Decision and contribution process

A short RFC is required for new Core syntax or extensions, breaking changes to `TokenNode`, graph
edges or Compilation IR, new mutation-capable extension types, breaking diagnostic/machine-output
schemas, and new packages or dependency directions. An RFC states the user problem, why current APIs
are insufficient, semantics and failure modes, incremental consequences, diagnostics,
compatibility, tests, and rejected alternatives.

Issues should identify workstream, milestone, and kind, for example:

```text
area:graph       milestone:M0       kind:correctness
area:session     milestone:M1       kind:architecture
area:ci          milestone:M2       kind:product
area:lsp         milestone:M3       kind:developer-experience
```

After each milestone, update this document, remove invalid assumptions, and move delivered behavior
into Architecture or the support matrix. The roadmap must not become a second, stale feature guide.

## 11. Immediate execution order

M0 is complete and published as `0.3.0`. M1 follows the detailed [execution plan](M1-PLAN.md):

1. Close release-integrity gaps before the next public release: verify existing registry artifacts
   and dist-tags, restrict publishing to `main`, protect the npm environment, and automate
   post-publish verification.
2. Measure conditional-cycle projections and end-to-end incremental costs on repeatable corpora.
3. Approve the Conditional Graph, Snapshot/Session, and Backend/Diagnostic RFCs.
4. Implement conditional edges, stable queries and traces, Diagnostic v1, and shared backend
   contracts.
5. Build immutable snapshots and the public Compiler Session, then prove incremental/full
   equivalence.
6. Migrate the CLI to the public API before starting diff, SARIF, LSP, or adapter work.

The strategic test remains:

> Terrazzo can focus on sending tokens to more places; tokenc must prove that those tokens are
> correct in every valid context and explain every change precisely.
