# Compiler benchmarks

[简体中文](README.zh-CN.md)

`vp run bench:gate` locks M1 incremental semantic work. `vp run bench:m2:gate` locks M2 one-file
diff, high-fan-out impact, and bounded Resolver permutation comparison. Both gates use deterministic
work counters and exact result cardinalities; wall-clock measurements remain advisory.

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

The M2-00 pre-implementation report is retained in
[`baselines/m2-00-apple-m4-node24.json`](baselines/m2-00-apple-m4-node24.json); interpretation and
semantic controls are recorded in the [M2-00 baseline document](../docs/M2-00-BASELINE.md).

The M3-00 pre-LSP edit-loop report is retained in
[`baselines/m3-00-apple-m4-node24.json`](baselines/m3-00-apple-m4-node24.json); its Gate 0 decisions
and semantic controls are recorded in the [M3-00 baseline document](../docs/M3-00-BASELINE.md).

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
The point-edit case derives changed, affected, reused, and recomputed counters from the public
`SessionMetrics` contract. Fixture generation, corpus file reads, worker startup, garbage
collection, and post-run semantic fingerprinting are outside the timed operation. Cases run
sequentially.

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
format validation but not for enforcing latency budgets. `vp run bench:gate` instead enforces the
portable M1 semantic-work budgets documented in
[`M1-PERFORMANCE-GATES.md`](../docs/M1-PERFORMANCE-GATES.md).

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

M2-00 adds four pre-implementation change-intelligence baselines. They use only the current public
Snapshot, Query, and Backend preparation APIs: unchanged two-Snapshot construction, a one-file edit
in a 1,200-token layered project, a 2,000-way fan-out traversal, and serialization of a 10,000-entry
draft report. Their `changeIntelligence` sample records Snapshot construction, dual-Graph impact,
Backend preparation, report serialization, report bytes, and semantic work counts. Peak RSS remains
the isolated-process measurement described above.

Run only the M2-00 baseline cases:

```bash
vp run bench -- --profile quick \
  --case m2/unchanged/layered-1200 \
  --case m2/one-file-edit/layered-1200 \
  --case m2/high-fan-out/2000 \
  --case m2/report-serialization/10000 \
  --output artifacts/m2-00-quick.json
```

These cases characterize the primitives that M2-01 will compose; they are not an implementation of
`compareSnapshots()` and do not add a production CLI command.

M3-00 adds five pre-LSP editor-loop cases: cold startup, a warm one-file update, invalid JSON plus
recovery, a 2,000-consumer high-fan-out update, and cancellation at the active loader boundary. Run
only those cases with:

```bash
vp run bench -- --profile quick \
  --case m3/editor-cold-start/layered-1200 \
  --case m3/editor-one-file-update/layered-1200 \
  --case m3/editor-invalid-recovery/layered-1200 \
  --case m3/editor-high-fan-out/2000 \
  --case m3/editor-cancellation/active-load \
  --output artifacts/m3-00-quick.json
```

These cases characterize current Core behavior. They neither create an LSP package nor claim
mid-parser cancellation.
