# RFC 0002: Compilation Snapshot and Compiler Session

[简体中文](0002-snapshot-session.zh-CN.md)

- Status: Accepted
- Milestone: M1-02 / M1-07 / M1-08
- Updated: 2026-08-30

## Summary

tokenc represents one complete, atomically published set of compiler facts as an immutable
`CompilationSnapshot`. A long-lived `CompilerSession` serializes source and configuration
transactions. A failed update publishes the current invalid snapshot; the last successful result is
available only through an explicit `lastSuccessfulSnapshot`. Cancellation and internal exceptions do
not publish a snapshot.

This RFC directly removes the mutable public `Compilation`, `CompilationResult`, and
`IncrementalCompiler` model. `compile` remains a one-shot convenience entry point but returns a
snapshot. No legacy result shape or facade is provided.

## User problem

The current `IncrementalCompiler` mutates a Graph in place and then replaces `result`. Callers cannot
safely retain old results or distinguish current invalid source from a previous successful artifact.
Updates cover only single-file update/removal; configuration, Resolver, cancellation, concurrency,
and virtual loading have no shared transaction semantics. CLI, future CI, and LSP clients could
therefore implement divergent lifecycles.

## Decisions

### 1. A Snapshot is an immutable published fact set

```ts
type CompilationSnapshot = ValidSnapshot | InvalidSnapshot;

interface SnapshotBase {
  readonly revision: number;
  readonly graphRevision: number;
  readonly sourceRevision: string;
  readonly diagnostics: readonly Diagnostic[];
  readonly query: CompilationQuery;
  readonly stats: CompilationStats;
}

interface ValidSnapshot extends SnapshotBase {
  readonly status: "valid";
  readonly ir: CompilationIR;
}

interface InvalidSnapshot extends SnapshotBase {
  readonly status: "invalid";
  readonly ir?: never;
}
```

- `revision` increases monotonically for every transaction published by one Session, including an
  invalid snapshot.
- `graphRevision` increases only when semantic graph facts change. Source-range-only and Backend
  configuration changes do not increase it.
- `sourceRevision` is a deterministic digest of all input content, Resolver input, and semantically
  relevant configuration. It excludes time and the absolute working directory.
- Snapshot collections, Graph, Query indexes, Diagnostics, and IR remain immutable after publication.
  The implementation must not leak mutable maps, sets, arrays, or internal nodes behind TypeScript
  `readonly`.
- Old and new snapshots are isolated and may be read concurrently by different tasks.

An invalid snapshot preserves every source, parse, occurrence, and Graph query fact that can be built
reliably. `resolve` and `explain` operations requiring complete typing return an explicit
`{ status: "unavailable", diagnostics }`, never a previous successful value. Backend planning accepts
only `ValidSnapshot.ir`.

### 2. A Session commits updates atomically and serially

```ts
interface SessionTransaction {
  readonly documents?: readonly DocumentChange[];
  readonly config?: CompilerConfiguration;
  readonly resolverInput?: CompilationContext;
}

interface CompilerSession {
  readonly currentSnapshot?: CompilationSnapshot;
  readonly lastSuccessfulSnapshot?: ValidSnapshot;
  apply(
    transaction: SessionTransaction,
    options?: { signal?: AbortSignal },
  ): Promise<CompilationSnapshot>;
  close(): Promise<void>;
}
```

`DocumentChange` is a discriminated `add | update | remove` union. One transaction may contain many
files and one configuration change. The Session performs load, parse, link, graph, check, resolve, and
planning prerequisites against private staging state, then publishes with one atomic assignment.

Calls to `apply` on one Session execute FIFO in invocation order. Snapshot reads never wait for an
in-flight transaction. Conflicting operations for one document identity in a transaction produce
`SESSION_CONFLICTING_CHANGE` and publish an invalid snapshot; “last operation wins” is not used.

### 3. Failure, cancellation, and exceptions differ

- User source, configuration, and semantic errors are normal compiler results: publish a new
  `InvalidSnapshot`, update `currentSnapshot`, and leave `lastSuccessfulSnapshot` unchanged.
- A later successful repair publishes a `ValidSnapshot` and updates both pointers.
- An AbortSignal observed in any stage rejects the transaction with `AbortError`, discards staging
  state, does not increment revision, and changes neither pointer. Later transactions still work.
- An unmodeled Backend or Loader exception rejects the API and also publishes nothing. Expected
  failures must become Diagnostics rather than using throws for control flow.
