# M1-01 测量基线

[English](M1-01-BASELINE.md)

> 结论：**验收通过，保留 16,384 次投影上限。**
>
> 2026-08-25 在干净实现提交 `2700a38` 上完成测量，环境为 Apple M4 Pro、Node.js 24.19.0。
> 完整机器可读报告见
> [`m1-01-apple-m4-pro-node24.json`](../benchmarks/baselines/m1-01-apple-m4-pro-node24.json)。

## 1. 已建立的测量面

`CompilationResult.stats.timings` 分别报告 `parse`、`link`、`graph`、`check`、`resolve`、`emit`
以及端到端 `total`；增量初始化、更新和删除的准备工作也按同一边界记账。

`CompilationResult.stats.contextCycles` 报告候选强连通区域、相关维度、估算与实际枚举投影数、静态
循环提前退出、投影上限命中和估算饱和。这些都是只读观测值；调用方是否读取它们不会改变 Diagnostic
或编译结果。

Benchmark 工具输出版本化 JSON。如果语义结果、预期 Diagnostic、Token/引用数或增量重算计数发生
变化，工具会先失败，不会生成貌似有效的性能结果。

## 2. 语料与方法

保留的基线包含 21 个 case：

- 仓库内 small conformance 输入；
- 合成的 1k/10k wide graph、10k deep alias chain 和 2k fan-out；
- sparse Context、override-heavy 与 8/10/12/14/15 维投影输入；
- 一次 point edit 仅影响并重算 12 个 Token 的 10,012 Token 增量 session；
- 一个确定性生成、执行 CSS emit 的 2,000 Token 代表性项目，并明确标记为 synthetic；
- 固定版本 `dtcg-examples@1.1.3` 的全部七个 Resolver。

Baseline profile 对每个 case 执行 5 次 warm-up、20 次串行 timing sample 和 3 次独立 memory
sample，总计 420 次计时和 63 个全新进程内存样本。Timing 不包含 fixture 构造与 IO。峰值 RSS 是进程
生命周期高水位；`peakIncreaseBytes` 扣除 operation 前高水位，是主要的单次操作内存比较值。百分位
采用 Hyndman-Fan type 7 插值。

保留的 JSON 大小为 605,499 byte，SHA-256 为
`8bdaf6f533c5b07d44cd0603b6c1f9286798896f7fef3514ddd0af06338a9842`。它包含精确运行时、CPU、
fixture digest、原始样本、counter 与汇总；21 个 case 的 `validation.matchesExpected` 全部为 `true`。

## 3. 关键基线结果

以下数据只是本机基线，不是跨机器预算，也不构成相对 Terrazzo 的性能声明。

| Case                             |  Wall p50 |  Wall p95 | Peak RSS p50 | RSS increase p50 |
| -------------------------------- | --------: | --------: | -----------: | ---------------: |
| 10k wide cold compile            | 346.23 ms | 350.95 ms |   184.78 MiB |        99.59 MiB |
| 10k deep alias cold compile      | 376.86 ms | 392.57 ms |   185.55 MiB |        99.16 MiB |
| 10k session、12 Token point edit | 185.46 ms | 187.12 ms |   230.17 MiB |        40.66 MiB |
| 2k 代表性项目 + CSS emit         |  40.39 ms |  42.60 ms |   117.36 MiB |        35.75 MiB |
| `dtcg-examples` GitHub Primer    | 251.30 ms | 254.04 ms |   123.13 MiB |        40.03 MiB |

增量 point edit 只 patch 1 个 Graph node、0 条 edge，检查 12 个 Token，并重算 12 个 Token。各阶段
中位数为：

|   Parse |      Link |    Graph |   Check |  Resolve |    Emit |     Total |
| ------: | --------: | -------: | ------: | -------: | ------: | --------: |
| 0.11 ms | 148.00 ms | 22.76 ms | 0.03 ms | 14.24 ms | 0.02 ms | 185.44 ms |

即使检查与求值范围已经很小，全批次 relink 仍约占这次编辑耗时的 80%。M1-08b 应先解决 Linker 的
ownership 与 invalidation，再考虑 Checker 的微优化。

## 4. 投影上限决定

两 Token、二值维度 fixture 的结果如下：

| 维度 | 估算投影 | 实际枚举 | Limit hit | Check p50 | Check p95 |
| ---: | -------: | -------: | --------: | --------: | --------: |
|    8 |      256 |      256 |         0 |   0.55 ms |   0.60 ms |
|   10 |    1,024 |    1,024 |         0 |   2.02 ms |   2.30 ms |
|   12 |    4,096 |    4,096 |         0 |   7.72 ms |  13.21 ms |
|   14 |   16,384 |   16,384 |         0 |  31.02 ms |  32.93 ms |
|   15 |   32,768 |        0 |         1 |   0.04 ms |   0.06 ms |

即使强连通区域只有两个 Token，枚举成本仍随 Context 乘积增长。当前 16,384 上限允许边界用例完成，
并使下一个 2 的幂（32,768）在枚举前确定性失败。现有数据不能证明更大的强连通区域适合提高上限，而
降低上限也会在没有必要性证据时拒绝已测边界。因此本阶段保留上限，并以回归测试锁定行为。

## 5. 复现与比较

```bash
vp install --frozen-lockfile
vp run verify
vp run bench -- --profile baseline --output artifacts/benchmark-baseline.json
```

只有 Node/V8、CPU、平台、架构、profile、case ID、fixture SHA-256、cache state、输出目标和样本数都
一致时，报告才适合比较。应保留原始样本并同时比较 p50 与 p95，不能用一次运行直接判断回归。这套工具
目前只刻画 tokenc；未来如需与 Terrazzo 对比，必须使用等价 adapter、完全相同的输入与输出，以及重复
测量。

## 6. 下一阶段输入

M1-01 已为 M1-02 提供证据。RFC bundle 应据此：

1. 定义 conditional edge 的复杂度记账方式，同时不弱化投影安全上限；
2. 将 Parser、Linker、Graph 与 Resolver cache ownership 分配到不可变 Session revision；
3. 保留报告 schema 与语义护栏，作为后续 M1 PR 的统一比较方法。
