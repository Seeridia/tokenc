# RFC 0004: Change Intelligence

[简体中文](0004-change-intelligence.zh-CN.md)

- Status: Accepted for M2-00
- Milestone: M2-00 / M2-01 / M2-02 / M2-03 / M2-04 / M2-05
- Updated: 2026-09-01

## Summary

Change intelligence compares two immutable `CompilationSnapshot` values. Core receives snapshots;
it never reads Git, executes configuration files, emits Backend artifacts, or decides organizational
policy. The comparison records versioned semantic facts, exact Context coverage, the union of impact
found in the base and head Graphs, advisory rename candidates, and Backend plan changes.

`SnapshotDiffV1` is the authority for comparison facts. Impact Report v1 is the source-or-token to
affected-token envelope used by the CLI. JSON is authoritative; text and SARIF are deterministic
projections. Invalid input or bounded-out Context coverage produces an explicit incomplete result,
never a successful empty diff.

M2-00 freezes this design, fixtures, draft schemas, and a performance baseline. It deliberately adds
no production command or public Core type.

## User problem

A raw JSON or Git diff cannot answer whether a token's resolved value changed, which consumers are
affected, whether two Context branches overlap, or whether a Backend renamed an exported symbol.
Conversely, a single-snapshot reverse-usage walk misses consumers that exist only on the other side
of a revision boundary. CI also needs to distinguish a complete policy pass from a comparison that
could not be performed.

The result must be useful to teams that keep another generator. It therefore reports semantic facts
without requiring tokenc to own artifact writes, Git checkout state, or release policy.

## Decisions

### 1. Core compares two published Snapshots

The future Core entry point accepts two already-constructed snapshots and explicit options:

```ts
compareSnapshots(
  base: CompilationSnapshot,
  head: CompilationSnapshot,
  options?: SnapshotComparisonOptions,
): Promise<SnapshotDiffV1>;
```

Snapshot construction, document acquisition, and revision labels are host concerns. Comparison must
not mutate either Snapshot and must return a deeply immutable, JSON-serializable result containing
no compiler, `Map`, `Set`, callback, or Backend-private payload.

`SnapshotIdentityV1` records the caller-supplied revision label plus the Snapshot's
`sourceRevision`, `configurationIdentity`, and validity. Labels are presentation identity; semantic
identity comes from the Snapshot fields.

### 2. Facts, suggestions, and policy are separate

Token facts use these v1 kinds:

| Kind                | Meaning                                                                |
| ------------------- | ---------------------------------------------------------------------- |
| `added` / `removed` | Canonical Token ID exists on only one side.                            |
| `direct-value`      | The selected expression or literal changed at the token itself.        |
| `propagated-value`  | The resolved value changed without a direct value edit in that scope.  |
| `type`              | Declared or inferred semantic type changed.                            |
| `metadata`          | DTCG metadata or preserved extension data changed.                     |
| `dependency`        | Dependency target, kind, field path, occurrence, or condition changed. |
| `context-coverage`  | The set of Contexts in which a token/candidate exists or wins changed. |

A token may carry multiple facts. For example, changing an alias target can produce `dependency`
and `direct-value`; a consumer can separately receive `propagated-value`. Facts never contain a
breaking/non-breaking verdict.

`direct-value` compares canonical selected source expressions, while `propagated-value` compares
resolved values only after excluding scopes with a direct expression change. `metadata` covers
`$description`, deprecation data, and preserved non-semantic extensions; recognized Context and
Resolver extensions remain semantic inputs and are classified by their specific categories.

Rename detection is advisory and lives in `renameCandidates`, outside `changes`. A candidate pairs
one removal with one addition. Candidates require equal normalized type and score only exact,
canonical evidence: resolved value across compared coverage (0.45), metadata (0.10), dependencies
after substituting the candidate pair (0.20), type (0.20), and repository-relative document plus
parent-path proximity (0.05). Scores below 0.75 are discarded. A candidate is `unambiguous` only
when it is the unique highest score for both endpoints; every surviving tie is emitted with
`ambiguity: "ambiguous"`. There is no edit-distance or probabilistic matching. Core never silently
converts add/remove facts into a rename.

Backend facts use `symbol` and `artifact-path`. They are derived from successful `prepare()` results
only. Comparison never calls `emit()` and never compares rendered file bytes as semantic identity.

Configuration changes are recorded at report level using base/head configuration identities. If the
semantic effect cannot be covered under trusted configuration, the comparison is incomplete.

### 3. Stable identity and deterministic order

Each change has a `changeId`: SHA-256 base64url of canonical JSON containing schema version, kind,
canonical Token ID, normalized Context predicate, and before/after semantic anchors when present.
Messages, absolute paths, line/column display positions, timings, policy severity, and rename scores
are excluded.

Arrays have a normative order:

1. canonical Token ID;
2. change-kind order from the table above;
3. canonical Context predicate key;
4. before document/offset, then after document/offset;
5. `changeId` as the final tie-breaker.

