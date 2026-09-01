# M2-00 Change-Intelligence Baseline

[简体中文](M2-00-BASELINE.zh-CN.md)

> Status: accepted M2-00 evidence. Measured 2026-09-01 on Apple M4, Node 24.20.0.

## Scope

This baseline characterizes the public primitives available immediately before the M2 comparison
engine. It is not a benchmark of `compareSnapshots()` and does not claim cross-tool performance.
The four cases measure:

- construction of immutable base and head Snapshots;
- condition-aware impact traversal in both Graphs;
- Backend `prepare()` for both valid Snapshots, without `emit()`;
- deterministic draft-report serialization and byte size;
- isolated-process peak RSS.

The source report is
[`m2-00-apple-m4-node24.json`](../benchmarks/baselines/m2-00-apple-m4-node24.json). It contains fixture
digests, all raw samples, exact environment data, R-7 distributions, and semantic hashes.

## Baseline results

The baseline profile used 5 warm-ups, 20 timing samples, and 3 isolated memory samples per case.
Times are milliseconds; memory is the median peak increase in MiB. Wall-clock values are advisory.

| Case                        |  Wall p50 / p95 | Snapshot p50 | Impact p50 | Prepare p50 | Serialize p50 | Report size | Peak increase p50 |
| --------------------------- | --------------: | -----------: | ---------: | ----------: | ------------: | ----------: | ----------------: |
| Unchanged layered 1,200     | 134.17 / 138.01 |        92.85 |      0.033 |       41.30 |         0.205 |   144,132 B |          73.0 MiB |
| One-file edit layered 1,200 | 134.46 / 136.75 |        92.30 |      0.148 |       41.47 |         0.219 |   145,773 B |          74.6 MiB |
| High fan-out 2,000          | 233.65 / 242.92 |       201.97 |     21.657 |        8.28 |         0.792 |   449,459 B |          82.9 MiB |
| Report serialization 10,000 |     3.07 / 3.58 |         0.37 |      0.009 |       0.045 |         1.548 | 1,249,607 B |           4.6 MiB |

## Semantic controls

The benchmark fails before recording a sample if these counters drift:

| Case                 | Base/head Tokens | Changed | Direct | Transitive | Backend plans | Report entries |
| -------------------- | ---------------: | ------: | -----: | ---------: | ------------: | -------------: |
| Unchanged layered    |    1,200 / 1,200 |       0 |      0 |          0 |             2 |              0 |
| One-file edit        |    1,200 / 1,200 |       1 |      1 |          1 |             2 |              3 |
| High fan-out         |    2,001 / 2,001 |       1 |  2,000 |          0 |             2 |          2,001 |
| Report serialization |            1 / 1 |       0 |      0 |          0 |             2 |         10,000 |

The layered expectation is authored in
[`layered-v1.expect.json`](../benchmarks/fixtures/change-intelligence/layered-v1.expect.json). The
changed primitive affects `semantic.alias0` only when `theme=light`, then affects
`component.value0` only when `theme=light&density=comfortable`. This is checked against the current
Query API rather than inferred from future diff output.

## How M2-01 uses this baseline

M2-01 should add comparison work without weakening these semantic controls. It may establish matched
latency budgets only after its result model and benchmark workload are stable. Until then:

- fixture digest and semantic-counter mismatches fail;
- non-finite measurements fail;
- report size and peak RSS are recorded for regression review;
- wall-clock changes require a matched environment before they block a merge.

Reproduce the report with the command documented in the
[benchmark guide](../benchmarks/README.md), changing `--profile quick` to `--profile baseline` and
using this file path as `--output` only when intentionally replacing the accepted baseline.
