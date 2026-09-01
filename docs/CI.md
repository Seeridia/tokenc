# CI Integration

[简体中文](CI.zh-CN.md)

tokenc can run as a read-only validation and change-intelligence layer even when another tool owns
Design Token generation. The reference workflow is
[`.github/workflows/tokenc.yml`](../.github/workflows/tokenc.yml).

## Install and invoke with Vite+

Install the CLI and every backend imported by `tokenc.config.ts` as pinned development dependencies.
Invoke the local binary with `vp exec` so local and CI runs use the same version and stdout contains
only the selected report:

```bash
vp install --frozen-lockfile
vp exec tokenc check --format text
vp exec tokenc diff --base HEAD~1 --head HEAD --config tokenc.config.ts --policy tokenc.policy.json --format json
```

`vp exec` forwards arguments directly; do not insert npm's extra `--` separator. `vp run tokenc`
remains convenient for an interactive package script, but its task header is part of stdout, so use
`vp exec tokenc` when redirecting JSON or SARIF.

## Commands and exit codes

Run `check` before generation and `diff` at a revision boundary:

| Exit | `check`                                          | `diff --policy`                                                       |
| ---- | ------------------------------------------------ | --------------------------------------------------------------------- |
| `0`  | Compilation and every Backend preflight passed.  | Comparison completed with no unallowed error-level finding.           |
| `1`  | Compiler/Backend diagnostics or invalid CLI use. | Complete comparison has an unallowed policy finding or invalid usage. |
| `2`  | Not used for ordinary compilation diagnostics.   | Acquisition, policy, Snapshot, configuration, or coverage incomplete. |

Exit `2` takes precedence over policy failure because CI does not have enough evidence for a verdict.
`check` and `diff` are read-only: they validate Backend plans but never emit configured artifacts.

## Choose a stable baseline

- Pull requests: use the immutable `github.event.pull_request.base.sha` supplied by GitHub.
- Branch pushes: use the previous successfully checked commit or an immutable release tag.
- Local review: use `HEAD~1`, a merge base, or the exact commit used by CI.

Do not use a moving branch name when report reproduction matters. `tokenc diff` reads both Git
objects directly and never checks out either side.

The baseline object must exist locally. For GitHub Actions, configure `actions/checkout` with
`fetch-depth: 0`. Other CI systems should fetch the exact baseline SHA before running tokenc. A
missing revision is an incomplete comparison and exits `2`; do not convert it into a pass.

Historical executable configuration is never evaluated implicitly. Passing
`--config tokenc.config.ts` explicitly selects the current reviewed configuration for both sides.
Without that flag, the configuration must be byte-identical in both revisions or the comparison is
incomplete.

## Reports and retention

Generate every format with identical semantic arguments:

```bash
mkdir -p artifacts/tokenc
vp exec tokenc diff --base "$TOKENC_BASE" --head HEAD --config tokenc.config.ts --policy tokenc.policy.json --format text > artifacts/tokenc/report.txt
vp exec tokenc diff --base "$TOKENC_BASE" --head HEAD --config tokenc.config.ts --policy tokenc.policy.json --format json > artifacts/tokenc/report.json
vp exec tokenc diff --base "$TOKENC_BASE" --head HEAD --config tokenc.config.ts --policy tokenc.policy.json --format sarif > artifacts/tokenc/report.sarif
```

All formats project the same immutable Report v1 entries. JSON
`diagnostics[].diagnostic.fingerprint`, text fingerprints, and SARIF
`partialFingerprints["tokenc/v1"]` therefore remain identical. Preserve the text and JSON reports
with the SARIF file so a failed job remains auditable; the reference workflow retains them for 14
days.

## Fork pull requests and permissions

Use `pull_request`, never `pull_request_target`, for untrusted changes. The reference job requires no
npm credentials or repository secrets and starts with `contents: read`. GitHub downgrades the token
for fork pull requests; those runs still compile, compare, and upload the downloadable report
artifact. SARIF upload is skipped for forks because code scanning requires `security-events: write`.
Same-repository pull requests and manual runs upload the same SARIF file to code scanning.

Every referenced action is pinned to a full commit SHA. Update a pin only after reviewing the action
release and resolving the corresponding major tag to its commit.

## Coexist with an existing generator

Keep generation ownership unchanged. Run the existing generator in its own step, then run tokenc as
a separate checking layer:

```bash
vp run generate-tokens
vp exec tokenc check --format text
vp exec tokenc diff --base "$TOKENC_BASE" --head HEAD --config tokenc.config.ts --policy tokenc.policy.json --format json
```

Point `tokenc.config.ts` at canonical DTCG inputs, not generated CSS or TypeScript. `check` validates
types, references, Contexts, symbols, and output paths without writing them; `diff` reports semantic
source changes independently of whether another tool generates the production artifacts.

The executable fixture under
[`packages/cli/test/fixtures/ci-repository`](../packages/cli/test/fixtures/ci-repository) covers pass,
breaking-policy failure, compiler failure, and incomplete comparison. Its test also proves exit-code
and fingerprint parity across text, JSON, and SARIF.