Impact entries sort by Token ID and predicate key. Backend facts sort by Backend ID, Token ID,
artifact identity, then kind. Rename candidates sort by removed ID, descending evidence score, then
added ID. Diagnostics retain Diagnostic v1 ordering.

JSON object member order is not contractual, but the repository serializer emits a fixed order so
repeated runs are byte-identical.

### 4. Context coverage is explicit and bounded

The comparison request is represented as normalized predicates, not as an implicit Cartesian
product. `coverage.compared` records predicates that were fully examined. `coverage.omitted`
records every uncovered predicate with one of these reasons:

- `limit-exceeded`
- `invalid-base`
- `invalid-head`
- `configuration-unavailable`
- `backend-prepare-failed`
- `unsupported`

`status` is `complete` only when `coverage.omitted` is empty and all required semantic stages
succeeded. Exact single Context comparison may use a fully specified Context. Multi-Context work
must use a lazy iterator and a caller-provided limit. Exhausting the limit is data, not an inferred
"no change" result.

Mutually exclusive predicates never propagate impact into one another. The existing canonical
predicate algebra is the only authority for intersection, union, satisfiability, and ordering.

### 5. Complete impact requires both Graphs

Impact is the condition-aware union of reverse traversals in the base and head Graphs:

```text
base changed roots ──reverse usages in base──┐
                                             ├── predicate union ──> combined impact
head changed roots ──reverse usages in head──┘
```

A head-only walk misses removed dependencies. If base contains `component → semantic → primitive`
and head removes `component → semantic`, changing `semantic` still affected the old component and
must be reported for migration review. A base-only walk symmetrically misses newly introduced
consumers. Therefore changed roots are walked on every side where they exist, then entries are
merged by Token ID while preserving side provenance and canonical predicate union.

`directlyAffected` means one incoming dependency edge from a changed root on either side.
`indirectlyAffected` means two or more edges and excludes changed/direct entries. Directness is
computed per side before union so path deletion cannot collapse an old direct consumer into an
indirect or absent result.

### 6. Invalid snapshots and partial evidence fail closed

An invalid base or head remains queryable for Graph facts available from M1, but resolved-value and
Backend facts are unavailable. The result must:

- set `status: "incomplete"`;
- retain all sound structural/Graph facts that can be established;
- record omitted coverage and the original Diagnostic v1 entries with their side;
- avoid reporting unchanged, policy pass, or a complete rename decision for unavailable evidence.

Expected user errors are structured diagnostics. Invariant violations in comparison code or Backend
contracts remain exceptions and fail the command as an internal error.

### 7. Git and configuration stay outside Core

The CLI/CI revision provider reads Git objects into an isolated virtual document set. Comparing with
`worktree` overlays tracked, modified, deleted, and untracked in-scope files without checkout,
stash, index writes, branch movement, or repository-configuration mutation. Temporary paths never
become document identity or report paths.

Only configuration selected from the current trusted invocation may execute. Historical
JavaScript/TypeScript configuration from base/head is data and is never imported or evaluated
silently. The provider may:

1. use one explicitly trusted current configuration for both sides and report that scope;
2. accept a declarative, schema-validated historical configuration format; or
3. mark comparison incomplete with `configuration-unavailable`.

A configuration identity change is always visible. Opting into execution of historical code, if
ever supported, requires a separate explicit trust flag and process isolation; it is not part of M2.

### 8. Backend comparison stops after preparation

For each configured Backend, both valid snapshots call the existing public `prepare()` boundary.
The diff compares allocated symbol identity and planned artifact identity/path. Any plan diagnostic
is preserved. `emit()` is never called, so change intelligence cannot write files or trigger Backend
rendering side effects.

Opaque naming callbacks make a Backend plan untrusted for cross-revision caching. They may run only
when they are part of the explicitly trusted current configuration. A failed or unavailable plan
marks the relevant Backend coverage incomplete rather than pretending it has no changes.

### 9. Policy consumes facts and cannot rewrite them

Breaking-change policy is a later layer over `SnapshotDiffV1`. It may assign severity, allow a
specific `changeId`, scope rules by Context, and produce findings. It cannot add/remove changes,
alter coverage, reclassify rename candidates, or turn incomplete evidence into a pass.

The default policy contract will be versioned separately. Keeping policy out of Core comparison
allows two organizations to reach different release decisions from byte-identical semantic facts.

### 10. JSON is authoritative; text and SARIF are projections

Snapshot Diff v1 and Impact Report v1 have repository-owned JSON Schemas. Text, JSON, and SARIF
renderers consume one immutable report model and perform no compilation, Graph traversal, Backend
preparation, or policy evaluation.

SARIF maps source-backed diagnostics and policy findings to rules/results. Diagnostic fingerprints
populate `partialFingerprints`; normalized repository-relative documents become artifact URIs;
related locations and valid fixes are preserved. Token changes without a source-backed finding stay
in JSON/text and are not invented as SARIF errors.

