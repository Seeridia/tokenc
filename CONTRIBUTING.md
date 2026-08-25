# Contributing

Thank you for helping improve tokenc.

## Development setup

Install the [Vite+](https://viteplus.dev/) `vp` CLI. It reads `.node-version` and
`packageManager`, so contributors do not need to install the repository's Node.js and pnpm
versions separately.

```bash
vp install
vp check
vp run -r build
vp test --run
```

## Pull requests

1. Keep changes focused and preserve package boundaries.
2. Add tests for behavior changes.
3. Run `vp check`, `vp run -r build`, and `vp test --run` before opening a pull request.
4. Run `vp exec changeset` for changes that affect a published package.
5. Update English and Chinese documentation together when public behavior changes.

The compiler core must not print to the terminal, terminate the process, or write output artifacts. Those responsibilities belong to the CLI and IO layers.

Package type checking uses each package's regular `tsconfig.json` and never emits files. Publishable
packages use `tsconfig.build.json` so declaration bundling resolves already-built workspace
dependencies from `dist` instead of writing declarations beside another package's source files. If
you add a workspace dependency to a publishable package, update both `package.json` and that build
path map, then confirm `vp run -r build` leaves the Git worktree clean.

## Commit and release model

The repository uses Changesets. Public packages are kept in a fixed version group during the early release phase. Maintainers create versions with `vp run version-packages` and publish with `vp run release`.

## 中文说明

提交代码前请确保 `vp check`、`vp run -r build` 与 `vp test --run` 均通过。影响公开 package 行为的修改需要执行 `vp exec changeset`。如果修改了公开文档，请同步维护英文与简体中文版本。可发布 package 的声明构建使用 `tsconfig.build.json` 指向已构建的 workspace `dist`；新增 workspace 依赖时必须同步更新该映射，并确认递归 build 不会在其他 package 的 `src` 中生成声明文件。
