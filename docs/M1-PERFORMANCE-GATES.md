# M1 Performance Gates

[简体中文](M1-PERFORMANCE-GATES.zh-CN.md)

M1 separates portable CI budgets from machine-specific latency observations.

`vp run bench:gate` runs the retained 10,012-token point-edit case and enforces deterministic semantic
work budgets:

| Counter            | Budget   |
| ------------------ | -------- |
| changed Tokens     | ≤ 1      |
| affected Tokens    | ≤ 12     |
| reparsed documents | ≤ 1      |
| reused documents   | ≥ 2      |
| relinked documents | ≤ 2      |
| reused Link docs   | ≥ 1      |
| resolved Tokens    | ≤ 12     |
| reused resolutions | ≥ 10,000 |

These thresholds come from the M1-01 point-edit fixture and the M1-08b cache design. They detect
algorithmic invalidation regressions without comparing noisy wall-clock values across unrelated CI
hardware.

Wall time and memory remain evidence-bearing advisory measurements. On the same Apple M4 Pro and
Node 24 class used by M1-01, the original p95 was 187.12 ms. The post-cache local quick check on
2026-08-31 measured 124.21 ms wall p95 and 102.60 ms compiler-total p95. Release reviews compare a
fresh baseline profile only when runtime, CPU, fixture hash, and sampling method match.
