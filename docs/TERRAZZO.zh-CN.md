# Terrazzo 共存

[English](TERRAZZO.md)

tokenc 不替代也不嵌入 Terrazzo。受支持的集成方式是单向、不可变地交接一份已经 bundle 的标准 DTCG
2025.10 JSON 文档。

```text
Terrazzo source ──> Terrazzo loading/plugin/transform/mode ──> bundled DTCG JSON
                                                                     │
                         ┌───────────────────────────────────────────┴──────┐
                         ▼                                                  ▼
                 现有 Terrazzo 生成流程                            tokenc Adapter
                                                                  │ DocumentLoader
                                                                  ▼
                                                           CompilerSession
                                                                  │
                                             check / diff / impact / Snapshot query
```

## 职责边界

Terrazzo 继续负责：

- 发现和加载自己的 source format；
- 执行 plugin、transform、alias、mode 与平台预处理；
- 管理 template、生成文件和写入生命周期；
- 把所有非标准输入转换为完整的 DTCG JSON bundle。

tokenc 只负责最终 bundle 中可见的语义：

- DTCG Token/Group parsing、类型、引用、metadata 与源码 Diagnostic；
- 不可变 Snapshot 与 query 行为；
- `check` 的只读 Backend preflight；
- semantic `diff`、policy evaluation、`impact` 与 Report v1 rendering。

这个边界有意保持信息损失。对于 Terrazzo 没有物化进 bundle 的 transform、mode、plugin 决策或 source
provenance，tokenc 无法推断，也不承诺生成与 Terrazzo 相同的 CSS 或其他产物。

## 生成并消费 bundle

由现有 Terrazzo build 生成确定性的标准 DTCG JSON 文件。具体 Terrazzo 命令由项目决定，因为它依赖项目
安装的 plugin 与配置。随后把文件内容交给示例 Adapter：

```ts
import { readFile } from "node:fs/promises";

import { compileTerrazzoBundle } from "./examples/terrazzo-adapter/src/index.js";

const identity = "/workspace/generated/tokens.bundle.json";
const result = await compileTerrazzoBundle({
  identity,
  content: await readFile(identity, "utf8"),
});

if (result.snapshot.status !== "valid") throw new Error("Bundled DTCG is invalid");
```

文件由 host 读取。Adapter 向 Core 提供内存 `DocumentLoader`，Core 在这条路径上不获得文件系统或网络
能力。外部文档请求会被拒绝，避免表面上已经 bundle 的输入静默获取缺失语义。

这个示例是私有 workspace，不是发布的兼容 package。如需程序化接入，应把这层很小的边界复制到集成方
仓库并自行维护。普通 CI 可以让 `tokenc.config.ts` 指向生成的 bundle，并使用 [CI.md](CI.zh-CN.md) 中的
命令。

## Extension 分类

`classifyTerrazzoBundleExtensions()` 会按稳定顺序报告每个 `$extensions` namespace 与 JSON Pointer：

| 分类                       | 含义                                                                      |
| -------------------------- | ------------------------------------------------------------------------- |
| `tokenc-interpreted`       | `org.token-compiler.contexts`；tokenc 应用其已记录的运行时 Context 语义。 |
| `preserved-unsupported`    | 数据作为 metadata 保留，但 tokenc 不赋予它任何语义或 transform 行为。     |
| report status `invalid`    | 输入不是合法 JSON，或某个 `$extensions` 值不是 object。                   |
| report status `compatible` | 没有发现不受支持的扩展 namespace。                                        |

未知扩展数据不会被丢弃，也不会自动成为错误；但它仍会标记为 unsupported，因为编译成功只能证明 `$value`、
`$type`、引用和标准 metadata 所表达的 DTCG 语义。如果某个扩展控制预期值、mode 或 transform，必须先在
Terrazzo bundle 步骤中物化其效果，再调用 tokenc。

## 失败与不可变性

每次 `compileTerrazzoBundle()` 调用都拥有独立 Session，并在发布后关闭。非法 bundle 会返回 invalid 的
不可变 Snapshot，不能修改先前调用返回的 Snapshot。Extension 分类是独立的只读 projection，不能更改
compiler input 或 Core 语义。

应同时检查 `snapshot.status`、Core 规范 Diagnostic 和 extension report：

- Snapshot invalid：检查步骤失败；
- Snapshot valid 且 extension report 为 `invalid`：handoff 格式非法，应失败；
- Snapshot valid 且 report 为 `unsupported`：需要项目显式决定保留的 metadata 是否影响语义；
- Snapshot valid 且 report 为 `compatible`：tokenc 可以检查已表达的 DTCG 语义。

## 与现有生成流程并行运行

让两个系统分别消费同一份已经物化的 bundle：

```bash
vp run terrazzo-build
vp exec tokenc check --config tokenc.config.ts --format text
vp exec tokenc diff --base "$TOKENC_BASE" --head HEAD --config tokenc.config.ts --policy tokenc.policy.json --format json
```

不要让 tokenc 写入 Terrazzo 的输出目录。把生成与检查分开，可以避免一方的失败或清理策略改变另一方产物。
