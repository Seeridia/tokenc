# Compiler benchmark

[English](README.md)

这套 benchmark 用于可重复地刻画 tokenc 自身性能，不构成对 Terrazzo 或其他 Token 工具的速度声明。

本地快速运行：

```bash
vp run bench -- --profile quick --output artifacts/benchmark-quick.json
```

生成可评审的基线：

```bash
vp run bench -- --profile baseline --output artifacts/benchmark-baseline.json
```

M1-01 参考报告保存在
[`baselines/m1-01-apple-m4-pro-node24.json`](baselines/m1-01-apple-m4-pro-node24.json)，分析与范围决策
见 [M1-01 测量基线](../docs/M1-01-BASELINE.zh-CN.md)。

`quick` 对每个 case 执行 1 次 warm-up、3 次 timing sample 和 1 次独立 memory sample；`baseline`
分别执行 5、20、3 次。可重复传入 `--case <id>` 选择 case，`--list` 列出所有 ID。用于测试 harness
的 `--warmups`、`--samples` 和 `--memory-samples` 覆盖值也会写入报告。

## 报告契约

报告遵循 [`benchmark-report.v1.schema.json`](benchmark-report.v1.schema.json)，记录 commit、dirty
状态、Node/V8 版本、CPU、平台、架构、逻辑核心数、采样方法、fixture 身份、原始样本及 R-7
p50/p95。Fixture SHA-256 根据排序后的逻辑路径与 UTF-8 内容生成，不包含机器上的绝对路径。

每个计时样本都必须满足 case 的语义预期。success、Token/引用数、增量 counters 或预期 Diagnostic
数量变化时，benchmark 会直接失败；各样本的语义摘要也必须一致。
`validation.compilationSuccess` 表示 Compiler 是否接受输入，`validation.matchesExpected` 才表示该次
benchmark 是否有效；部分 Context limit 和生态 case 本来就预期编译失败。

阶段时间来自 Core，包括 parse、link、graph、check、resolve、emit 与 total。Fixture 生成、corpus
文件读取、worker 启动、GC 和计时后的语义摘要均不进入操作耗时；所有 case 顺序运行。

## 内存口径

时间与内存分开测量。一个 case 的 timing samples 共用一个 worker，以保留运行时 warm-up，但每个
sample 都创建新的 Compiler/Session 状态。每个 memory sample 则启动全新 Node 进程，在准备选中的
fixture 并显式 GC 后只执行一次 operation。

`peakRssBytes` 来自 Node 的进程生命周期 `process.resourceUsage().maxRSS`，由 KiB 统一转换为 byte，
因此绝对峰值包含 Node runtime、已导入的 harness 和选中 fixture 的输入基线。
`baselineRssBytes`、`preMaxRssBytes` 会同时保留，主要比较值是
`peakIncreaseBytes = peakRssBytes - preMaxRssBytes`。如果准备阶段已经建立更高水位，该增量可能为 0；
普通 `heapUsed` 起止快照不会被误称为峰值内存。

只有 Node 版本、CPU、平台、架构、profile、case ID、fixture digest、cache state、输出目标和采样数
一致的报告才适合比较。共享云 runner 可检查格式，但暂不用于性能阈值。

## Workload

矩阵覆盖 small conformance、1k/10k wide graph、10k deep alias chain、fan-out、稀疏 Context、
8/10/12/14/15 维投影、override-heavy，以及一次影响并重算 12 个 Token 的 10k 增量 session；还覆盖
固定的 `dtcg-examples@1.1.3` 全部七个 Resolver，以及带 CSS emit 的代表性项目。

代表性项目是确定性生成并明确标记为 `synthetic` 的公开数据，不冒充真实客户项目。
`dtcg-examples` 由 Terrazzo 社区维护，它是生态互操作语料，不是 DTCG 官方 conformance suite，也不
代表跨工具性能结论。
