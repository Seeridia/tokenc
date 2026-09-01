# tokenc React 计数器

[English](README.md)

这是一个足够小、但具有完整真实链路的 Vite + React + TypeScript 应用：DTCG Token 是唯一源头，
`tokenc` 同时生成 CSS Custom Properties 与 TypeScript 常量，React 分别用它们控制界面和计数逻辑。

## 运行

从仓库根目录执行：

```bash
vp install
vp -C examples/react-counter run check:tokens
vp -C examples/react-counter run dev
```

打开终端显示的本地地址。页面可以增减或重置计数，也可以切换 light/dark 主题。生产构建使用：

```bash
vp -C examples/react-counter run build
```

`dev` 和 `build` 都会先重新生成 Token 产物。若希望修改 Token 时持续生成，可另开一个终端：

```bash
vp -C examples/react-counter run tokens:watch
```

## 数据如何流动

```text
tokens/*.json
    │  DTCG Token、Alias、theme Context
    ▼
tokenc.config.ts
    ├── CSS backend ─────► src/generated/tokens.css ─► styles.css
    └── TypeScript backend ► src/generated/tokens.ts ─► App.tsx
```

- [`tokens/foundation.json`](tokens/foundation.json) 定义原始颜色、间距、圆角、动效与计数范围。
- [`tokens/semantic.json`](tokens/semantic.json) 用 Alias 构成语义层，并用
  `org.token-compiler.contexts` 定义 dark theme override。
- [`tokens/component.json`](tokens/component.json) 将语义 Token 映射到应用与控件。
- [`tokenc.config.ts`](tokenc.config.ts) 将 `theme=light/dark` 映射为 CSS selector，并开启扁平
  TypeScript 输出。
- [`src/generated/tokens.css`](src/generated/tokens.css) 被样式直接使用，例如
  `var(--counter-panel-background)`。
- [`src/generated/tokens.ts`](src/generated/tokens.ts) 被 React 直接导入，例如 `counterStep`。
- [`src/theme.tsx`](src/theme.tsx) 只负责切换 DOM 上的 `data-theme`；真正的主题值来自生成的 CSS。

生成物刻意提交到仓库，便于阅读和比较；请勿手工维护，运行 `vp -C examples/react-counter run tokens`
即可重建。

## 用这个示例体验 VS Code Extension

先安装 VSIX，然后把这个示例本身作为 workspace 打开：

```bash
vp -C packages/vscode-extension run package:vsix
code --install-extension artifacts/tokenc-vscode.vsix --force
code examples/react-counter
```

安装命令只安装扩展，不会自动打开窗口。进入新窗口后信任 workspace；示例内的
`.vscode/settings.json` 已配置 light/dark Context profile。

依次尝试：

1. 打开 `tokens/semantic.json`，把鼠标停在 `{palette.slate.50}` 上，查看类型、表达式、解析值、
   Context 与来源链。
2. 在同一个 Alias 上按 `F12` 跳到定义，按 `Shift+F12` 查看全部引用。
3. 在 Alias 的 `{` 后按 `Ctrl+Space`（macOS 也可通过命令面板执行
   **Trigger Suggest**），查看按 Token ID 排序的补全。
4. 打开 Explorer 的 **Outline** 查看文档 Token 层级；按 `Cmd+T`（Windows/Linux 为
   `Ctrl+T`）搜索 workspace Token。
5. 在 `surface.muted` 的声明或引用上按 `F2`，输入完整 ID `surface.subtle`。声明和所有 Token
   Alias 会一起改名；运行 `vp -C examples/react-counter run tokens` 更新生成物。体验后可撤销。
6. 临时把任意 Alias 改成 `{missing.token}`，观察 Problems 与行内诊断；恢复有效内容后，诊断会基于
   当前 snapshot 消失。
7. 打开命令面板，运行 **tokenc: Select Context Profile** → **Dark**，再次 Hover
   `canvas.background`，解析值会切换到 dark Context。这个选择只影响编辑器查询，不会修改文件，也不
   会控制浏览器主题。
8. 运行 **tokenc: Show Language Server Status** 检查运行和信任状态；需要重载时运行
   **tokenc: Restart Language Server**。

VS Code Extension 的全部功能、设置、多根 workspace 和排障手册见
[完整使用指南](../../docs/VS-CODE-GUIDE.zh-CN.md)。

## 常用命令

| 命令                                            | 作用                              |
| ----------------------------------------------- | --------------------------------- |
| `vp -C examples/react-counter run tokens`       | 生成 CSS 与 TypeScript            |
| `vp -C examples/react-counter run check:tokens` | 只校验 Token，不写文件            |
| `vp -C examples/react-counter run tokens:watch` | 监听 Token 并增量生成             |
| `vp -C examples/react-counter run dev`          | 生成 Token 并启动 Vite 开发服务器 |
| `vp -C examples/react-counter run build`        | 生成 Token 并构建生产站点         |