- `close()` is idempotent. Applying after close rejects with `SESSION_CLOSED` without changing an
  existing snapshot.

### 4. Loader is an injectable IO boundary

```ts
interface DocumentLoader {
  load(request: DocumentRequest, signal?: AbortSignal): Promise<LoadedDocument>;
}
```

Core defines request/response types, canonical document identity, content, origin, and an optional
version; it performs no network IO. The CLI supplies a filesystem loader, while hosts may supply
memory or remote loaders. The Loader resolves relative references against the requesting document and
returns a canonical identity; Core does not guess URL or path semantics.

One canonical identity loads at most once per transaction. A Loader version is only an optimization
hint; actual content always secures `sourceRevision` correctness.

### 5. Cache ownership and stage boundaries

M1-08a first implements an uncached Session and differential oracle. M1-08b may add these caches one at
a time:

| Stage        | Owner               | Minimum key                                               | Invalidation                       |
| ------------ | ------------------- | --------------------------------------------------------- | ---------------------------------- |
| Load         | host/loader         | request + loader policy                                   | host-defined                       |
| Parse        | Session             | document identity + content digest + parser version       | content/parser change              |
| Link         | Session             | parsed document digests + resolution order                | document set/order/Resolver change |
| Graph        | Session             | occurrence/candidate semantic digests + ContextDefinition | edge/Context change                |
| Resolve      | Snapshot builder    | graph revision + TokenId + canonical Context              | intersecting edge change           |
| Backend plan | uncached by default | only with a complete stable Backend key                   | IR/options/callback change         |

Every cache reports hit, miss, reused, recomputed, and invalidation reason. A cache cannot be enabled
until the differential oracle proves equality with the uncached Session.

### 6. One-shot compilation and public replacements

- `createCompilerSession(options)` is the primary entry point.
- `compile(options, { signal })` creates a temporary Session, applies one transaction, returns a
  `CompilationSnapshot`, and closes the Session.
- Fold `compileDocuments` into the document-change one-shot entry point.
- Remove public `Compilation`, `CompilationResult`, `IncrementalCompiler`, and `TokenGraph.patch()`.
- Definitions, completion, resolve, explain, dependencies, usages, and impact all use
  `snapshot.query`.
- Migrate CLI `build/check/dev` once in M1-09; there is no dual-track period.

## Configuration invalidation

- Source set or Resolver source changes reload the changed closure and rebuild affected Link/Graph
  facts.
- `ContextDefinition` or resolution-order changes invalidate relevant Graph predicates, cycles, and
  resolved values.
- Checker-policy changes reuse the Graph and rerun the relevant Checker.
- Backend-option changes do not change graph revision; they invalidate the matching plan only.
- cwd or Loader-policy changes recanonicalize and reload every potentially affected document.
- Output-directory-only changes rerun artifact-path planning only.

## Diagnostics

Session lifecycle diagnostics use `SESSION_*` codes; source, Graph, and Backend diagnostics belong to
their respective stages. A Snapshot aggregates them in stable source-identity, primary-offset,
severity, code, and fingerprint order. Failed-transaction diagnostics describe current source only;
they never mix in diagnostics or outputs from the last successful snapshot.

## Test plan

- Atomic multi-document add/update/remove/reconfigure transactions.
- Invalid → invalid, valid → invalid, and invalid → valid transitions.
- Concurrent reads of old and new query/resolve/plan state with no observable mutation.
- Concurrently submitted apply calls with FIFO revisions and deterministic results.
- Cancellation in every stage, preserving revision/current/lastSuccessful and allowing recovery.
- Loader identity, relative references, deduplicated loads, virtual documents, and Loader failures.
- Uncached differential comparison with cold compile for diagnostics, edges, values, traces, and
  output bytes after every mutation.
- M1-08b hit/invalidation counters and the same differential gate for every cache.

## Open questions

None. If review rejects a decision, its replacement and rationale must be recorded here before the
RFC is accepted.

## Explicit non-goals

- Cross-process or disk caches.
- Concurrent write transactions or automatic conflict merging.
- Falling back from an invalid snapshot to old successful values.
- File watching, debounce, or network retry in Core; hosts own them.
- An `IncrementalCompiler` facade, old `CompilationResult` shape, or deprecation alias.
- M1 implementations of diff, SARIF, LSP, or a persistent project daemon.
