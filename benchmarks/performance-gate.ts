import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { benchmarkCase } from "./fixtures.js";

const CASE_ID = "synthetic/incremental/point-edit/10000+12";

interface Budget {
  readonly maximum?: number;
  readonly minimum?: number;
}

const BUDGETS = {
  changedTokens: { maximum: 1 },
  affectedTokens: { maximum: 12 },
  parseRecomputed: { maximum: 1 },
  parseReused: { minimum: 2 },
  linkRecomputed: { maximum: 2 },
  linkReused: { minimum: 1 },
  resolveRecomputed: { maximum: 12 },
  resolveReused: { minimum: 10_000 },
} as const satisfies Readonly<Record<string, Budget>>;

function check(name: keyof typeof BUDGETS, value: number): void {
  const budget = BUDGETS[name];
  if ("maximum" in budget && value > budget.maximum)
    throw new Error(`${name}=${value} exceeds M1 budget ${budget.maximum}`);
  if ("minimum" in budget && value < budget.minimum)
    throw new Error(`${name}=${value} is below M1 reuse budget ${budget.minimum}`);
}

/** Stable CI gate over semantic work counters; wall-clock latency remains an advisory benchmark. */
export async function runPerformanceGate(): Promise<void> {
  const definition = benchmarkCase(CASE_ID);
  if (!definition) throw new Error(`Missing M1 performance case: ${CASE_ID}`);
  const result = await (await definition.createInvocation()).run();
  const metrics = result.session;
  if (!metrics) throw new Error(`Benchmark ${CASE_ID} did not report Session metrics`);
  const values = {
    changedTokens: metrics.changedTokens,
    affectedTokens: metrics.affectedTokens,
    parseRecomputed: metrics.stages.parse.recomputed,
    parseReused: metrics.stages.parse.reused,
    linkRecomputed: metrics.stages.link.recomputed,
    linkReused: metrics.stages.link.reused,
    resolveRecomputed: metrics.stages.resolve.recomputed,
    resolveReused: metrics.stages.resolve.reused,
  };
  check("changedTokens", values.changedTokens);
  check("affectedTokens", values.affectedTokens);
  check("parseRecomputed", values.parseRecomputed);
  check("parseReused", values.parseReused);
  check("linkRecomputed", values.linkRecomputed);
  check("linkReused", values.linkReused);
  check("resolveRecomputed", values.resolveRecomputed);
  check("resolveReused", values.resolveReused);
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        case: CASE_ID,
        baseline: "benchmarks/baselines/m1-01-apple-m4-pro-node24.json",
        budgets: BUDGETS,
        actual: values,
      },
      null,
      2,
    )}\n`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  void runPerformanceGate().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
