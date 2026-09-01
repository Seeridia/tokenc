# Basic example

[English](README.md) | [简体中文](README.zh-CN.md)

This example compiles primitive, semantic, and component-level DTCG tokens to CSS custom properties, Tailwind v4 theme variables, and TypeScript constants.

From the repository root, after installing the workspace:

```bash
vp -C examples/basic run tokenc build
vp -C examples/basic run tokenc check
vp -C examples/basic run tokenc explain button.primary.background
vp -C examples/basic run tokenc usages color.blue.600
vp -C examples/basic run tokenc impact tokens/primitive.json
vp -C examples/basic run tokenc diff --base HEAD~1 --format json
vp -C examples/basic run tokenc diff --base HEAD~1 --policy tokenc.policy.json
```

The committed `tokenc.policy.json` promotes direct value changes to errors. Policy exit codes are
`0` for pass, `1` for an unallowed error finding, and `2` for an incomplete decision. Generated
files are written to `dist/`.
