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
3. Add real `repository`, `homepage`, and `bugs` fields to each public package after the repository URL is known.
4. Configure npm trusted publishing for the GitHub repository, or add a short-lived automation token only if trusted publishing is unavailable.
5. Add a release workflow only after the npm organization and repository environment exist, so a newly pushed repository cannot trigger a broken publish job.

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

Authenticate with npm and verify the account before the first manual release:

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
