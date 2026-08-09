# 基础示例

[English](README.md) | [简体中文](README.zh-CN.md)

这个示例将 primitive、semantic 和 component 三层 DTCG Token 编译为：

- CSS Custom Properties
- Tailwind v4 Theme Variables
- TypeScript Constants

安装依赖并完成 workspace build 后，在当前目录执行：

```bash
pnpm tokenc build
pnpm tokenc check
pnpm tokenc explain button.primary.background
pnpm tokenc usages color.blue.600
```

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
