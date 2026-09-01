# M2 Execution Plan: CI and Change Intelligence

[简体中文](M2-PLAN.zh-CN.md)

> Status: complete. M2-00 through M2-09 are accepted, the synchronized `0.5.0` packages are
> published under the `next` dist-tag, and post-publish verification has closed the milestone.
> Updated 2026-09-01.
>
> Entry baseline: M1 implementation and the local `0.4.0` release candidate are complete according
> to the [M1 acceptance record](M1-ACCEPTANCE.md). M2 design and fixtures may proceed immediately;
> public M2 API release work waits for the authorized `0.4.0` publication and post-publish checks.
>
> Intended release line: `0.5.0`. The exact release tag is selected only at the release gate.

## 1. Outcome

M2 turns the M1 semantic compiler into a change-intelligence layer that can protect an existing
Design Token pipeline in local development and CI. It must answer four questions with stable,
machine-readable evidence:

1. What changed semantically between two project states?
2. Which Tokens, Context regions, Backend symbols, and artifacts are affected?
3. Which changes violate an explicit compatibility policy?
4. How can CI publish those findings as deterministic JSON, readable text, or SARIF?

The first implementation target is a pure comparison of two immutable snapshots. Git revisions,
CLI rendering, policy, SARIF, Resolver permutations, and interoperability are consumers of that
fact model rather than alternate comparison engines.

## 2. Decisions fixed for M2

These decisions prevent the milestone from splitting into incompatible diff implementations:

1. **Core compares snapshots; Core does not run Git.** `@tokenc/core` receives two immutable
   snapshots and explicit comparison scopes. Repository discovery, revisions, temporary files,
   terminal output, and process exit codes belong to the CLI.
2. **Semantic diff and policy are separate.** The diff records facts without deciding severity.
   A policy evaluator converts those facts into versioned diagnostics and a pass/fail decision.
3. **JSON is the canonical report.** Text and SARIF are deterministic projections of the same
   report model. No renderer independently rediscovers changes.
4. **Context coverage is explicit.** M2 never claims equivalence over Contexts or Resolver inputs it
   did not compare. Unscoped structural changes retain predicates; resolved comparisons list their
   exact Context/permutation coverage.
5. **Impact uses both revisions.** Removed dependencies are discoverable only from the base Graph,
   while added dependencies exist only in the head Graph. Propagated impact is the condition-aware
   union of both traversals, not a head-only approximation.
6. **Rename detection is advisory.** A removed and added Token may become a rename candidate only
   through deterministic semantic signatures. Ambiguous matches remain separate add/remove facts.
7. **Historical configuration is not executed automatically.** `tokenc diff` loads one explicitly
   trusted analysis config and applies it to both source revisions. A changed config file marks the
   comparison incomplete and fails policy evaluation unless the caller explicitly supplies a common
   trusted config. This avoids executing arbitrary code from a compared Git ref.
8. **Permutation enumeration is lazy and bounded.** The default compares only the effective Context.
   Full Resolver enumeration requires an explicit limit and exposes estimated, visited, filtered,
   and truncated counts.
9. **No new public package in M2.** Pure comparison and permutation contracts live in Core; Git,
   policy orchestration, reporters, and commands live in the CLI. A future `@tokenc/ci` split waits
   until the M2 contract has shipped and demonstrated an independent consumer need.
10. **No compatibility facade is required.** The project remains in `0.x`; intentional CLI or
    TypeScript breaks are direct replacements with a Changeset and migration note. Published v1
    JSON payloads are not silently changed: incompatible machine-output changes receive a new
    schema version.

## 3. Existing M1 authority map

| Current boundary                  | Authoritative M1 responsibility                                      | M2 use                                                               |
| --------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `packages/core/src/snapshot.ts`   | Immutable revision, documents, diagnostics, Query, IR, Backend entry | Base/head comparison inputs; no mutable comparison state             |
| `packages/core/src/query.ts`      | Conditional edges, resolve, explain, usages, impact                  | Structural facts and Context-aware traversal                         |
| `packages/core/src/backend.ts`    | Capabilities, symbols, artifact plans, preflight                     | Compare symbols and artifacts through `prepare()`, never reimplement |
| `packages/core/src/diagnostic.ts` | Diagnostic registry, fingerprints, fixes, serialization              | Policy findings and SARIF identity source                            |
| `packages/core/src/session.ts`    | Atomic updates, loader boundary, cache ownership                     | Reuse compilation work across revisions and permutations             |
| `packages/core/src/loader.ts`     | Host-provided document acquisition                                   | Git/worktree adapters remain outside Core                            |
| `packages/cli/src/index.ts`       | Config loading, filesystem writes, commands, rendering, exit codes   | Own Git acquisition, policy orchestration, and report selection      |
| `benchmarks/` and `contracts/`    | Reproducible evidence and public surface hashes                      | Extend rather than create parallel M2 gates                          |

