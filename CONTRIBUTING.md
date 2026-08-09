# Contributing

Thank you for helping improve tokenc.

## Development setup

Install the [Vite+](https://viteplus.dev/) `vp` CLI. It reads `.node-version` and
`packageManager`, so contributors do not need to install the repository's Node.js and pnpm
versions separately.

```bash
vp install
vp check
vp test --run
vp run -r build
```

## Pull requests

1. Keep changes focused and preserve package boundaries.
2. Add tests for behavior changes.
3. Run `vp check`, `vp test --run`, and `vp run -r build` before opening a pull request.
4. Run `vp exec changeset` for changes that affect a published package.
5. Update English and Chinese documentation together when public behavior changes.

The compiler core must not print to the terminal, terminate the process, or write output artifacts. Those responsibilities belong to the CLI and IO layers.

## Commit and release model

The repository uses Changesets. Public packages are kept in a fixed version group during the early release phase. Maintainers create versions with `vp run version-packages` and publish with `vp run release`.

## 中文说明

提交代码前请确保 `vp check`、`vp test --run` 与 `vp run -r build` 均通过。影响公开 package 行为的修改需要执行 `vp exec changeset`。如果修改了公开文档，请同步维护英文与简体中文版本。
