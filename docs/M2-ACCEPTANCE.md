# M2 Acceptance Record

[简体中文](M2-ACCEPTANCE.zh-CN.md)

> Decision: **M2 is complete. The synchronized `0.5.0` packages are published under the `next`
> dist-tag, and all post-publish checks passed.**
>
> Acceptance and publication date: 2026-09-01. The release was produced from
> `93b338024fd6eda892a5b09cde6d03c7b1e1f522` on `main` by
> [Publish Packages run 33521149877](https://github.com/Seeridia/tokenc/actions/runs/33521149877).

## 1. Accepted scope

M2-00 through M2-09 are implementation-complete. The candidate adds immutable Snapshot Diff v1 and
Impact Report v1 facts, read-only Git comparisons, breaking-change policy, shared text/JSON/SARIF
reports, bounded Resolver permutations, a least-privilege CI recipe, and a public-boundary Terrazzo
adapter. M1 compilation, Session, query, diagnostic, and Backend-planning behavior remains green.

## 2. Exit-criterion evidence

| M2 exit criterion                                            | Result | Automated evidence                                                                                                                   |
| ------------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Direct, propagated, and Context-specific impact are distinct | Pass   | Snapshot Diff and impact fixtures cover both Graph sides, mutually exclusive Context regions, and exact direct/indirect sets.        |
| SARIF source locations are GitHub-compatible                 | Pass   | Report tests validate SARIF 2.1.0 structure and cross-format code, fingerprint, URI, region, related-location, and fix parity.       |
| Diff output is versioned and deterministic                   | Pass   | Schema conformance, golden fixtures, repeat-run byte equality, and SHA-256 public-contract locks cover all M2 report schemas.        |
| Medium/large impact traversal is complete                    | Pass   | The 1,200-token layered fixture checks the exact changed/direct/indirect chain; the 2,000-consumer fixture checks complete fan-out.  |
| Adapter failure cannot alter Core semantics                  | Pass   | The Terrazzo example imports only public package boundaries and tests immutable handoff, loader failure, and unsupported extensions. |

The independent M2 differential proof additionally runs one deterministic pair and four seeded
eight-revision sequences across light/dark Contexts. It compares structural and resolved facts,
dual-Graph impact, Backend symbols and artifact paths, policy rule/change identities, deterministic
Report JSON fingerprints, and SARIF-normalized facts and locations. The mismatch count is zero.

## 3. Stable commands and schemas

The supported CI-facing commands are:

```bash
vp exec tokenc check --format json
vp exec tokenc check --format sarif
vp exec tokenc impact tokens/primitive.json --context theme=dark --format json
vp exec tokenc diff --base HEAD~1 --head worktree --format json
vp exec tokenc diff --base HEAD~1 --policy tokenc.policy.json --format sarif
```

`check` and `diff` share Report v1. `impact` emits Impact Report v1. Exit code `0` is success/pass,
`1` is a valid comparison with an unallowed error policy finding, and `2` is invalid or incomplete.
Machine consumers should select a format explicitly and validate `schemaVersion` before other
fields.

The public contract lock covers declarations for all five packages and these package-exported JSON
Schemas:

- Core: Diagnostic v1, Explain Trace v1, Snapshot Diff v1, Impact Report v1, and Breaking-change
  Policy v1.
- CLI: Report v1.

Intentional public changes must update implementation, schema, documentation, Changeset, and
`contracts/m1-public-contracts.json` in one review.

## 4. Policy, CI, and security decisions

Breaking-change Policy v1 is fail-closed. Token removal, type change, Context-coverage loss, Backend
symbol removal, and artifact-path removal default to errors; direct and propagated value changes
default to warnings. Context-scoped rules and stable-`changeId` allow entries are auditable, while
invalid rules, stale allows, compiler errors, and incomplete comparisons never produce a pass.

Git comparison reads revisions without checkout, index, branch, or repository-configuration
mutation. It executes only the explicitly trusted current config and never runs historical config.
The reference GitHub workflow is pinned by commit SHA, grants read-only contents permission, keeps
fork pull requests on the artifact-only path, and does not execute untrusted repository scripts with
write credentials. See [CI integration](CI.md), [release security](RELEASING.md), and
[Terrazzo coexistence](TERRAZZO.md).

## 5. Migration from M1 / `0.4.x`

No compatibility layer is required. Consumers may adopt M2 directly:

1. Keep compilation on `CompilationSnapshot` and `CompilerSession`.
2. Replace ad-hoc comparison logic with `compareSnapshots()` and `buildImpactReport()`.
3. Replace custom breaking checks with `evaluateSnapshotPolicy()` and a Policy v1 document.
4. Replace CI-specific formatting with Report v1 JSON or SARIF.
5. Replace eager Resolver Cartesian products with `planResolverPermutations()` plus the bounded
   compile/compare helpers.
6. Keep Git acquisition and third-party conversion outside Core; pass only immutable public inputs.

Deep imports, historical config execution, implicit unlimited permutations, and parsing human text
in automation are unsupported.

## 6. Release-candidate verification

The retained source gate is:

```bash
vp run verify
```

It includes M1 and M2 semantic-work gates. M2 locks exact work for a 1,200-token one-file diff,
complete impact for 2,000 direct consumers, and a bounded 3×4 Resolver comparison with at most two
parse and two link recomputations after the first permutation. Wall-clock latency remains advisory.
The final source run passed 48 test files, 448 tests, and 12 declaration/schema contract snapshots.

Packaging is verified without publishing:

```bash
vp run publish-packages --dry-run --tag next

release_output="$(mktemp -d)"
vp run verify-release --phase packed --tag next --output "$release_output"
```

The complete candidate must also pass `vp run verify` and packed verification from a committed,
isolated clean worktree, leaving `git status --porcelain --untracked-files=all` empty.

All four local gates passed against the synchronized `0.5.0` package manifests. The package dry-run
and packed consumer smoke used the exact release-version tarballs and the `next` dist-tag without
publishing them.

## 7. Publication closure

The authorized release workflow published the exact five-package manifest and passed every
post-publish gate. Independent registry queries confirmed `0.5.0`, `next: 0.5.0`, and SLSA
provenance v1 for `@tokenc/core`, `@tokenc/cli`, `@tokenc/backend-css`,
`@tokenc/backend-tailwind`, and `@tokenc/backend-typescript`.

The workflow pushed one annotated tag per package. Every tag exists on the remote and peels to the
release commit `93b338024fd6eda892a5b09cde6d03c7b1e1f522`:

- `@tokenc/core@0.5.0`
- `@tokenc/cli@0.5.0`
- `@tokenc/backend-css@0.5.0`
- `@tokenc/backend-tailwind@0.5.0`
- `@tokenc/backend-typescript@0.5.0`

The workflow also revalidated the packed artifacts against npm and left the release worktree clean.
These checks close M2.
