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
- The protected GitHub environment named `npm`.

Trusted Publishing automatically generates npm provenance for public packages published from this public repository. No `--provenance` flag or package-level provenance option is required.

## Bootstrap: first publication only

Trusted Publisher settings are configured from an existing package's npm settings. Because the five `@tokenc/*` packages have not been published yet, bootstrap them once from a maintainer machine using normal interactive npm authentication and normal 2FA. Do not create a token that bypasses 2FA.

```bash
npm login --auth-type=web
npm whoami
pnpm check
pnpm publish-packages --tag latest
```

`publish-packages` packs packages with pnpm so `workspace:*` ranges become real versions, then publishes the tarballs with the npm CLI in dependency order. The npm CLI can prompt for normal 2FA during this one-time bootstrap.

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
pnpm changeset
```

When changesets reach `main`, the `Version Packages` workflow opens or updates a version pull request. Review and merge that pull request before publishing.

For a prerelease, enter prerelease mode before creating the version pull request:

```bash
pnpm changeset pre enter beta
pnpm version-packages
pnpm install
```

Exit prerelease mode when the API is ready for a stable release:

```bash
pnpm changeset pre exit
pnpm version-packages
```

## Inspecting package contents

Run the complete pack pipeline without contacting npm publish:

```bash
pnpm publish-packages --tag next --dry-run
```

Each package should contain only package metadata, README, license, JavaScript output, and TypeScript declarations. The temporary tarballs are removed automatically.

## Publishing with GitHub Actions

Open the repository's Actions page, select `Publish Packages`, choose `latest`, `next`, or `beta`, and run the workflow. The job:

1. Installs and validates the project.
2. Packs packages with pnpm.
3. Skips versions already present on npm.
4. Publishes each new tarball using the OIDC-aware npm CLI.
5. Creates Changesets package tags and pushes them to GitHub.

The `npm` GitHub environment can require maintainer approval for an additional release gate.

## Local emergency release

If GitHub Actions is unavailable, a maintainer may use normal interactive npm authentication:

```bash
npm login --auth-type=web
npm whoami
pnpm release --tag latest
```

Do not create or share a long-lived npm write token for this fallback.

## References

- [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers)
- [npm provenance](https://docs.npmjs.com/generating-provenance-statements)
- [Changesets automation](https://github.com/changesets/action)
