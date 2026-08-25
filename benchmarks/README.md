# Compiler benchmarks

[简体中文](README.zh-CN.md)

The benchmark suite is a repeatable characterization tool for tokenc. It does not make a speed
claim against Terrazzo or another token tool.

Run the quick profile locally:

```bash
vp run bench -- --profile quick --output artifacts/benchmark-quick.json
```

Create a reviewable baseline with more samples:

```bash
vp run bench -- --profile baseline --output artifacts/benchmark-baseline.json
```

The M1-01 reference run is retained in
[`baselines/m1-01-apple-m4-pro-node24.json`](baselines/m1-01-apple-m4-pro-node24.json); its analysis
and scope decision are recorded in the [M1-01 baseline document](../docs/M1-01-BASELINE.md).

`quick` uses one warm-up, three timing samples, and one isolated memory sample per case. `baseline`
uses five warm-ups, twenty timing samples, and three isolated memory samples. An individual case can
be selected with a repeatable `--case <id>` option. `--list` prints the available IDs. Explicit
`--warmups`, `--samples`, and `--memory-samples` overrides are intended for harness testing and are
recorded in the report.

## Report contract

Reports conform to [`benchmark-report.v1.schema.json`](benchmark-report.v1.schema.json). They record
the source commit and dirty state, exact Node and V8 versions, CPU, platform, architecture, logical
core count, sampling method, fixture identity, raw samples, and R-7 p50/p95 summaries. Fixture
SHA-256 values use sorted logical paths and UTF-8 content; absolute installation paths never enter
the digest.

Every timed sample must match the case's semantic expectations. The harness rejects changed success
status, token/reference counts, incremental counters, or expected diagnostic counts. A semantic
digest also has to remain identical across samples. `validation.compilationSuccess` reports whether
the compiler accepted the input, while `validation.matchesExpected` reports benchmark validity;
some Context-limit and ecosystem cases intentionally expect compilation errors.

The stage values come from Core and cover parse, link, graph, check, resolve, emit, and total time.
Fixture generation, corpus file reads, worker startup, garbage collection, and post-run semantic
fingerprinting are outside the timed operation. Cases run sequentially.

## Memory method

Timing and memory measurements are separate. Timing samples for one case share a worker so runtime
warm-up is meaningful, but every invocation receives fresh compiler/session state. Every memory
sample starts a new Node process and executes one fresh invocation after fixture preparation and an
explicit garbage collection.

`peakRssBytes` is Node's process-lifetime `process.resourceUsage().maxRSS`, normalized from KiB to
bytes. It necessarily includes the Node runtime, imported harness, and the selected fixture's
prepared input. `baselineRssBytes` and `preMaxRssBytes` expose that baseline;
`peakIncreaseBytes = peakRssBytes - preMaxRssBytes` is the primary per-operation comparison. It can
be zero when setup established a higher watermark than the operation. Endpoint `heapUsed` snapshots
are deliberately not labeled as peak memory.

Compare reports only when Node version, CPU, platform, architecture, profile, case ID, fixture
digest, cache state, output target, and sample counts match. Shared hosted runners are useful for
format validation but not for enforcing latency budgets.

## Workloads

The suite includes small conformance, 1k/10k wide graphs, a 10k deep alias chain, fan-out, sparse
Context overrides, 8/10/12/14/15-dimensional projection cases, an override-heavy case, and a 10k
incremental session whose point edit affects and recomputes twelve tokens. It also includes all
seven Resolver documents from pinned `dtcg-examples@1.1.3` and a CSS-emitting representative
project.

The representative project is deterministically generated and explicitly marked `synthetic`; it is
not presented as customer data. The `dtcg-examples` package is maintained by the Terrazzo community
and is an ecosystem corpus, not an official DTCG conformance suite or a cross-tool performance
comparison.
