# M3-00 IDE 编辑循环基线

[English](M3-00-BASELINE.md)

> 状态：已接受的 M3-00 Gate 0 证据。于 2026-09-01 在 Apple M4、Node 24.20.0 上测量。

## 范围

本基线刻画 M3 source index 与 Language Server 实现之前已有的编译器原语，而不是 LSP 实现性能。
五个 case 分别测量：

- 1,200 Token 的冷 Session 构建与代表性 Query 投影；
- 同一个分层 workspace 中的一次 warm 单文件更新；
- 发布无效 JSON 后恢复为有效内容；
- 一个具有 2,000 个直接消费者的 warm 编辑；
- 在现有异步 loader 边界确认取消。

原始报告为
[`m3-00-apple-m4-node24.json`](../benchmarks/baselines/m3-00-apple-m4-node24.json)。其中记录 clean
source commit、fixture digest、原始样本、环境、R-7 分布、编译阶段、语义计数与 hash。

## 基线结果

baseline profile 对每个 case 使用 5 次 warm-up、20 次 timing sample 和 3 次隔离 memory sample。
时间单位为毫秒；内存为 peak increase 中位数（MiB）。Wall-clock 数值只作参考。

| Case                         |  Wall p50 / p95 | Compiler total p50 / p95 | Peak increase p50 |
| ---------------------------- | --------------: | -----------------------: | ----------------: |
| 冷启动，分层 1,200           |   50.14 / 53.81 |            45.04 / 48.52 |          29.6 MiB |
| Warm 单文件更新，分层 1,200  |  48.91 / 141.28 |           43.97 / 130.81 |           5.0 MiB |
| 无效 JSON 后恢复，分层 1,200 | 509.67 / 523.24 |            48.66 / 49.96 |          38.1 MiB |
| 高扇出更新，2,000 个消费者   |  98.85 / 101.43 |            86.22 / 88.38 |          31.5 MiB |
| Active-loader 取消           |   0.078 / 0.122 |            0.149 / 0.270 |           0.0 MiB |

`Compiler total` 是最终提交 Snapshot 的阶段总时长。无效/恢复 case 的 wall time 覆盖两个事务，阶段总时长
只描述恢复提交。本次单文件 case 出现一组明显高样本，因此原样保留其 p95，不把它当作稳定 latency budget。

## 语义控制量

每个 timing sample 都必须复现下列工作量与已签入的 semantic hash：

| Case            | Token / reference | Changed | Affected | Recomputed | 额外不变量                                               |
| --------------- | ----------------: | ------: | -------: | ---------: | -------------------------------------------------------- |
| 冷启动          |       1,200 / 800 |   1,200 |    1,200 |      1,200 | 403 个代表性 Query 结果                                  |
| Warm 单文件更新 |       1,200 / 800 |       1 |        3 |          3 | warm Session 保持 Query 语义                             |
| 无效后恢复      |       1,200 / 800 |     400 |    1,200 |      1,200 | 无效 revision 发布 `TOKEN_INVALID_JSON`；revision 3 恢复 |
| 高扇出          |     2,001 / 2,000 |       1 |    2,001 |      2,001 | 恰好仍可查询到 2,000 个 usage                            |
| 取消            |             1 / 0 |     n/a |      n/a |        n/a | abort 后已提交 revision 1 不变                           |

当前增量指标不能表示无效事务，因此恢复会正确进入保守的全 affected/recomputed 路径。取消 case 只有在证明
被中止事务没有把旧 Snapshot 作为新 revision 发布后，才返回上一次已提交 Snapshot。

## 对 M3-01 与 M3-04 的决定

- M3-01 可以开始：Gate 0 已通过 RFC 0005 与协议语料固定 semantic authority、trust、buffer
  precedence、UTF-16 position、revision ordering、invalid-state behavior 与 rename atomicity。
- Source index 必须保持 warm 更新的 `1 changed / 3 affected / 3 recomputed`；编辑器查询不得建立第二套
  compiler graph。
- 高扇出本来就是合法的全量重算 workload。M3-04 只能在测量实现后的 server 后，围绕有界高成本编译阶段
  添加 cooperative cancellation checkpoint。
- Active-loader 取消已经足够及时，但它不能证明同步 parse/link/graph/check/resolve 工作可被中断。
- 无效/恢复与 warm 更新的高尾延迟继续作为 review 目标；M3-09 获得匹配 CI 证据前不设 hard wall-clock gate。

## 复现

如要替换已接受报告，请在相同 runtime、hardware 与 clean commit 上运行：

```bash
vp run bench -- --profile baseline \
  --case m3/editor-cold-start/layered-1200 \
  --case m3/editor-one-file-update/layered-1200 \
  --case m3/editor-invalid-recovery/layered-1200 \
  --case m3/editor-high-fan-out/2000 \
  --case m3/editor-cancellation/active-load \
  --output benchmarks/baselines/m3-00-apple-m4-node24.json
```

Fixture digest、semantic counter、diagnostic 或 semantic hash 漂移都属于失败。只有 environment、fixture
digest、profile 与 sample count 匹配时才比较 latency。
