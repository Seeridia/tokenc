# Basic example

[English](README.md) | [简体中文](README.zh-CN.md)

This example compiles primitive, semantic, and component-level DTCG tokens to CSS custom properties, Tailwind v4 theme variables, and TypeScript constants.

From this directory, after installing and building the workspace:

```bash
pnpm tokenc build
pnpm tokenc check
pnpm tokenc explain button.primary.background
pnpm tokenc usages color.blue.600
```

Generated files are written to `dist/`.
