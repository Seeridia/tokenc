# M0 Milestone Acceptance Record

[简体中文](M0-ACCEPTANCE.zh-CN.md)

> Decision: **accepted, with release-governance follow-ups required before the next release.**
>
> Accepted on 2026-08-25. Code baseline: `main@3c66235`. Release baseline: `0.3.0` at
> `2939441`.

## 1. Decision

All five exit criteria for M0, “Trustworthy baseline,” are satisfied. Known name collisions,
conditional cycles, backend representation failures, output-path collisions, and release-version
mistakes now produce tested output or structured failures instead of silent corruption. All five
public packages are published and have passed an independent consumer smoke test.

This acceptance does not claim that release governance is finished. The P0 items in section 4 do not
invalidate the `0.3.0` artifacts, but they must be completed before the next public release.

## 2. Exit-criterion evidence

| M0 exit criterion                                                                    | Result | Evidence                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Collision and conditional-cycle fixtures pass                                        | Pass   | Core covers mutually exclusive selectors, specificity, base/override behavior, a real multidimensional cycle, and the 16,384-projection limit. CSS, Tailwind, TypeScript, and CLI cover symbol and output-path collisions. |
| Backends do not silently emit composite JSON                                         | Pass   | CSS and Tailwind serialize supported composites as platform values. Gradients and shapes that cannot be represented losslessly return `BACKEND_UNSUPPORTED_VALUE` before emit and produce no partial artifacts.            |
| Check, build, and test pass on a clean checkout and leave it clean                   | Pass   | GitHub Actions run [`32798153105`](https://github.com/Seeridia/tokenc/actions/runs/32798153105) passed on Node.js 22.13 and 24. All 21 test files and 272 tests passed, and CI includes a post-build clean-worktree gate.  |
| Support documentation matches behavior and unsupported cases have stable diagnostics | Pass   | `DTCG-SUPPORT` and the pinned `dtcg-examples@1.1.3` regression suite record token counts, diagnostic codes and counts, and unsupported/extension/gap categories for seven ecosystem projects.                              |
| A release ships the fixes with migration notes                                       | Pass   | npm `latest` is `0.3.0` for all five public packages with OIDC provenance. Five annotated tags peel to `2939441`, and each package changelog records the behavior and migration impact.                                    |

## 3. Published-artifact verification

The acceptance check installed all five `0.3.0` packages from npm into an empty temporary directory
instead of reusing the monorepo workspace:

- `@tokenc/core`
- `@tokenc/cli`
- `@tokenc/backend-css`
- `@tokenc/backend-tailwind`
- `@tokenc/backend-typescript`

The smoke test compiled a DTCG dimension token with the published Core and ran the published CSS,
Tailwind, and TypeScript backends, producing `dist/tokens.css`, `dist/tailwind.css`, and
`dist/tokens.ts`. The published CLI also started successfully with `--help`.

The consumer smoke invocation was an independent acceptance check and its temporary directory was
not retained in the repository. M1-00 therefore owns converting it into a repository script that
runs against both packed tarballs before publication and registry-installed packages afterward;
both paths become mandatory release evidence rather than an ad hoc operator check.

Source verification and the synthetic benchmark can be rerun from the accepted commit with:

```bash
pnpm install --frozen-lockfile
pnpm verify
pnpm bench
```

The linked CI run is the retained source-verification record. Registry provenance, tarball digest,
tag, and consumer-smoke observations were one-time acceptance checks; M1-00 must replace that gap
with one repository-owned `verify-release` command used locally and by the publish workflow.

One local observation of the synthetic benchmark is recorded below only as an M1 measurement
starting point, not as a performance claim:

```text
Node.js 24.19.0, Apple M4 Pro, main@3c66235
cold compile: 1,000 independent tokens       26.02 ms
cold compile: 10,000 independent tokens     368.84 ms
cold compile: 10,000-token alias chain      412.67 ms
cold compile: 2,000-way fan-out              30.65 ms
cold compile: 1,000 themed tokens            25.63 ms
incremental: 1 primitive + 11 dependents    172.71 ms
```

The incremental case patches one graph node and affects and recomputes only 12 tokens, but still
takes about 173 ms. M1 therefore must measure and reduce full relinking, signature comparison, and
other fixed costs instead of reporting affected-token counts alone.

## 4. Residual risks and required treatment

### Required before the next release

1. **Idempotent release verification.** `publish-packages.mjs` currently skips a version that already
   exists on npm. A retry must verify registry artifact identity, provenance, and the requested
   dist-tag. Re-running a version first published under `beta` with `latest` must fail closed with an
   explicit manual-promotion instruction until a separately reviewed authentication path can update
   the dist-tag safely.
2. **Release-source controls.** `publish.yml` must reject refs other than `refs/heads/main` inside the
   job. The GitHub `npm` environment needs a protected-branch deployment policy and should require a
   human reviewer.

### Complete during M1

1. Add post-publish verification for all five expected package versions, dist-tags, provenance
   commits, and remote tags. PR #22 pushes each tag on the release commit explicitly and fails when
   no tag exists, but the complete path still needs validation during the next real release.
2. Pin every release workflow action that still uses a floating version to a full commit SHA.
3. Decide whether each fixed-group release should receive one GitHub Release. This is not required
   for npm correctness.

## 5. Handoff

M0 is closed as complete from 2026-08-25. Semantic and API work moves to the
[M1 execution plan](M1-PLAN.md), whose only product line is a public, queryable compiler interface
with differential proof of incremental correctness. New backends, LSP, SARIF, and a Terrazzo adapter
remain outside M1.
