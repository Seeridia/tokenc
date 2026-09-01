# Compiler benchmark

[English](README.md)

`vp run bench:gate` 锁定 M1 增量语义工作量；`vp run bench:m2:gate` 锁定 M2 单文件 diff、high-fan-out
impact 与有界 Resolver permutation comparison。两项门禁都使用确定性工作 counter 与精确结果基数；
wall-clock 测量只作为建议值。

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

M2-00 实现前报告保存在
[`baselines/m2-00-apple-m4-node24.json`](baselines/m2-00-apple-m4-node24.json)，解释与语义控制量见
[M2-00 基线文档](../docs/M2-00-BASELINE.zh-CN.md)。

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

阶段时间来自 Core，包括 parse、link、graph、check、resolve、emit 与 total。Point-edit case 的 changed、
affected、reused 与 recomputed counter 来自公共 `SessionMetrics` 契约。Fixture 生成、corpus 文件读取、
worker 启动、GC 和计时后的语义摘要均不进入操作耗时；所有 case 顺序运行。

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

`vp run bench:gate` 不比较跨机器墙钟时间，而是执行可移植的 M1 语义工作量门槛；详见
[`M1-PERFORMANCE-GATES.zh-CN.md`](../docs/M1-PERFORMANCE-GATES.zh-CN.md)。

## Workload

矩阵覆盖 small conformance、1k/10k wide graph、10k deep alias chain、fan-out、稀疏 Context、
8/10/12/14/15 维投影、override-heavy，以及一次影响并重算 12 个 Token 的 10k 增量 session；还覆盖
固定的 `dtcg-examples@1.1.3` 全部七个 Resolver，以及带 CSS emit 的代表性项目。

代表性项目是确定性生成并明确标记为 `synthetic` 的公开数据，不冒充真实客户项目。
`dtcg-examples` 由 Terrazzo 社区维护，它是生态互操作语料，不是 DTCG 官方 conformance suite，也不
代表跨工具性能结论。

M2-00 增加四项实现前的 change-intelligence 基线，只使用当前公开的 Snapshot、Query 和 Backend
preparation API：unchanged 双 Snapshot 构建、1,200 Token 分层项目的单文件编辑、2,000 路 fan-out
遍历，以及 10,000 entry 的 report 草案序列化。每个 sample 的 `changeIntelligence` 会记录 Snapshot
构建、双 Graph impact、Backend preparation、report 序列化、report byte 与语义工作量；peak RSS 仍按
上文所述使用隔离进程测量。

只运行 M2-00 基线：

```bash
vp run bench -- --profile quick \
  --case m2/unchanged/layered-1200 \
  --case m2/one-file-edit/layered-1200 \
  --case m2/high-fan-out/2000 \
  --case m2/report-serialization/10000 \
  --output artifacts/m2-00-quick.json
```

这些 case 只刻画 M2-01 将组合的原语；它们不是 `compareSnapshots()` 的实现，也不增加生产 CLI 命令。
