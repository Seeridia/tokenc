# M1 性能门槛

[English](M1-PERFORMANCE-GATES.md)

M1 将可移植的 CI budget 与依赖具体机器的延迟观测分开。

`vp run bench:gate` 运行保留的 10,012 Token point-edit case，并执行确定性的语义工作量门槛：

| Counter               | 门槛     |
| --------------------- | -------- |
| changed Token         | ≤ 1      |
| affected Token        | ≤ 12     |
| 重新 parse 的文档     | ≤ 1      |
| 复用的文档            | ≥ 2      |
| 重新 link 的文档      | ≤ 2      |
| 复用的 Link 文档      | ≥ 1      |
| 重新 resolve 的 Token | ≤ 12     |
| 复用的 resolution     | ≥ 10,000 |

这些门槛来自 M1-01 point-edit fixture 与 M1-08b cache 设计，可以在不比较不同 CI 硬件噪声耗时的情况下
发现算法级 invalidation 回归。

墙钟时间与内存仍作为有证据的建议性指标。在 M1-01 相同级别的 Apple M4 Pro 与 Node 24 环境中，原始
p95 为 187.12 ms；2026-08-31 的 cache 后本地 quick check 测得 wall p95 124.21 ms、compiler-total p95
102.60 ms。Release review 只有在 runtime、CPU、fixture hash 与采样方法一致时才比较新的 baseline
profile。
