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

## One-time setup

1. Create or gain publish access to the `tokenc` organization on npm.
2. Create the GitHub repository and push the `main` branch.
3. Create an `npm` environment in the GitHub repository and optionally require maintainer approval.
4. Add an environment secret named `NPM_TOKEN`. Use a granular npm token restricted to the five `@tokenc/*` packages; never commit or paste it into issues or chat.
5. Prefer npm trusted publishing after the first package release. The publish workflow already requests an OIDC identity token and can be migrated away from `NPM_TOKEN` after the npm packages have trusted-publisher settings.

## Preparing a release

Create a changeset in every pull request that changes public behavior:

```bash
pnpm changeset
```

When preparing the release:

```bash
pnpm version-packages
pnpm install
pnpm check
pnpm build
```

Review versions, changelogs, generated output, and package contents before publishing.

## Inspecting package contents

Run a dry-run pack for each public package:

```bash
pnpm --filter @tokenc/core pack --dry-run
pnpm --filter @tokenc/backend-css pack --dry-run
pnpm --filter @tokenc/backend-tailwind pack --dry-run
pnpm --filter @tokenc/backend-typescript pack --dry-run
pnpm --filter @tokenc/cli pack --dry-run
```

Each package should contain only its package metadata, README, license, JavaScript output, source maps, and TypeScript declarations.

## Publishing

The repository contains two release workflows:

- `Version Packages` opens or updates a Changesets version pull request.
- `Publish Packages` is manual, requires the protected `npm` environment, and accepts `latest`, `next`, or `beta` as the npm distribution tag.

For a local manual release, authenticate with npm and verify the account:

```bash
npm whoami
pnpm release
```

For a prerelease, enter prerelease mode before versioning:

```bash
pnpm changeset pre enter beta
pnpm version-packages
pnpm install
pnpm release --tag beta
```

Exit prerelease mode when the API is ready for a stable release:

```bash
pnpm changeset pre exit
pnpm version-packages
```
