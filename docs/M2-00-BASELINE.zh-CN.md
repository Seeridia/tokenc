# M2-00 变更智能基线

[English](M2-00-BASELINE.md)

> 状态：已接受的 M2-00 证据。测量于 2026-09-01，环境为 Apple M4、Node 24.20.0。

## 范围

这份基线刻画 M2 比较引擎实现前已经存在的公共原语。它不是 `compareSnapshots()` 的 benchmark，也不
声称与其他工具存在性能对比。四个 case 测量：

- 不可变 base/head Snapshot 的构建；
- 两侧 Graph 上具备 Context 条件的 impact 遍历；
- 两个有效 Snapshot 的 Backend `prepare()`，不调用 `emit()`；
- 确定性 report 草案序列化与字节数；
- 隔离进程的 peak RSS。

原始报告为
[`m2-00-apple-m4-node24.json`](../benchmarks/baselines/m2-00-apple-m4-node24.json)，其中包含 fixture
digest、全部原始 sample、精确环境数据、R-7 分布和语义 hash。

## 基线结果

baseline profile 对每个 case 使用 5 次 warm-up、20 次 timing sample 和 3 次隔离 memory sample。
时间单位为毫秒；内存为 peak increase 中位数（MiB）。墙钟结果只作参考。

| Case                        |  Wall p50 / p95 | Snapshot p50 | Impact p50 | Prepare p50 | Serialize p50 | Report 大小 | Peak increase p50 |
| --------------------------- | --------------: | -----------: | ---------: | ----------: | ------------: | ----------: | ----------------: |
| Unchanged layered 1,200     | 134.17 / 138.01 |        92.85 |      0.033 |       41.30 |         0.205 |   144,132 B |          73.0 MiB |
| One-file edit layered 1,200 | 134.46 / 136.75 |        92.30 |      0.148 |       41.47 |         0.219 |   145,773 B |          74.6 MiB |
| High fan-out 2,000          | 233.65 / 242.92 |       201.97 |     21.657 |        8.28 |         0.792 |   449,459 B |          82.9 MiB |
| Report serialization 10,000 |     3.07 / 3.58 |         0.37 |      0.009 |       0.045 |         1.548 | 1,249,607 B |           4.6 MiB |

## 语义控制量

以下 counter 发生漂移时，benchmark 会在记录 sample 前直接失败：

| Case                 | Base/head Token | Changed | Direct | Transitive | Backend plan | Report entry |
| -------------------- | --------------: | ------: | -----: | ---------: | -----------: | -----------: |
| Unchanged layered    |   1,200 / 1,200 |       0 |      0 |          0 |            2 |            0 |
| One-file edit        |   1,200 / 1,200 |       1 |      1 |          1 |            2 |            3 |
| High fan-out         |   2,001 / 2,001 |       1 |  2,000 |          0 |            2 |        2,001 |
| Report serialization |           1 / 1 |       0 |      0 |          0 |            2 |       10,000 |

分层 fixture 的人工期望保存在
[`layered-v1.expect.json`](../benchmarks/fixtures/change-intelligence/layered-v1.expect.json)。变化的
primitive 仅在 `theme=light` 时影响 `semantic.alias0`，然后仅在
`theme=light&density=comfortable` 时影响 `component.value0`。测试使用当前 Query API 验证这些数据，
不从未来 diff 输出反向生成期望。

## M2-01 如何使用本基线

M2-01 应在不削弱这些语义控制量的前提下增加比较工作。只有其结果模型与 benchmark workload 稳定后，
才能建立匹配环境下的延迟预算。在此之前：

- fixture digest 或语义 counter 不一致时失败；
- 非有限数值失败；
- report 大小与 peak RSS 用于回归审查；
- 墙钟变化只有在环境匹配时才可阻止合并。

复现命令见 [benchmark 指南](../benchmarks/README.zh-CN.md)。只有在有意替换已接受基线时，才应将
`--profile quick` 改为 `--profile baseline`，并把本报告路径传给 `--output`。