M2 must consume these authorities. It must not add another parser, Graph traversal, value resolver,
Backend naming pass, diagnostic fingerprint implementation, or release verifier.

## 4. Public contract target

M2 introduces one comparison fact model rather than exposing internal Graph or Resolver objects:

```ts
interface SnapshotDiffV1 {
  readonly schemaVersion: "1";
  readonly status: "complete" | "incomplete";
  readonly base: SnapshotIdentityV1;
  readonly head: SnapshotIdentityV1;
  readonly coverage: ComparisonCoverageV1;
  readonly changes: readonly TokenChangeV1[];
  readonly impact: ImpactQueryV1;
  readonly backends: readonly BackendChangeV1[];
  readonly diagnostics: readonly DiagnosticV1[];
}

compareSnapshots(
  base: CompilationSnapshot,
  head: CompilationSnapshot,
  options?: SnapshotComparisonOptions,
): Promise<SnapshotDiffV1>;
```

The accepted RFC may refine names, but not these invariants:

- The result is deeply immutable, JSON-serializable, deterministically ordered, and contains no
  mutable `Map`/`Set` or internal compiler instance.
- Invalid snapshots produce `status: "incomplete"` with their diagnostics; they never produce a
  false “no changes” result.
- Every change has stable identity, before/after source anchors where available, and exact Context
  coverage.
- Direct value changes and changes propagated only through dependencies are distinct.
- Structural categories include add, remove, type, metadata, dependency, Context coverage, and
  advisory rename candidates.
- Backend comparison calls `prepare()` only. It compares allocated symbols and planned artifact
  identities/paths without emitting files.
- `SnapshotDiffV1` and the CLI impact JSON envelope ship as explicit JSON Schema subpath exports and
  join the public-contract hash gate.

## 5. Command contract

The intended CLI surface is:

```bash
tokenc impact tokens/brand.json --context theme=dark --format json
tokenc diff --base main --head worktree --format text
tokenc diff --base origin/main --head HEAD --format json
tokenc diff --base main --head worktree --policy tokenc.policy.json --format sarif
tokenc check --format sarif
```

Rules:

- `--head` defaults to `worktree`; `--base` is required for `diff`.
- Repeatable `--context name=value` is the canonical Context syntax for M2 commands.
- `--format text|json|sarif` is the shared report switch. Command-specific legacy switches are
  replaced directly where they conflict with this grammar.
- Core never shells out. The CLI Git provider uses repository object reads and does not checkout or
  mutate the user's branch.
- Source revision acquisition and semantic comparison are distinct phases with separate diagnostics.
- Exit `0` means compilation and policy pass, `1` means compiler/policy findings, and `2` means the
  comparison could not be completed. The RFC must lock the exact mapping before implementation.

## 6. Scope

M2 includes:

- Snapshot Diff v1 and Impact Report v1 contracts plus JSON Schemas.
- Context-aware structural, resolved-value, dependency, impact, Backend symbol, and artifact diff.
- `tokenc impact`, `tokenc diff`, and SARIF output for `check` and `diff`.
- A deterministic breaking-change policy with documented defaults and overrides.
- Lazy Resolver permutation planning, filtering, bounded enumeration, and comparison.
- Git revision/worktree source providers in the CLI without branch mutation.
- GitHub Actions and vendor-neutral CI examples.
- A Terrazzo coexistence guide and a non-published experimental adapter example that accepts
  already-bundled standard DTCG.

M2 excludes:

- A language server, editor extension, rename operation, or code-action transport; those belong to
  M3.