Unknown object fields are ignored by tolerant readers. Missing required fields and unknown major
`schemaVersion` values are rejected.

### 11. Exit codes distinguish findings from incompleteness

| Code | Meaning                                                                                                                                  |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Compilation and comparison completed; enabled policy has no failing finding.                                                             |
| `1`  | Comparison completed, but compiler diagnostics or policy findings fail the invocation.                                                   |
| `2`  | Acquisition or comparison is incomplete, including invalid required snapshots, unavailable trusted configuration, or exhausted coverage. |

An internal exception may also exit `2`, with an internal diagnostic on stderr where possible. If
both a policy failure and incomplete coverage occur, `2` wins because a complete verdict is
impossible.

## Draft contracts and fixtures

M2-00 stores non-exported draft schemas under `docs/schemas/drafts/` and examples under
`docs/schemas/examples/`. The fixture authority is
`benchmarks/fixtures/change-intelligence/matrix.v1.json`; it maps every taxonomy item and failure
state to proposed v1 fields. The layered fixture generator and checked-in expectation describe
1,200 Tokens across primitive, semantic, and component layers with two Context dimensions.

These drafts may change during M2-01 without a public compatibility promise. They become public only
after implementation, schema validation, deterministic golden tests, and contract-manifest entry.

## Gate checklist before M2-01

| Gate                  | Resolution                                                                    | Required evidence                                    |
| --------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------- |
| Trusted configuration | Historical executable config is never run implicitly.                         | Untrusted-config fixture yields incomplete coverage. |
| Git worktree overlay  | Object reads plus virtual overlay; no checkout/index/config mutation.         | Temporary-repository state hashes before/after.      |
| Stable identity       | Canonical hash inputs and ordering are fixed above.                           | Repeat-run and inverse-comparison tests.             |
| Rename ambiguity      | Candidates remain advisory; ties are explicit.                                | Unambiguous and ambiguous fixture cases.             |
| Incomplete coverage   | Omitted predicates/reasons are first-class and fail closed.                   | Invalid-side and limit fixtures.                     |
| Exit codes            | `0` pass, `1` findings, `2` incomplete/internal; `2` has precedence.          | CLI matrix tests.                                    |
| SARIF mapping         | Only source-backed findings map; fingerprints and locations remain identical. | Cross-format golden plus SARIF 2.1.0 validation.     |

## Performance baseline

The M2-00 benchmark cases measure current public primitives before a comparison engine exists:

- unchanged two-Snapshot construction;
- a one-file layered edit plus base/head impact union;
- high fan-out impact traversal;
- deterministic report serialization;
- Backend preparation, serialized report bytes, and isolated-process peak RSS.

Fixture creation and filesystem IO remain outside timed regions. Semantic counters and hashes are
gates; cross-machine wall time is advisory until a matched baseline exists.

## Test plan

- Validate that the fixture manifest covers every taxonomy kind, Backend fact, configuration change,
  invalid side, rename ambiguity, and mutually exclusive Context behavior.
- Assert the 1,200-token layered generator's exact token/reference counts and exact direct/transitive
  impact predicates.
- Validate draft examples against the structural requirements of both schemas.
- Record deterministic semantic hashes and finite timing/memory values for all four M2-00 benchmark
  cases.
- In M2-01, add empty, inverse, base-only-edge, head-only-edge, and Context differential tests.
- In M2-03 through M2-05, add repository non-mutation, exit-code, policy, and cross-format parity
  matrices from the Gate checklist.

## Rejected alternatives

- **Diff source JSON directly:** loses resolved values, winning candidates, conditional edges, and
  Backend allocation facts.
- **Traverse only the head Graph:** misses removed consumers and dependencies.
- **Treat a rename as fact:** ambiguity makes this unsafe without user confirmation.
- **Execute each revision's config for fidelity:** historical code is untrusted and can perform
  arbitrary host IO.
- **Let policy annotate or filter the diff in place:** destroys reusable factual identity.
- **Use SARIF as the canonical model:** SARIF is finding-oriented and cannot faithfully represent
  every neutral semantic change or incomplete Context region.
- **Materialize every Context permutation:** violates bounded, lazy evaluation and can grow
  exponentially.
- **Emit Backend output to compare it:** introduces side effects and conflates plan identity with
  renderer formatting.

## Open questions

None for Gate 0. Field spelling may change only by updating this RFC, both draft schemas, examples,
and the fixture matrix together before M2-01 exports a public contract.

## Explicit non-goals

- A production `tokenc diff` or `tokenc impact` command in M2-00.
- Public export of `SnapshotDiffV1` or Impact Report v1 in M2-00.
- Breaking-change policy evaluation, SARIF rendering, or Git acquisition in Core.
- Automatic rename application or source edits.
- Artifact emission during comparison.
- Compatibility with an unpublished draft shape.
