# M1 Release Candidate Acceptance Record

[简体中文](M1-ACCEPTANCE.zh-CN.md)

> Decision: **accepted as the `0.4.0` release candidate; final milestone closure requires an
> authorized publication and post-publish verification.**
>
> Accepted locally on 2026-08-31. Source baseline: the M1 working tree based on `main@07f4490`.
> Release baseline: five synchronized `0.4.0` package candidates for the `next` dist-tag.

## 1. Decision

M1-00 through M1-10 are implementation-complete, and all five official M1 exit criteria have
automated evidence. The public compiler boundary is now the immutable `CompilationSnapshot`,
`CompilerSession`, `CompilationQuery`, `CompilationIR`, and Backend planning contracts. Conditional
queries, versioned diagnostics and traces, exact stage-cache metrics, and differential correctness
checks are part of the release candidate.

This record does not claim that `0.4.0` is published. npm publication, registry-installed consumer
smoke, provenance verification, and remote annotated-tag verification change external state and
must run through the authorized release workflow. M1 is operationally closed only after those
checks pass.

## 2. Exit-criterion evidence

| M1 exit criterion                                    | Result | Automated evidence                                                                                                                                                                                                         |
| ---------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A one-file edit does not reparse unchanged files     | Pass   | Session cache tests assert parse/link reuse and exact invalidation. `vp run bench:gate` retains the 10,012-token point-edit case and permits one parsed document while requiring at least two parse-cache hits.            |
| Incremental output equals full compilation           | Pass   | The full-vs-Session oracle covers a 48-step corpus, four reproducible 32-step seeded property sequences, and Resolver Context/input mutations, comparing diagnostics, conditional edges, values, traces, and output bytes. |
| Concurrent reads from one snapshot are deterministic | Pass   | Snapshot tests run parallel query/resolve/emit reads, retain old snapshots after later builds, and compare 16 concurrent reads of a 1,024-way fan-out graph byte-for-byte.                                                 |
| Backends find every planning error before emit       | Pass   | Core and bundled Backend tests cover capabilities, symbol normalization, unsupported values, artifact paths, cross-Backend collisions, zero-emit failure, and exact plan-to-output conformance.                            |
| Public consumers have no private bypass              | Pass   | CLI/Core parity tests cover diagnostics, Context queries, and traces. The architecture test rejects deep Core imports from the CLI and all bundled Backends and requires CLI compilation through `CompilerSession`.        |

## 3. Release-candidate verification

The retained source gate is:

```bash
vp run verify
```

It runs package-version consistency, formatting, lint, type checking, all package builds, the public
contract lock, the complete test suite, and the deterministic performance gate. The final local run
passed 38 test files and 382 tests. The public contract lock covers declaration output for all five
packages and the Diagnostic v1 and Explain Trace v1 JSON Schemas.

Release packaging was checked without publishing:

```bash
vp run publish-packages --dry-run --tag next
vp run verify-release --phase packed --tag next --output <temporary-directory>
```

Both checks passed for the exact five-package `0.4.0` set. The packed check verified manifests,
internal dependency ranges, tarball contents, package exports, and an isolated consumer smoke using
Core, the CLI, and all three bundled Backends.

The complete candidate source was also committed inside an isolated temporary clone. `vp run verify`
and packed verification passed there, after which `git status --porcelain --untracked-files=all`
remained empty. This proves the clean-checkout gate without committing or modifying the user's
working branch.

The portable performance gate deliberately uses semantic-work counters rather than cross-machine
wall time. The point-edit budget is at most 1 changed Token, 12 affected Tokens, 1 reparsed document,
2 relinked documents, and 12 recomputed resolutions, while requiring at least 2 reused parse entries,
1 reused Link document, and 10,000 reused resolutions. Same-machine wall-time observations remain
advisory and are documented in [M1 performance gates](M1-PERFORMANCE-GATES.md).

## 4. Public stability boundary

Only package-manifest exports are public. Core exports its root API plus the Diagnostic v1 and
Explain Trace v1 schemas. Mutable Graph/Resolver/build state and deep source imports remain internal.
No compatibility facade or deprecated alias is retained for the pre-M1 API.

The SHA-256 declaration and Schema snapshot in `contracts/m1-public-contracts.json` is enforced by
`vp run check:contracts` in CI and release automation. Intentional future changes must update the
implementation, documentation, Changeset, and contract snapshot together. See
[M1 API stability](M1-API-STABILITY.md) for the supported workflow and direct replacements.

## 5. Operational closure still required

The authorized release operator must complete these external steps from the final committed release
source:

1. Publish the five `0.4.0` packages with the intended dist-tag through the protected npm environment.
2. Run `verify-release --phase published` to verify registry integrity, provenance source commit,
   dist-tags, exact package membership, internal ranges, and registry-installed consumer behavior.
3. Create and push the five annotated package tags, then run the local- and remote-tag verification
   phases.
4. Update this record with the release commit, workflow run, registry evidence, and final **closed**
   decision.

No source implementation work remains for M1. Until the external steps above are authorized and
pass, the precise status is “implementation complete; `0.4.0` release candidate accepted,” not
“published milestone closed.”