- A persistent build cache, general Importer SDK, new production Backend, or transform pipeline.
- Network access, Git operations, SARIF rendering, or policy decisions inside Core.
- Executing configuration code directly from an untrusted base/head revision.
- Guessing complete Context coverage after a comparison limit is reached.
- Reproducing Terrazzo transforms or arbitrary third-party plugin side effects.

## 7. Delivery sequence

### Gate 0: contract and evidence before CLI surface

#### M2-00 — Change-intelligence RFC and fixture baseline (P0, complete)

Accepted evidence: [RFC 0004](rfcs/0004-change-intelligence.md), the
[`change-intelligence` fixture matrix](../benchmarks/fixtures/change-intelligence/matrix.v1.json),
the non-public [draft schemas](schemas/drafts/), and the
[M2-00 benchmark baseline](M2-00-BASELINE.md).

Deliver:

- Add one focused RFC covering the snapshot comparison model, change taxonomy, identity and
  ordering, two-revision impact, incomplete results, trusted-config boundary, policy separation,
  report formats, exit codes, and rejected alternatives.
- Add a checked-in before/after fixture matrix for add/remove, unambiguous and ambiguous rename,
  direct/propagated value change, type/metadata/dependency change, mutually exclusive Contexts,
  invalid base/head, Backend symbol/path change, and changed configuration.
- Add one realistic layered fixture with primitives, semantic aliases, components, multiple
  Context dimensions, and at least 1,000 Tokens. Record exact expected direct and transitive impact.
- Record a pre-M2 baseline for current snapshot construction, impact traversal, Backend preparation,
  report size, and peak memory. Wall time remains advisory until matched-environment evidence exists.

Acceptance:

- Every roadmap change category maps to an expected fixture and a proposed v1 field.
- The RFC proves why old-plus-new Graph traversal is required for complete impact.
- The RFC fixes security behavior for config changes and never executes historical config silently.
- Fixture expectations are reviewable data, not snapshots generated and accepted in the same run.
- No production command or public type is added before Gate 0 is accepted.

#### M2-01 — Snapshot Diff v1 core vertical slice (P0, complete)

Accepted evidence: the public [`compareSnapshots()` implementation](../packages/core/src/snapshot-diff.ts),
the exported [`snapshot-diff-v1.schema.json`](../packages/core/schema/snapshot-diff-v1.schema.json),
and focused [differential tests](../packages/core/test/snapshot-diff.test.ts). The implementation uses
only immutable Snapshot, Query, Predicate, and Backend preparation boundaries.

Deliver:

- Implement `compareSnapshots()` for two in-memory snapshots and one explicit Context.
- Classify add/remove, direct value, propagated value, type, metadata, dependency, and Context
  coverage changes.
- Traverse both base and head conditional Graphs to produce complete direct and indirect impact.
- Return incomplete results for invalid snapshots or uncovered comparison regions.
- Add deterministic JSON serialization and `snapshot-diff-v1.schema.json`.

Acceptance:

- Reversing base/head produces the expected inverse facts where an inverse exists.
- Identical snapshots produce a byte-stable empty diff.
- Mutually exclusive predicates do not create propagated false positives.
- Removing a dependency still reports dependents reachable only in the base Graph.
- Schema conformance and public declaration snapshots pass.

### Wave 1: user-facing change facts

#### M2-02 — Source-to-Token impact command (P0, complete)

Accepted evidence: the public [`buildImpactReport()` implementation](../packages/core/src/impact-report.ts),
exported [`impact-report-v1.schema.json`](../packages/core/schema/impact-report-v1.schema.json), the
no-Git `tokenc impact` command, and focused [Core](../packages/core/test/impact-report.test.ts) plus
[CLI](../packages/cli/test/cli.test.ts) tests. Snapshot documents now retain their owned canonical
Token IDs, including Tokens materialized by inheritance.

Deliver:

- Map changed document paths to Token IDs using Snapshot source facts, including removed Tokens from
  an optional base snapshot.
- Add `tokenc impact <path...>` with text and versioned JSON output.
- Support repeatable Context filters and retain Predicate regions when no Context is supplied.
- Distinguish directly changed, directly affected, and transitively affected Tokens.

Acceptance:

- Alias, JSON Pointer component, inheritance, and Context override changes all produce complete
  impact.
- Unknown paths and paths containing no Tokens are explicit, deterministic results.
- CLI output equals the public Core result after normalization.

