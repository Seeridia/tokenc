# @tokenc/cli

Command-line interface for the tokenc Design Token compiler.

The CLI compiles DTCG 2025.10 token documents; it does not enable proprietary token syntax.

Install the CLI and the backends referenced by your `tokenc.config.ts` as local development dependencies:

```bash
vp add -D \
  @tokenc/cli \
  @tokenc/core \
  @tokenc/backend-css \
  @tokenc/backend-tailwind \
  @tokenc/backend-typescript
```

```bash
vp exec tokenc build
vp exec tokenc check
vp exec tokenc dev
vp exec tokenc explain button.primary.background
vp exec tokenc usages color.blue.600
vp exec tokenc graph --format mermaid
vp exec tokenc impact tokens/primitive.json --format json
vp exec tokenc diff --base HEAD~1 --format json
vp exec tokenc diff --base HEAD~1 --policy tokenc.policy.json
vp exec tokenc diff --base HEAD~1 --policy tokenc.policy.json --format sarif
vp exec tokenc check --format sarif
```

`explain`, `usages`, `graph`, and `impact` use public Core APIs. Pass `--json` to query commands or
`--format json` to `impact` for deterministic versioned output. Repeat `--context name=value` on
`impact` to select a Context region; without it the report retains exact Predicate regions.

`tokenc diff --base <ref> [--head <ref|worktree>]` reads Git objects into immutable virtual source
views and never checks out a revision or writes the index. Only the current configuration is
executed. A changed default config makes the comparison incomplete; explicitly passing `--config`
selects that current file as the common trusted analysis config. Exit code `2` represents missing
revisions, incomplete acquisition/coverage, invalid Snapshots, and internal comparison failures.

Pass `--policy <json>` to evaluate Breaking-change Policy v1. Exit code `0` means pass, `1` means an
unallowed error-severity finding, and `2` means the decision is incomplete because the comparison or
policy is invalid. Findings retain their stable identity when allowed.

```json
{
  "schemaVersion": "1",
  "rules": {
    "direct-value-change": { "severity": "error" },
    "propagated-value-change": { "severity": "warning", "context": { "theme": "dark" } }
  },
  "allow": [{ "changeId": "<changeId from tokenc diff>", "reason": "approved migration" }]
}
```

`check` and `diff` render the same immutable Report v1 model as text, JSON, or SARIF 2.1.0. JSON uses
the public `@tokenc/cli/report-v1.schema.json` envelope. SARIF carries Diagnostic rule metadata,
repository-relative artifact URIs, regions, related locations, valid fixes, and the unchanged
Diagnostic fingerprint in `partialFingerprints["tokenc/v1"]`. External temporary paths are reduced
to `_external/<basename>`.

The complete baseline, exit-code, artifact-retention, fork-permission, and GitHub Actions recipe is
documented in the
[CI integration guide](https://github.com/Seeridia/tokenc/blob/main/docs/CI.md). Vite+ users should
invoke machine-readable reports directly (`vp exec tokenc diff ...`) without npm's extra `--`
separator.

`tokenc check` runs frontend checks and every configured backend's read-only preflight, but never
generates or writes artifacts. `tokenc build` additionally rejects duplicate normalized output
paths before writing any file.

All commands compile through immutable Session snapshots. `tokenc dev` retains one Session across
token, config, and Resolver changes; newer changes cancel superseded rebuilds, and invalid edits do
not stop later recovery.

Resolver modifier inputs use normal flags, for example `vp exec tokenc build --theme dark` or `vp exec tokenc explain color.background --theme dark`.

Local installation is recommended so the workspace runtime can resolve backend imports from the project configuration reliably.

Requires Node.js 22.13 or newer. Licensed under MIT.
