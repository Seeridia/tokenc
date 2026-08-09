# tokenc

[English](README.md) | [简体中文](README.zh-CN.md)

> 一个 DTCG 原生、强类型、基于依赖图的 Design Token 编译器。

`tokenc` 将 Design Token 视为一段小型的强类型程序：Token 是节点，引用是依赖边，Context 是求值输入，而 CSS、Tailwind 和 TypeScript 是不同的编译目标。

## 为什么需要 tokenc

传统 Token 工具通常采用下面的处理流程：

```text
JSON → deep merge → transform → filter → format
```

在这种模型下，别名、主题、诊断、影响分析和增量构建往往只能作为附加功能实现。`tokenc` 采用编译器模型：

- **DTCG 原生**：以 `$value`、`$type`、`$description`、`$extensions` 和 group type inheritance 作为源语言。
- **强类型**：核心值拥有明确的数据模型，引用在生成产物前接受静态类型检查。
- **基于依赖图**：正向和反向依赖边统一支持解析、环检测、`explain`、`usages` 和增量失效。
- **Context-aware**：theme、brand、density、platform 或自定义维度是惰性求值输入，不需要用户手工合并多份字典。
- **增量编译**：只重新解析变化的文件，并通过反向依赖边选择需要重新求值的 Token。
- **编译器级诊断**：错误保留文件、行、列、关联位置、错误码和修复建议。
- **Backend 架构**：平台输出策略集中在一个 `emit(compilation)` 操作中。

## 快速开始