#### M2-03 — Git revision provider and `tokenc diff` vertical slice (P0, complete)

Accepted evidence: the CLI-owned
[`GitRevisionProvider`](../packages/cli/src/git-revision-provider.ts), `tokenc diff` over the public
`compareSnapshots()` boundary, and [temporary-repository integration tests](../packages/cli/test/git-diff.test.ts).
The tests retain exact branch, HEAD, index, worktree, staged, unstaged, untracked, renamed, added,
and deleted state; cover missing/shallow revisions, deleted Resolver sources, invalid Snapshots, and
configuration trust; and prove checkout-path-independent JSON.

Deliver:

- Add a CLI-owned read-only provider for a Git ref and the current worktree.
- Compile base and head with one trusted analysis config without checking out either revision.
- Add `tokenc diff --base <ref> [--head <ref|worktree>]` with text and JSON output.
- Detect config-file changes and return an incomplete comparison diagnostic unless a common trusted
  config was explicitly selected.
- Preserve committed, staged, unstaged, added, and deleted worktree files in the head view.

Acceptance:

- Integration tests use temporary Git repositories and prove the user's branch, index, and files are
  unchanged.
- Missing refs, shallow history, renamed files, deleted Resolver sources, and invalid snapshots fail
  deterministically.
- The same two source trees produce byte-identical JSON regardless of checkout path.

#### M2-04 — Breaking-change policy (P0, complete)

Implemented by [`breaking-policy.ts`](../packages/core/src/breaking-policy.ts), the published
[`breaking-policy-v1.schema.json`](../packages/core/schema/breaking-policy-v1.schema.json), and
`tokenc diff --policy <path>`. The evaluator preserves the exact input diff, retains allowed
findings for audit, and gives invalid/incomplete decisions exit-code precedence over policy failure.
M2-05 will project this shared evaluation model to SARIF.

Deliver:

- Define a small versioned policy schema with rule severity, allow entries, and Context scope.
- Ship documented defaults for Token removal, type change, lost Context coverage, Backend symbol/path
  removal, direct value change, and propagated value change.
- Evaluate policy only from `SnapshotDiffV1`; do not recompute semantic differences in the policy
  layer.
- Produce stable Diagnostic v1 findings and deterministic process exit behavior.

Acceptance:

- Policy configuration changes severity but never changes the underlying diff.
- Allow entries require stable change identity and cannot suppress compiler errors.
- Unknown rules, stale allow entries, and incomplete comparisons fail closed.
- Text, JSON, and SARIF report the same finding identities and severities.

### Wave 2: complete reporting and Context coverage

#### M2-05 — Shared text, JSON, and SARIF reporters (P0, complete)

Implemented by the immutable [`ReportV1`](../packages/cli/src/report.ts) projection and the public
[`report-v1.schema.json`](../packages/cli/schema/report-v1.schema.json). `check` and `diff` now render
text, JSON, or SARIF 2.1.0 from the same normalized entries. SARIF preserves rule metadata,
locations, related locations, validated fixes, policy suppressions, and Diagnostic fingerprints;
paths are repository-relative and external temporary prefixes are redacted.

Deliver:

- Introduce one immutable report model consumed by all renderers.
- Add `--format text|json|sarif` to `check` and `diff`; keep `impact` text/JSON unless it has
  source-located policy findings.
- Emit SARIF 2.1.0 with rule metadata, artifact URIs, regions, related locations, fixes when valid,
  and Diagnostic fingerprints in `partialFingerprints`.
- Normalize paths relative to an explicit repository root and redact temporary materialization paths.

Acceptance:

- JSON conforms to repository-owned schemas and is byte-identical across repeated runs.
- SARIF passes an independent SARIF 2.1.0 validator and golden tests.
- Every source-backed Diagnostic maps to the same file, line, column, severity, rule, and fingerprint
  in text, JSON, and SARIF.
- Rendering performs no compilation, Graph traversal, or policy evaluation.

#### M2-06 — Lazy Resolver permutation planning and comparison (P0, complete)

