# tokenc

![tokenc — A typed, graph-based compiler for DTCG Design Tokens](docs/assets/cover.png)

[English](README.md) | [简体中文](README.zh-CN.md)

[![npm](https://img.shields.io/npm/v/%40tokenc%2Fcore.svg?label=npm)](https://www.npmjs.com/package/@tokenc/core)
[![CI](https://github.com/Seeridia/tokenc/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Seeridia/tokenc/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/node/v/%40tokenc%2Fcore.svg)](https://nodejs.org/)
[![License](https://img.shields.io/github/license/Seeridia/tokenc)](LICENSE)

> 一个面向 DTCG Design Token、强类型且基于依赖图的编译器。

`tokenc` 将 Design Token 作为强类型程序编译。它解析
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

`tokenc` 只消费 DTCG 2025.10 Token 文档。标准功能的已实现与尚未实现范围参见
[DTCG 支持矩阵](docs/DTCG-SUPPORT.zh-CN.md)。

```bash
npm install --save-dev @tokenc/cli @tokenc/core @tokenc/backend-css
```

创建 `tokens/tokens.json`：

```json
{
  "color": {
    "$type": "color",
    "blue": {
      "600": {
        "$value": {
          "colorSpace": "srgb",
          "components": [0, 0.3215686275, 0.8509803922],
          "alpha": 1,
          "hex": "#0052D9"
        }
      }
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
[Resolver 示例](examples/dtcg-resolver)展示结构化 DTCG Color、Set、Modifier 与显式 Resolution Order。
[Terrazzo Adapter 示例](examples/terrazzo-adapter)展示如何只读接收已经 bundle 的标准 DTCG 文档，而不导入
或模拟 Terrazzo。
[React 计数器](examples/react-counter)是一个实际可运行的 Vite 应用，同时消费生成的 CSS 变量与
TypeScript 常量，也可作为完整的 VS Code Extension 体验项目。

## CLI

| 命令                            | 用途                                |
| ------------------------------- | ----------------------------------- |
| `tokenc build`                  | 校验、编译并写入配置的产物。        |
| `tokenc check`                  | 只校验，不写文件。                  |
| `tokenc check --format <类型>`  | 输出文本、Report v1 JSON 或 SARIF。 |
| `tokenc dev`                    | 监听文件并进行增量编译。            |
| `tokenc explain <token>`        | 追踪 Token 到最终字面值。           |
| `tokenc usages <token>`         | 查询直接和间接依赖方。              |
| `tokenc graph [token]`          | 输出依赖图。                        |
| `tokenc graph --format mermaid` | 输出 Mermaid 图语法。               |
| `tokenc impact <source...>`     | 将变化源文件映射到受影响 Token。    |
| `tokenc diff --base <ref>`      | 比较 Git revision 与当前 worktree。 |
| `tokenc diff --policy <path>`   | 执行 Breaking-change Policy v1。    |

在本仓库中可以这样执行：

```bash
vp -C examples/basic run tokenc impact tokens/primitive.json
vp -C examples/basic run tokenc impact tokens/primitive.json --format json
vp -C examples/basic run tokenc diff --base HEAD~1 --format json
vp -C examples/basic run tokenc diff --base HEAD~1 --policy tokenc.policy.json
vp -C examples/basic run tokenc check --format sarif
```

可重复传入 `--context name=value` 来限定 Context 区域；不传 Context 时，报告会保留精确的 Predicate
区域。退出码 `2` 表示结果不完整，例如 source 未知、Snapshot 非法或 Context 不受支持。

`diff` 只读取 Git object 与 worktree，不 checkout、不 stash、不写 index，也不移动 branch。它只执行当前
受信任配置；如果默认配置在 revision 之间不同，结果为 incomplete。显式传入 `--config path` 表示选择
当前配置作为两侧共同的受信任 analysis config。

传入 `--policy` 后，退出码 `0` 表示通过，`1` 表示存在未豁免的 error 级变化，`2` 表示判断不完整或
policy 非法。规则可配置 severity 与 Context scope；allow entry 引用 diff 输出的稳定 `changeId`。

`check` 与 `diff` 的 text、JSON、SARIF 输出共享同一个不可变 report model。源码路径相对仓库根目录，
Diagnostic 的 code、severity、location 与 fingerprint 在各格式中保持一致。JSON envelope Schema 通过
`@tokenc/cli/report-v1.schema.json` 发布。

baseline 选择、shallow clone 要求、退出码处理、artifact 保留、fork 权限及固定 commit 的 GitHub
Actions workflow 参见 [CI 集成指南](docs/CI.zh-CN.md)。

编译失败时不会写入不完整产物。

## 编译器模型

```text
DTCG 2025.10
    ↓
Parser
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

DTCG 2025.10 Resolver Module 是一等输入：Set 与 Modifier 按显式 `resolutionOrder` 组合，再在结果
Graph 上检查 Alias。`org.token-compiler.contexts` 是非标准 tokenc 扩展，用于表示一次编译中的运行时
Context-dependent value；它与标准 DTCG Parser 隔离、与 Resolver 的源组合语义不同，并会归一化为
具有确定性优先级的强类型 Context Override。

非 DTCG 格式不属于编译器输入语言。旧 Token 文件应先转换为 DTCG；Importer/Migrator 的输出必须是
DTCG，而不能绕过 DTCG Parser 直接构造语义节点。

完整数据模型、Context 语义、增量失效与 Backend 契约参见[架构文档](docs/ARCHITECTURE.zh-CN.md)；
[M1 API 稳定边界](docs/M1-API-STABILITY.zh-CN.md)记录受支持的入口与直接破坏性替换。

## 编程接口

```ts
import { compile, parseTokenId } from "@tokenc/core";

const snapshot = await compile({
  source: ["tokens/**/*.json"],
});

if (snapshot.status === "valid") {
  const impact = snapshot.query.impact([parseTokenId("color.blue.600")]);
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

| 支持级别 | 类型                                                                                     |
| -------- | ---------------------------------------------------------------------------------------- |
| 完整校验 | `color`、`dimension`、`fontFamily`、`number`、`duration`、`fontWeight`                   |
| 完整校验 | `cubicBezier`、`strokeStyle`、`border`、`transition`、`shadow`、`gradient`、`typography` |

DTCG Color 保留全部 14 种标准颜色空间、`none` 分量、alpha 与可选 hex fallback。字符串颜色简写
不是编译器输入。平台转换仍由 Backend 负责；Composite 值会按 DTCG 字段形状与数值范围校验。

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

- [VS Code Extension 完整指南](docs/VS-CODE-GUIDE.zh-CN.md) · [English](docs/VS-CODE-GUIDE.md)
- [React 计数器示例](examples/react-counter/README.zh-CN.md) · [English](examples/react-counter/README.md)
- [VS Code Extension Package](packages/vscode-extension/README.zh-CN.md) · [English](packages/vscode-extension/README.md)
- [M2 release candidate 验收](docs/M2-ACCEPTANCE.zh-CN.md) · [English](docs/M2-ACCEPTANCE.md)

- [架构文档](docs/ARCHITECTURE.zh-CN.md) · [English](docs/ARCHITECTURE.md)
- [产品战略与发展路线图](docs/ROADMAP.zh-CN.md) · [English](docs/ROADMAP.md)
- [M0 阶段验收记录](docs/M0-ACCEPTANCE.zh-CN.md) · [English](docs/M0-ACCEPTANCE.md)
- [M1 执行计划](docs/M1-PLAN.zh-CN.md) · [English](docs/M1-PLAN.md)
- [M1-01 测量基线](docs/M1-01-BASELINE.zh-CN.md) · [English](docs/M1-01-BASELINE.md)
- [DTCG 2025.10 支持矩阵](docs/DTCG-SUPPORT.zh-CN.md) · [English](docs/DTCG-SUPPORT.md)
- [Compiler Benchmark](benchmarks/README.zh-CN.md) · [English](benchmarks/README.md)
- [参与贡献](CONTRIBUTING.md)
- [发布流程](docs/RELEASING.md)

## License

[MIT](LICENSE)
