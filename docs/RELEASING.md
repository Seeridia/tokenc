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

The workflow first runs a permissionless preflight job that fails visibly unless the dispatch ref is
exactly `refs/heads/main`. Only after that check passes can the publish job enter the `npm`
environment and request release permissions.

The publish job provides:

- GitHub `id-token: write` permission.
- A GitHub-hosted runner.
- Node.js 24, which exceeds npm's Node.js 22.14 minimum for Trusted Publishing.
- npm 11, which exceeds npm CLI 11.5.1, the minimum OIDC-capable release.
- The GitHub environment named `npm`.

As configured during M1-00 on 2026-08-25, that environment accepts deployments only from protected
branches. The repository currently has one direct collaborator, so no required reviewer is
configured: this is the explicit single-maintainer exception. Add an independent environment
reviewer when another maintainer is available. The environment policy complements the workflow
preflight and cannot be enforced by the workflow file itself.

The active `Protect tokenc release tags` repository ruleset matches `refs/tags/@tokenc/**` and
forbids both updates and deletion without a bypass actor. Release tags therefore remain immutable
after their initial creation.

The publish command also passes `--provenance` explicitly. Together with Trusted Publishing, this
requires npm to generate provenance for every public package from this public repository.

## Current package state

All five public packages are published at npm `next` version `0.5.0`; `latest` remains `0.3.0`. The
M2 release was produced from commit `93b3380` on 2026-09-01 by
[workflow run 33521149877](https://github.com/Seeridia/tokenc/actions/runs/33521149877). Independent
registry checks confirmed SLSA provenance v1 for every package, and the five annotated `0.5.0`
package tags resolve to that commit. There are no pending release changesets on `main`.

Treat this paragraph as an observed state, not as permission to skip the checks below. Before every
later release, compare the workspace, changeset plan, registry versions, requested dist-tag, and
release commit again. The repository-owned release verifier performs these checks against one
manifest that binds the five packed tarballs, requested dist-tag, and commit.

An existing version is an idempotent success only when its registry tarball, internal dependencies,
dist-tag, provenance subject, workflow source, and release commit all match that manifest. A partial
publication retry publishes only the missing packages, then verifies the full five-package release.
An existing version under a different dist-tag fails closed; dist-tag promotion remains a separate,
manually reviewed operation. A missing candidate must also be newer than every version already in
that package's registry metadata, preventing an explicit npm tag from rolling back to an older
version.

Before preparing any release, compare the workspace versions with npm and inspect the exact
Changesets plan:

```bash
vp exec npm view @tokenc/core version
vp exec npm view @tokenc/cli version
vp exec changeset status
```

The five packages are a Changesets fixed group, so they advance together. The manifest-driven
publish path is rejected while any unconsumed `.changeset/*.md` file remains. `@tokenc/core` derives
its exported `VERSION` from its own package manifest, and CI runs `check:versions` to enforce that
all public manifests remain aligned.

The packed verification phase asks Vite+ to delegate packing to the configured package manager
(pnpm), so `workspace:*` ranges become real versions. It checks the exact package set, package
contents and internal dependency versions, writes an immutable release manifest and tag list, and
runs a consumer smoke test against the tarballs. Publishing consumes those exact manifest-bound
tarballs in dependency order instead of packing them again.

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

Run the complete packed-candidate verification without contacting npm publish:

```bash
release_output="$(mktemp -d)"
vp run verify-release \
  --phase packed \
  --tag next \
  --commit "$(git rev-parse HEAD)" \
  --output "$release_output"
```

Inspect `$release_output/release-manifest.json` and the five tarballs. Each package should contain
only package metadata, README, license, JavaScript output, and TypeScript declarations. The command
also runs the packed-tarball consumer smoke test and writes the exact expected annotated tags to
`$release_output/release-tags.txt`.

Before creating tags or publishing, reproduce the read-only pre-publish registry scan with:

```bash
vp run verify-release --phase prepublish \
  --manifest "$release_output/release-manifest.json"
```

This rejects pending changesets or any mismatched existing package before publication begins.

## Publishing with GitHub Actions

Open the repository's Actions page, select `Publish Packages`, choose `latest`, `next`, or `beta`, and run the workflow. The job:

1. Fails in a separate permissionless preflight job unless the selected ref is `main`.
2. Installs, validates, builds, and tests the project, then refuses to continue if those steps changed
   any tracked or untracked release input.
3. Packs the five candidates once, verifies their manifest and contents, and runs a tarball consumer
   smoke test.
4. Performs a read-only, full-package registry scan and rejects pending changesets or any mismatched
   existing release.
5. Creates the five Changesets annotated tags and verifies that each peels to the manifest commit.
6. Rechecks the registry fail-closed, then publishes only missing manifest-bound tarballs
   using the OIDC-aware npm CLI.
7. Waits for npm registry visibility, verifies all five packages, their requested dist-tag and
   provenance, and runs a registry-installed consumer smoke test.
8. Pushes only the exact refs listed in `release-tags.txt`, then verifies the remote annotated tags.
9. Fails if any release step leaves the worktree dirty.

The `npm` GitHub environment requires a protected branch. Add independent maintainer approval when
a second maintainer is available. If GitHub Actions is unavailable, restore the trusted workflow
instead of publishing locally or creating a long-lived npm write token.

For a read-only post-publication recheck from the release commit, first reproduce the packed manifest
as above, then run:

```bash
vp run verify-release --phase published \
  --manifest "$release_output/release-manifest.json"
vp run verify-release --phase remote-tags \
  --manifest "$release_output/release-manifest.json"
```

## References

- [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers)
- [npm provenance](https://docs.npmjs.com/generating-provenance-statements)
- [Changesets automation](https://github.com/changesets/action)