仓库使用 [Vite+](https://viteplus.dev/) 作为统一工具链。只需安装一次 `vp`；仓库中的
`.node-version` 与 `packageManager` 会让它自动选择 Node.js 24 和 pnpm 11。

```bash
curl -fsSL https://vite.plus | bash
vp install
vp check
vp run -r build
vp test --run
vp -C examples/basic run build
```

在应用项目中使用已发布的 package 时，请安装 CLI、Core 和配置中实际引用的 Backend：

```bash
vp add -D \
  @tokenc/cli \
  @tokenc/core \
  @tokenc/backend-css \
  @tokenc/backend-tailwind \
  @tokenc/backend-typescript
```

创建 `tokenc.config.ts`：

```ts
import { defineConfig } from "@tokenc/core";
import { css } from "@tokenc/backend-css";
import { tailwind } from "@tokenc/backend-tailwind";
import { typescript } from "@tokenc/backend-typescript";

export default defineConfig({
  source: ["tokens/**/*.json"],
  contexts: {
    theme: { default: "light", values: ["light", "dark"] },
  },
  outputs: [
    css({ output: "dist/tokens.css" }),
    tailwind({ output: "dist/tailwind.css" }),
    typescript({ output: "dist/tokens.ts", mode: "flat", references: "symbol" }),
  ],
});
```

## 示例

DTCG 输入：

```json
{
  "color": {
    "$type": "color",
    "blue": { "600": { "$value": "#0052D9" } },
    "brand": { "default": { "$value": "{color.blue.600}" } }
  },
  "button": {
    "primary": {
      "background": {
        "$type": "color",
        "$value": "{color.brand.default}"
      }
    }
  }
}
```

保留引用关系的 CSS 输出：

```css
:root {
  --color-blue-600: #0052d9;
  --color-brand-default: var(--color-blue-600);
  --button-primary-background: var(--color-brand-default);
}
```

引用不会在全局解析阶段被抹除。CSS Backend 可以将它保留为 `var()`，TypeScript Backend 可以保留为符号，Backend 也可以选择输出解析后的最终值。

## Context Override

Context 维度只需要配置一次。Token 可以通过项目的命名空间扩展声明稀疏 override：

```json
{
  "color": {
    "page": {
      "$type": "color",
      "$value": "#ffffff",
      "$extensions": {
        "org.token-compiler.contexts": {
          "theme=dark": { "$value": "#111111" },
          "theme=dark&brand=enterprise": { "$value": "#0b0b0b" }
        }
      }
    }
  }
}
```

这个扩展保持了较小且明确的边界，并没有创造第二套 Token 语言。Resolver 会选择与当前 Context 匹配且最具体的 override。编译器只枚举源码中真实声明的 Context，并按需解析 Token，不会生成 theme × brand × density 的完整笛卡尔积。

CSS selector 可以显式配置：

```ts
css({
  selectors: {
    "theme=light": ":root",
    "theme=dark": "[data-theme='dark']",
  },
});
```

非默认 selector 中只会重复输出与默认环境不同的声明。

## Tailwind v4 设计

Tailwind Backend 会生成一个公共的运行时 Token 层，再将支持的 Token 类型映射到 Tailwind CSS-first 命名空间：

```css
:root {
  --token-color-brand-primary: var(--token-color-blue-600);
}

@theme {
  --color-brand-primary: var(--token-color-brand-primary);
}
```

这层间接引用是有意设计的：普通 CSS 和 Tailwind utility 可以共享同一份运行时值；切换主题时只需要修改 `--token-*`；语义 Token 不会被重复存储。目前支持 color、spacing、radius、font-weight 和 shadow 命名空间。

## CLI

```bash
tokenc build
tokenc check
tokenc check --json
tokenc dev
tokenc explain button.primary.background
tokenc explain button.primary.background --theme dark
tokenc usages color.blue.600
tokenc graph color.brand.default
tokenc graph --format mermaid
```

- `build`：执行完整编译；存在 error 时不写入任何产物。
- `check`：只执行解析、建图、Context 校验和类型检查。
- `check --json`：输出可供 CI 和未来编辑器插件消费的结构化诊断。
- `dev`：监听 add/change/remove，进行 debounce，遇到无效 JSON 后继续运行，并在修复后自动恢复。
- `explain`：展示指定 Token 的真实依赖链、类型、Context 和源码位置。
- `usages`：通过反向图展示直接和间接依赖方。
- `graph`：输出文本依赖树或 Mermaid 图。

## 编程接口

```ts
import { compile, parseTokenId } from "@tokenc/core";

const result = await compile({
  cwd: process.cwd(),
  source: ["tokens/**/*.json"],
  outputs: [],
});

if (result.success) {
  const impact = result.graph.analyzeImpact([parseTokenId("color.blue.600")]);

  console.log(impact.directlyAffected, impact.indirectlyAffected);
}
```

对于虚拟文件、远程数据或其他输入源，可以使用 `parseTokenDocument(content, source)` 和 `compileDocuments(inputs)`。Parser 本身不执行文件系统 IO。

## 架构

```text
DTCG JSON
    ↓
Parser + source map
    ↓
Typed Token AST
    ↓
Dependency Graph
    ↓
Context Resolver
    ↓
Type Checker
    ↓
Compiler IR
    ↓
Backend
    ↓
CSS / Tailwind / TypeScript
```

### 为什么使用依赖图？

同一个 `TokenGraph` 提供 O(1) 的 Token 和邻接关系查询，以及 O(V + E) 的图遍历，用于：

- 依赖分析
- 循环引用诊断
- 拓扑输出顺序
- 增量失效
- 影响分析
- `explain`
- `usages`

这些命令不会重新全文搜索 JSON。

完整设计说明参见[中文架构文档](docs/ARCHITECTURE.zh-CN.md)。

发布准备流程参见 [docs/RELEASING.md](docs/RELEASING.md)，参与贡献请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## Packages

- `@tokenc/core`：Parser、强类型模型、Graph、Resolver、Checker、IR、Loader 和增量编译 Session。
- `@tokenc/backend-css`：CSS Custom Properties 和稀疏 selector override。
- `@tokenc/backend-tailwind`：Tailwind v4 运行时变量和 `@theme` binding。
- `@tokenc/backend-typescript`：嵌套对象或扁平符号导出。
- `@tokenc/cli`：配置加载、诊断渲染、文件输出、图查询和 watch mode。

## 支持的 Token 类型

首个版本完整验证：

- `color`
- `dimension`
- `number`
- `duration`
- `fontWeight`

以下复合类型已保留强类型扩展位置和 JSON-safe 基础数据模型，后续版本将补充更严格的结构校验：

- `cubicBezier`
- `strokeStyle`
- `border`
- `transition`
- `shadow`
- `gradient`
- `typography`

颜色值支持 hex/CSS string、结构化 sRGB 和结构化 OKLCH。Core 保留平台无关的颜色数据，具体序列化策略由 Backend 决定。

## v0.1 非目标

以下内容有意不包含在首个版本中：

- Figma Plugin 和 Web Token Editor
- 移动平台 Backend
- Sass/Less Backend
- Cloud Sync 和 Authentication
- 完整 Expression Language
- 完整 CSS Parser
- 自行实现的复杂颜色科学库

## 当前限制

- 复杂 composite token 目前只有基础数据模型，尚未完成逐字段语义校验。
- Context override 暂时使用 `org.token-compiler.contexts` 扩展，未来会继续跟进 DTCG Resolver Module。
- 增量模式不会重新解析或求值无关 Token，但 v0.1 Backend 仍可能重写完整输出文件。
- 当前不进行复杂颜色空间转换；不支持的平台能力应由 Backend 的后续转换策略处理。

## 开发

```bash
vp install
vp check
vp run -r build
vp test --run
vp fmt --write .
vp lint --fix .
```

Vite+ 为本项目统一提供 Vitest、Oxlint、Oxfmt、类型感知检查、tsdown 打包、任务编排、Node 运行时和包管理器集成。共享配置集中在根目录的 `vite.config.ts`，每个待发布 package 只保留一个很小的 `pack` 配置；`vp run -r build` 会按照 workspace 依赖顺序调用各包的 `vp pack`。

这个仓库是 Node.js library monorepo，不是 Vite Web 应用。因此根目录的常用构建命令不是 `vp build`，`vp dev` 也不会启动 Token 编译器：请使用 `vp run -r build` 构建全部库，使用 `tokenc dev` 启动编译器的增量监听。`pnpm-workspace.yaml` 中保留的 `vitest` 和 `vite` catalog 项是 Vite+ 为 pnpm 兼容性维护的有意别名，不应手工删除。

项目使用 MIT License。
