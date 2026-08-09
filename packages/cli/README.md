# @tokenc/cli

Command-line interface for the tokenc Design Token compiler.

Install the CLI and the backends referenced by your `tokenc.config.ts` as local development dependencies:

```bash
pnpm add -D \
  @tokenc/cli \
  @tokenc/core \
  @tokenc/backend-css \
  @tokenc/backend-tailwind \
  @tokenc/backend-typescript
```

```bash
pnpm tokenc build
pnpm tokenc check
pnpm tokenc dev
pnpm tokenc explain button.primary.background
pnpm tokenc usages color.blue.600
pnpm tokenc graph --format mermaid
```

Local installation is recommended so pnpm can resolve backend imports from the project configuration reliably.

Requires Node.js 20 or newer. Licensed under MIT.
