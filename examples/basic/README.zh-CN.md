# 基础示例

[English](README.md) | [简体中文](README.zh-CN.md)

这个示例将 primitive、semantic 和 component 三层 DTCG Token 编译为：

- CSS Custom Properties
- Tailwind v4 Theme Variables
- TypeScript Constants

安装 workspace 依赖后，在仓库根目录执行：

```bash
vp -C examples/basic run tokenc build
vp -C examples/basic run tokenc check
vp -C examples/basic run tokenc explain button.primary.background
vp -C examples/basic run tokenc usages color.blue.600
vp -C examples/basic run tokenc impact tokens/primitive.json
vp -C examples/basic run tokenc diff --base HEAD~1 --format json
vp -C examples/basic run tokenc diff --base HEAD~1 --policy tokenc.policy.json
```

仓库内的 `tokenc.policy.json` 会把 direct value change 提升为 error。Policy 退出码 `0` 表示通过，
`1` 表示存在未 allow 的 error finding，`2` 表示判断不完整。

生成的文件位于 `dist/`：

```text
dist/tokens.css
dist/tailwind.css
dist/tokens.ts
```

其中：

- `tokens.css` 保留 CSS `var()` 引用关系。
- `tailwind.css` 生成公共 `--token-*` 运行时变量和 Tailwind `@theme` binding。
- `tokens.ts` 生成按依赖顺序排列的 TypeScript symbol exports。