Implemented by the immutable, iterable
[`ResolverPermutationPlanV1`](../packages/core/src/permutation.ts) and the public
`planResolverPermutations()`, `compileResolverPermutations()`, and
`compareResolverPermutations()` APIs. Planning validates exact filters and explicit limits before
enumeration. Execution serializes each side through a persistent `CompilerSession`, compares through
Snapshot Diff v1, and preflights every Backend artifact path across the batch before optional emit.

Deliver:

- Add a public immutable permutation plan with dimensions, estimated count, validation diagnostics,
  and a lazy bounded iterator.
- Support exact Context filters and a mandatory limit for multi-permutation enumeration.
- Compile permutations through one `CompilerSession` so unchanged parse/link work is reused; Graph
  and resolve caches are reused only when their Context facts remain valid and otherwise report
  explicit `context-changed` invalidation.
- Compare selected base/head permutations through the same `compareSnapshots()` API.
- Preflight all selected Backend plans and artifact paths before any optional batch emission.

Acceptance:

- Planning does not materialize the Cartesian product.
- Invalid inputs, unknown filters, limit exhaustion, and output collisions are explicit diagnostics.
- Enumerated results equal independent cold compilations for every visited permutation.
- Cache counters prove unchanged source/link work is reused; ordering is stable across runs.

### Wave 3: CI adoption and interoperability

#### M2-07 — CI recipes and GitHub Actions reference workflow (P0, complete)

Implemented by the bilingual [`CI.md`](CI.md) guide, the commit-pinned
[`tokenc.yml`](../.github/workflows/tokenc.yml) reference workflow, and an executable
[`ci-repository`](../packages/cli/test/fixtures/ci-repository) Git fixture. The workflow retains text,
JSON, and SARIF for 14 days, uploads SARIF only when code-scanning write permission is available,
and continues to produce downloadable reports for read-only fork pull requests.

Deliver:

- Document generic CI commands, exit codes, artifact retention, baseline selection, and shallow-clone
  requirements.
- Add a pinned-action GitHub Actions example that generates JSON and SARIF, uploads SARIF, and retains
  the human-readable report.
- Cover fork pull requests without requiring write tokens or npm credentials.
- Document how to run tokenc as a checking layer while another tool still owns generation.

Acceptance:

- A fixture repository exercises pass, breaking failure, compiler failure, and incomplete comparison.
- The example uses least-privilege permissions and no unpinned release-path actions.
- Local and CI commands produce the same report fingerprints.

#### M2-08 — Terrazzo coexistence guide and experimental adapter (P1, complete)

Implemented by the bilingual [`TERRAZZO.md`](TERRAZZO.md) guide and the private
[`terrazzo-adapter`](../examples/terrazzo-adapter) workspace. The adapter accepts one already-bundled
standard DTCG JSON document through an in-memory public `DocumentLoader`, compiles it through a fresh
public `CompilerSession`, and classifies extension namespaces without importing Terrazzo or
reimplementing its transforms.

Deliver:

- Add a guide for using tokenc check/diff/impact beside an existing Terrazzo generation pipeline.
- Add a non-published example adapter that accepts already-bundled standard DTCG and feeds it through
  the public `DocumentLoader`/Session boundary.
- Classify unsupported extension data without importing or emulating Terrazzo transforms.

Acceptance:

- Adapter failure cannot mutate a snapshot or alter Core semantics.
- The adapter has no Core deep imports and performs no network request inside Core.
- The guide states exactly which Terrazzo behavior is and is not represented.

#### M2-09 — Differential proof, performance gates, and `0.5.0` release candidate (P0, complete)

Deliver:

- Add differential comparison of the M2 engine against an independently normalized reference model
  across deterministic and seeded change sequences.
- Add stable semantic-work budgets for one-file diff, high-fan-out impact, and bounded permutation
  comparison; keep cross-machine latency advisory.
- Lock declarations and M2 JSON Schemas in the public-contract manifest.
- Publish final bilingual command, schema, policy, CI, security, and migration documentation.
- Add a Changeset and run package dry-run, packed consumer smoke, and an isolated clean-worktree gate.

Acceptance:

- Every M2 exit criterion below has automated evidence and zero unexplained M1 regression.
- Differential mismatches are zero for structural facts, resolved scopes, impact, Backend plans,
  policy findings, JSON, and SARIF-normalized locations.
- Public declarations and machine schemas change only through an intentional contract update.
- The release candidate passes `vp run verify`, package dry-run, packed smoke, and clean-worktree
  verification.
