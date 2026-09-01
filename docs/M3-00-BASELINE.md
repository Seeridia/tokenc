# M3-00 IDE Edit-Loop Baseline

[简体中文](M3-00-BASELINE.zh-CN.md)

> Status: accepted M3-00 Gate 0 evidence. Measured 2026-09-01 on Apple M4, Node 24.20.0.

## Scope

This baseline characterizes the compiler primitives available before the M3 source index and
language server. It does not benchmark an LSP implementation. The five cases measure:

- cold Session construction plus representative Query projections for 1,200 Tokens;
- a warm one-file update in the same layered workspace;
- publication of invalid JSON followed by recovery to valid content;
- a warm edit with 2,000 direct consumers;
- acknowledgement of cancellation at the existing asynchronous loader boundary.

The source report is
[`m3-00-apple-m4-node24.json`](../benchmarks/baselines/m3-00-apple-m4-node24.json). It records the
clean source commit, fixture digests, raw samples, environment, R-7 distributions, compiler stages,
semantic counters, and hashes.

## Baseline results

The baseline profile used 5 warm-ups, 20 timing samples, and 3 isolated memory samples per case.
Times are milliseconds; memory is the median peak increase in MiB. Wall-clock values are advisory.

| Case                                      |  Wall p50 / p95 | Compiler total p50 / p95 | Peak increase p50 |
| ----------------------------------------- | --------------: | -----------------------: | ----------------: |
| Cold start, layered 1,200                 |   50.14 / 53.81 |            45.04 / 48.52 |          29.6 MiB |
| Warm one-file update, layered 1,200       |  48.91 / 141.28 |           43.97 / 130.81 |           5.0 MiB |
| Invalid JSON then recovery, layered 1,200 | 509.67 / 523.24 |            48.66 / 49.96 |          38.1 MiB |
| High fan-out update, 2,000 consumers      |  98.85 / 101.43 |            86.22 / 88.38 |          31.5 MiB |
| Active-loader cancellation                |   0.078 / 0.122 |            0.149 / 0.270 |           0.0 MiB |

`Compiler total` is the final committed Snapshot's stage total. The invalid/recovery wall time covers
both transactions, while its stage total describes the recovered commit. The one-file case contains
a visible group of high samples in this run, so its p95 is retained as observed rather than treated
as a stable latency budget.

## Semantic controls

Every timed sample must reproduce the following work and the checked-in semantic hash:

| Case                  | Tokens / references | Changed | Affected | Recomputed | Additional invariant                                                 |
| --------------------- | ------------------: | ------: | -------: | ---------: | -------------------------------------------------------------------- |
| Cold start            |         1,200 / 800 |   1,200 |    1,200 |      1,200 | 403 representative Query results                                     |
| Warm one-file update  |         1,200 / 800 |       1 |        3 |          3 | warm Session preserves Query semantics                               |
| Invalid then recovery |         1,200 / 800 |     400 |    1,200 |      1,200 | invalid revision publishes `TOKEN_INVALID_JSON`; revision 3 recovers |
| High fan-out          |       2,001 / 2,000 |       1 |    2,001 |      2,001 | exactly 2,000 usages remain visible                                  |
| Cancellation          |               1 / 0 |     n/a |      n/a |        n/a | abort leaves committed revision 1 unchanged                          |

The invalid transaction cannot be represented by the current incremental metrics, so the recovery
correctly takes the conservative full affected/recomputed path. The cancellation case deliberately
returns the last committed Snapshot only after proving the aborted transaction did not publish it as
a new revision.

## Decisions for M3-01 and M3-04

- M3-01 may begin: Gate 0 fixes semantic authority, trust, buffer precedence, UTF-16 positions,
  revision ordering, invalid-state behavior, and rename atomicity in RFC 0005 and the protocol corpus.
- The source index must preserve the warm update's `1 changed / 3 affected / 3 recomputed` behavior;
  editor queries must not force a second compiler graph.
- High fan-out is a legitimate full-recompute workload. M3-04 should add cooperative cancellation
  checkpoints around bounded high-cost compiler stages only after measuring the implemented server.
- Active-loader cancellation is already prompt, but proves nothing about interruption inside
  synchronous parse/link/graph/check/resolve work.
- Invalid/recovery and the noisy warm-update tail remain review targets. No hard wall-clock gate is
  set before matched CI evidence exists in M3-09.

## Reproduce

Run from a clean commit with the same runtime and hardware when replacing the accepted report:

```bash
vp run bench -- --profile baseline \
  --case m3/editor-cold-start/layered-1200 \
  --case m3/editor-one-file-update/layered-1200 \
  --case m3/editor-invalid-recovery/layered-1200 \
  --case m3/editor-high-fan-out/2000 \
  --case m3/editor-cancellation/active-load \
  --output benchmarks/baselines/m3-00-apple-m4-node24.json
```

Fixture-digest, semantic-counter, diagnostic, and semantic-hash drift are failures. Compare latency
only when the environment, fixture digest, profile, and sample counts match.
