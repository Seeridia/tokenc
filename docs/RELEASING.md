# Releasing tokenc

The public packages are:

```text
@tokenc/core
@tokenc/cli
@tokenc/backend-css
@tokenc/backend-tailwind
@tokenc/backend-typescript
```

The root package and examples are private and are never published.

## Security model

Normal releases use [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers) from the GitHub-hosted `publish.yml` workflow. Authentication uses short-lived OpenID Connect credentials; no npm token or 2FA bypass is stored in GitHub.

The publish job provides:

- GitHub `id-token: write` permission.
- A GitHub-hosted runner.
- Node.js 24, which exceeds npm's Node.js 22.14 minimum for Trusted Publishing.
- npm 11, which exceeds npm CLI 11.5.1, the minimum OIDC-capable release.
- The GitHub environment named `npm`.

As observed during the M0 acceptance on 2026-08-25, that environment does not yet have a deployment
branch policy, protection rule, or reviewer. M1-00 requires a protected-branch policy before the next
public release; an independent reviewer should be added when one is available, otherwise the
single-maintainer exception must be recorded explicitly.

Trusted Publishing automatically generates npm provenance for public packages published from this public repository. No `--provenance` flag or package-level provenance option is required.

## Current package state

All five public packages are published at npm `latest` version `0.3.0`. The M0 release was produced
from commit `2939441` on 2026-08-25 with npm provenance; the five annotated package tags resolve to
that commit. There are no pending release changesets on `main`.

Treat this paragraph as an observed state, not as permission to skip the checks below. Before every
later release, compare the workspace, changeset plan, registry versions, requested dist-tag, and
release commit again.

Until the idempotent registry-verification work tracked in the
[M1 execution plan](M1-PLAN.md) lands, do not use the workflow to promote an already-published
version from `beta` or `next` to `latest`: the current script skips versions that already exist and
does not update their dist-tag.

> **Release freeze:** do not start a new public release or retry a partial release with the current
> workflow until M1-00 is complete. The remaining sections document the intended operator flow, but
> they do not override this gate.

Before preparing any release, compare the workspace versions with npm and inspect the exact
Changesets plan:

```bash
npm view @tokenc/core version
npm view @tokenc/cli version
vp exec changeset status
```

The five packages are a Changesets fixed group, so they advance together. An actual publish is
rejected while any unconsumed `.changeset/*.md` file remains; `--dry-run` still packs the candidate
and reports that the release is blocked. `@tokenc/core` derives its exported `VERSION` from its own
package manifest, and CI runs `check:versions` to enforce that all public manifests remain aligned.

`publish-packages` asks Vite+ to delegate packing to the configured package manager (pnpm), so
`workspace:*` ranges become real versions, then publishes the tarballs with the npm CLI in dependency
order.

## Configure Trusted Publishers

Immediately after the bootstrap publication, open the Trusted Publisher settings for each of the five packages on npm and configure:

```text
Provider: GitHub Actions
Organization or user: Seeridia
Repository: tokenc
Workflow filename: publish.yml
Environment name: npm
Allowed action: npm publish
```

The workflow filename is only `publish.yml`, not `.github/workflows/publish.yml`. These values are case-sensitive, and each package must be configured separately.

After verifying one OIDC release, open each package's Publishing access settings and select **Require two-factor authentication and disallow tokens**. Revoke any obsolete npm automation token.

## Preparing later releases

Every pull request that changes public behavior should contain a changeset:

```bash
vp exec changeset
```

When changesets reach `main`, the `Version Packages` workflow opens or updates a version pull request. Review and merge that pull request before publishing.

For a prerelease, enter prerelease mode before creating the version pull request:

```bash
vp exec changeset pre enter beta
vp run version-packages
vp install
```

Exit prerelease mode when the API is ready for a stable release:

```bash
vp exec changeset pre exit
vp run version-packages
```

## Inspecting package contents

Run the complete pack pipeline without contacting npm publish:

```bash
vp run publish-packages --tag next --dry-run
```

Each package should contain only package metadata, README, license, JavaScript output, and TypeScript declarations. The temporary tarballs are removed automatically.

## Publishing with GitHub Actions

Open the repository's Actions page, select `Publish Packages`, choose `latest`, `next`, or `beta`, and run the workflow. The job:

1. Installs and validates the project.
2. Packs packages with pnpm.
3. Skips versions already present on npm.
4. Publishes each new tarball using the OIDC-aware npm CLI.
5. Creates Changesets package tags, verifies that tags exist for the release commit, and pushes each
   full tag ref to GitHub.

The `npm` GitHub environment can require maintainer approval for an additional release gate.

## Local emergency release

If GitHub Actions is unavailable, a maintainer may use normal interactive npm authentication:

```bash
npm login --auth-type=web
npm whoami
vp run release --tag latest
```

Do not create or share a long-lived npm write token for this fallback.

## References

- [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers)
- [npm provenance](https://docs.npmjs.com/generating-provenance-statements)
- [Changesets automation](https://github.com/changesets/action)