- After an authorized publication, registry-installed smoke, provenance, dist-tag, and annotated-tag
  verification must pass before M2 is marked closed.

## 8. Dependencies and critical path

```text
M1 publication ────────────────────────────────────────────────────────┐
                                                                       ▼
M2-00 RFC/baseline → M2-01 Snapshot Diff → M2-03 Git diff → M2-04 policy
                              │                │               │
                              └→ M2-02 impact ─┘               ▼
                                                       M2-05 reporters
                                                              │
M2-01 Snapshot Diff → M2-06 permutations ─────────────────────┤
                                                              ▼
                                                       M2-07 CI recipes
                                                              │
                                                       M2-08 coexistence
                                                              │
                                                              ▼
                                                       M2-09 release gate
```

- M2-00 starts now; M1 publication may proceed in parallel but gates public M2 release work.
- M2-02 may proceed after M2-01 while M2-03 builds the Git provider.
- M2-04 depends on stable diff identities; M2-05 depends on both diff and policy facts.
- M2-06 reuses M2-01 and may proceed alongside policy/reporting after the core vertical slice.
- M2-07 and M2-08 consume stable commands and do not define alternative semantic behavior.

## 9. Recommended implementation slices

| Order | Slice                    | Primary output                                               | Merge gate                                     |
| ----- | ------------------------ | ------------------------------------------------------------ | ---------------------------------------------- |
| 1     | Contract and fixtures    | RFC, taxonomy, fixture matrix, baseline                      | every roadmap category has explicit evidence   |
| 2     | Core diff vertical slice | `SnapshotDiffV1`, one Context, JSON Schema                   | inverse/empty/context differential tests       |
| 3     | Impact CLI               | source-to-Token mapping, text/JSON                           | Core/CLI parity and full edge-kind coverage    |
| 4     | Git diff CLI             | base/head provider, worktree overlay                         | temporary-repository non-mutation tests        |
| 5     | Policy                   | defaults, overrides, stable findings                         | fail-closed policy matrix                      |
| 6     | Reporters                | shared report IR, text/JSON/SARIF                            | schema, SARIF, and cross-format identity tests |
| 7     | Permutations             | lazy plan, filters, bounded comparison                       | cold-build differential and allocation bound   |
| 8     | CI adoption              | generic guide and GitHub reference workflow                  | least-privilege end-to-end fixture             |
| 9     | Terrazzo coexistence     | guide and public-boundary adapter example                    | isolation and unsupported-behavior tests       |
| 10    | Release gate             | contracts, performance budgets, Changeset, packed validation | all M2 exit criteria pass                      |

Each slice must include implementation, tests, English and Chinese documentation, and a Changeset
when public behavior changes. A slice may introduce at most one new public contract layer.

## 10. M2 acceptance matrix

| Official exit criterion                                             | Required automated evidence                                                                                  |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Reports distinguish direct, propagated, and Context-specific impact | Old/new Graph differential fixtures, mutually exclusive Context tests, and exact source/Predicate assertions |
| SARIF points to accurate source locations in GitHub-compatible form | SARIF 2.1.0 validation plus text/JSON/SARIF identity and location parity                                     |
| Diff output is versioned and deterministic                          | JSON Schema conformance, golden fixtures, repeat-run byte equality, and public-contract hashes               |
| A realistic medium/large fixture has complete impact traversal      | Checked-in expected changed/direct/indirect sets and full traversal comparison                               |
| Adapter failures cannot change Core semantics                       | Public-import boundary, immutable Snapshot, loader failure, and unsupported-extension tests                  |

Additional release-candidate gates:

- Git comparison never mutates the checkout, index, branch, or repository configuration.
- Invalid or incomplete comparison never reports a policy pass.
- Resolver enumeration is lazy, bounded, deterministic, and cold-build equivalent.
- All report formats carry the same finding identities and policy verdict.
- M1 tests, public contracts, packed consumer smoke, and performance budgets remain green.

## 11. Immediate next step

M2 is closed. Preserve the published `0.5.0` contract and use the registry, provenance, dist-tag,
and annotated-tag evidence recorded in the [M2 acceptance record](M2-ACCEPTANCE.md) as the baseline
for the next roadmap milestone.
