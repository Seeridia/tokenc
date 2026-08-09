# tokenc

[English](README.md) | [简体中文](README.zh-CN.md)

[![npm](https://img.shields.io/npm/v/%40tokenc%2Fcore.svg?label=npm)](https://www.npmjs.com/package/@tokenc/core)
[![CI](https://github.com/Seeridia/tokenc/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Seeridia/tokenc/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/node/v/%40tokenc%2Fcore.svg)](https://nodejs.org/)
[![License](https://img.shields.io/github/license/Seeridia/tokenc)](LICENSE)

> 一个 DTCG 原生、强类型、基于依赖图的 Design Token 编译器。

`tokenc` 将 Design Token 作为强类型程序编译，而不是将 JSON 合并后套用模板。它解析
DTCG、检查引用和类型、惰性求值 Context，并通过独立 Backend 输出 CSS、Tailwind CSS 或
TypeScript。

## 为什么选择 tokenc

传统 Token 工具经常演变为 `JSON → deep merge → transforms → templates`。`tokenc` 采用编译器模型：

- **DTCG 原生**：以 `$value`、`$type`、`$description`、`$extensions` 和 group type
  inheritance 为源语言。
- **强类型**：生成产物前检查 Token 值和引用类型。
- **依赖图驱动**：引用是依赖边，统一支持环检测、影响分析、`explain` 和 `usages`。
- **Context-aware**：惰性求值 theme、brand、density、platform 和自定义维度，不生成完整笛卡尔积。
- **增量编译**：只重新解析变化文件，并通过反向依赖边定位受影响 Token。
- **Backend policy**：每个目标自行决定保留引用、解析最终值或输出符号。
- **结构化诊断**：错误保留错误码、源码位置、关联位置和修复建议。

## 快速开始

需要 Node.js 22.13 或更高版本。

```bash
npm install --save-dev @tokenc/cli @tokenc/core @tokenc/backend-css
```

创建 `tokens/tokens.json`：

```json
{
  "color": {
    "$type": "color",
    "blue": {
      "600": { "$value": "#0052D9" }
    },
    "brand": {
      "default": { "$value": "{color.blue.600}" }
    }
  }
}
```

创建 `tokenc.config.ts`：

```ts
import { css } from "@tokenc/backend-css";
import { defineConfig } from "@tokenc/core";

export default defineConfig({
  source: ["tokens/**/*.json"],
  outputs: [
    css({
      output: "dist/tokens.css",
      references: "preserve",
    }),
  ],
});
```

执行编译：

```bash
npx tokenc build
```

```css
:root {
  --color-blue-600: #0052d9;
  --color-brand-default: var(--color-blue-600);
}
```

[基础示例](examples/basic)包含 CSS、Tailwind CSS、TypeScript、别名和组件 Token 的完整配置。

## CLI

| 命令                            | 用途                         |
| ------------------------------- | ---------------------------- |
| `tokenc build`                  | 校验、编译并写入配置的产物。 |
| `tokenc check`                  | 只校验，不写文件。           |
| `tokenc check --json`           | 输出机器可读的结构化诊断。   |
| `tokenc dev`                    | 监听文件并进行增量编译。     |
| `tokenc explain <token>`        | 追踪 Token 到最终字面值。    |
| `tokenc usages <token>`         | 查询直接和间接依赖方。       |
| `tokenc graph [token]`          | 输出依赖图。                 |
| `tokenc graph --format mermaid` | 输出 Mermaid 图语法。        |

编译失败时不会写入不完整产物。

## 编译器模型

```text
DTCG JSON
    ↓
Typed AST + source provenance
    ↓
Token dependency graph
    ↓
Context resolver + type checker
    ↓
Compiler IR
    ↓
CSS / Tailwind CSS / TypeScript backends
```

引用是依赖边，而不是格式化阶段替换的字符串。同一个 Graph 支持别名解析、环诊断、拓扑输出、增量失效、
影响分析和图查询命令。

引用解析由 Backend 决定：

```ts
import { css } from "@tokenc/backend-css";
import { typescript } from "@tokenc/backend-typescript";

css({ references: "preserve" });
typescript({ references: "symbol" });
```

Context 是稀疏的求值输入。Token 可以通过命名空间扩展 `org.token-compiler.contexts` 声明 override；
编译器只求值匹配项，CSS 也只重复输出发生变化的声明。

完整数据模型、Context 语义、增量失效与 Backend 契约参见[架构文档](docs/ARCHITECTURE.zh-CN.md)。

## 编程接口

```ts
import { compile, parseTokenId } from "@tokenc/core";

const result = await compile({
  source: ["tokens/**/*.json"],
});

if (result.success) {
  const impact = result.graph.analyzeImpact([parseTokenId("color.blue.600")]);
  console.log(impact.directlyAffected, impact.indirectlyAffected);
}
```

虚拟文件或远程输入可以使用 `parseTokenDocument(content, source)` 和 `compileDocuments(inputs)`；
Parser 不依赖文件系统 IO。

## Packages

| Package                                                                                  | 职责                                           |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------- |
| [`@tokenc/core`](https://www.npmjs.com/package/@tokenc/core)                             | Parser、类型、Graph、Resolver、Checker 和 IR。 |
| [`@tokenc/cli`](https://www.npmjs.com/package/@tokenc/cli)                               | 构建、校验、监听、诊断和图查询。               |
| [`@tokenc/backend-css`](https://www.npmjs.com/package/@tokenc/backend-css)               | CSS Custom Properties 和 Context selector。    |
| [`@tokenc/backend-tailwind`](https://www.npmjs.com/package/@tokenc/backend-tailwind)     | Tailwind CSS v4 `@theme` 变量。                |
| [`@tokenc/backend-typescript`](https://www.npmjs.com/package/@tokenc/backend-typescript) | Object 与扁平 TypeScript 导出。                |

## Token 支持

| 支持级别            | 类型                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------- |
| 完整校验            | `color`、`dimension`、`number`、`duration`、`fontWeight`                                 |
| 基础 Composite 模型 | `cubicBezier`、`strokeStyle`、`border`、`transition`、`shadow`、`gradient`、`typography` |

颜色支持 CSS string、结构化 sRGB 和结构化 OKLCH。平台转换仍由 Backend 负责；Composite 类型将在后续
版本中补充更深入的字段级校验。

## 开发

仓库使用 [Vite+](https://viteplus.dev/) 管理运行时、包管理器、静态检查、测试、打包和 Monorepo 任务。

```bash
vp install
vp check
vp run -r build
vp test --run
```

这是一个 Library Monorepo：各 Package 使用 `vp pack` 构建，由 `vp run -r build` 统一编排。

## 文档

- [架构文档](docs/ARCHITECTURE.zh-CN.md) · [English](docs/ARCHITECTURE.md)
- [参与贡献](CONTRIBUTING.md)
- [发布流程](docs/RELEASING.md)

## License

[MIT](LICENSE)
