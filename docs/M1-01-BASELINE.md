# M1-01 Measurement Baseline

[简体中文](M1-01-BASELINE.zh-CN.md)

> Decision: **accepted; retain the 16,384-projection limit.**
>
> Measured on 2026-08-25 from clean implementation commit `2700a38` with Node.js 24.19.0 on an
> Apple M4 Pro. The complete machine-readable report is
> [`m1-01-apple-m4-pro-node24.json`](../benchmarks/baselines/m1-01-apple-m4-pro-node24.json).

## 1. What is now measurable

`CompilationResult.stats.timings` separates `parse`, `link`, `graph`, `check`, `resolve`, and `emit`
work and retains end-to-end `total`. Incremental initialization, update, and removal account for
their preparation work in the same stages.

`CompilationResult.stats.contextCycles` reports candidate strongly connected regions, relevant
dimensions, estimated and enumerated projections, static-cycle early exits, projection-limit hits,
and estimate saturation. These are observation-only counters: diagnostics and compilation results do
not depend on whether a caller reads them.

The benchmark harness emits versioned JSON and rejects a sample before reporting it when semantic
outcomes, expected diagnostics, token/reference counts, or incremental recomputation counters change.

## 2. Corpus and method

The retained baseline contains 21 cases:

- repository small-conformance input;
- synthetic 1k and 10k wide graphs, a 10k deep alias chain, and 2k fan-out;
- sparse Context, override-heavy, and 8/10/12/14/15-dimensional projection inputs;
- a 10,012-token incremental session whose point edit affects and recomputes 12 tokens;
- a deterministic 2,000-token synthetic representative project with CSS emission; and
- all seven Resolver documents from `dtcg-examples@1.1.3`.

The baseline profile ran five warm-ups, 20 sequential timing samples, and three isolated memory
samples per case: 420 timing samples and 63 fresh-process memory samples in total. Timings exclude
fixture construction and IO. Peak RSS is process-lifetime memory; `peakIncreaseBytes` subtracts the
pre-operation high-water mark and is the primary per-operation memory comparison. Percentiles use
Hyndman-Fan type 7 interpolation.

The retained JSON is 605,499 bytes and has SHA-256
`8bdaf6f533c5b07d44cd0603b6c1f9286798896f7fef3514ddd0af06338a9842`. It records the exact runtime,
CPU, fixture digests, raw samples, counters, and summaries. All 21 cases have
`validation.matchesExpected: true`.

## 3. Selected baseline results

These values are local evidence, not cross-machine budgets or a performance claim against Terrazzo.

| Case                                 |  Wall p50 |  Wall p95 | Peak RSS p50 | RSS increase p50 |
| ------------------------------------ | --------: | --------: | -----------: | ---------------: |
| 10k wide cold compile                | 346.23 ms | 350.95 ms |   184.78 MiB |        99.59 MiB |
| 10k deep alias cold compile          | 376.86 ms | 392.57 ms |   185.55 MiB |        99.16 MiB |
| 10k session, 12-token point edit     | 185.46 ms | 187.12 ms |   230.17 MiB |        40.66 MiB |
| 2k representative project + CSS emit |  40.39 ms |  42.60 ms |   117.36 MiB |        35.75 MiB |
| `dtcg-examples` GitHub Primer        | 251.30 ms | 254.04 ms |   123.13 MiB |        40.03 MiB |

The incremental point edit patched one graph node and zero edges, checked 12 tokens, and recomputed
12 tokens. Its median compiler-stage breakdown was:

|   Parse |      Link |    Graph |   Check |  Resolve |    Emit |     Total |
| ------: | --------: | -------: | ------: | -------: | ------: | --------: |
| 0.11 ms | 148.00 ms | 22.76 ms | 0.03 ms | 14.24 ms | 0.02 ms | 185.44 ms |

Full-batch relinking therefore accounts for about 80% of this edit, despite narrow checking and
resolution. M1-08b should prioritize linker ownership and invalidation before micro-optimizing the
checker.

## 4. Projection-limit decision

The two-token binary-dimension fixture produced:

| Dimensions | Estimated | Enumerated | Limit hits | Check p50 | Check p95 |
| ---------: | --------: | ---------: | ---------: | --------: | --------: |
|          8 |       256 |        256 |          0 |   0.55 ms |   0.60 ms |
|         10 |     1,024 |      1,024 |          0 |   2.02 ms |   2.30 ms |
|         12 |     4,096 |      4,096 |          0 |   7.72 ms |  13.21 ms |
|         14 |    16,384 |     16,384 |          0 |  31.02 ms |  32.93 ms |
|         15 |    32,768 |          0 |          1 |   0.04 ms |   0.06 ms |

Enumeration cost grows with the Context product even for a minimal two-token region. The current
16,384 limit still completes the boundary case while the next power of two fails deterministically
before enumeration. There is no evidence that raising it is safe for larger strongly connected
regions, and lowering it would reject the measured boundary without a demonstrated need. The limit
is therefore retained and protected by regression tests.

## 5. Reproduction and comparison

```bash
vp install --frozen-lockfile
vp run verify
vp run bench -- --profile baseline --output artifacts/benchmark-baseline.json
```

Compare results only when Node/V8, CPU, platform, architecture, profile, case ID, fixture SHA-256,
cache state, output target, and sample counts match. Keep raw samples and compare p50 and p95 together;
do not infer a regression from one run. The suite characterizes tokenc only. A future comparison with
Terrazzo requires an equivalent adapter, identical inputs and outputs, and repeated measurements.

## 6. Handoff

M1-01 supplies the evidence required to begin M1-02. The RFC bundle should use this baseline to:

1. define conditional-edge complexity accounting without weakening the projection safety bound;
2. assign parser, linker, graph, and resolver cache ownership to immutable Session revisions; and
3. preserve the report schema and semantic guards as the common comparison method for later M1 pull
   requests.
