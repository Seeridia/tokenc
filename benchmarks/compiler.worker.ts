import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { benchmarkCase } from "./fixtures.js";
import { assertFiniteNumbers } from "./statistics.js";
import type {
  BenchmarkContextCycleCounters,
  BenchmarkCounters,
  BenchmarkExpectation,
  BenchmarkMemoryWorkerResponse,
  BenchmarkRunResult,
  BenchmarkStageTimings,
  BenchmarkTimingWorkerResponse,
  BenchmarkValidation,
} from "./types.js";

interface TimingOptions {
  readonly mode: "timing";
  readonly caseId: string;
  readonly warmups: number;
  readonly samples: number;
}

interface MemoryOptions {
  readonly mode: "memory";
  readonly caseId: string;
  readonly index: number;
}

type WorkerOptions = MemoryOptions | TimingOptions;

function integer(value: string | undefined, flag: string, minimum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum)
    throw new TypeError(`${flag} must be an integer greater than or equal to ${minimum}`);
  return parsed;
}

function parseArguments(arguments_: readonly string[]): WorkerOptions {
  const flags = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (!name?.startsWith("--") || value === undefined)
      throw new TypeError("Worker arguments must be --flag value pairs");
    flags.set(name, value);
  }
  const caseId = flags.get("--case");
  if (!caseId) throw new TypeError("--case is required");
  const mode = flags.get("--mode");
  if (mode === "timing")
    return {
      mode,
      caseId,
      warmups: integer(flags.get("--warmups"), "--warmups", 0),
      samples: integer(flags.get("--samples"), "--samples", 1),
    };
  if (mode === "memory")
    return { mode, caseId, index: integer(flags.get("--index"), "--index", 1) };
  throw new TypeError("--mode must be timing or memory");
}

function diagnosticCounts(result: BenchmarkRunResult): Readonly<Record<string, number>> {
  const counts = new Map<string, number>();
  for (const diagnostic of result.result.diagnostics) {
    if (diagnostic.severity !== "error") continue;
    counts.set(diagnostic.code, (counts.get(diagnostic.code) ?? 0) + 1);
  }
  return Object.fromEntries([...counts].toSorted(([left], [right]) => left.localeCompare(right)));
}

function contextCycles(result: BenchmarkRunResult): BenchmarkContextCycleCounters {
  return (
    result.result.stats.contextCycles ?? {
      candidateRegions: 0,
      relevantDimensions: 0,
      estimatedProjections: 0,
      estimateSaturated: false,
      enumeratedProjections: 0,
      earlyExits: 0,
      limitHits: 0,
    }
  );
}

function counters(result: BenchmarkRunResult): BenchmarkCounters {
  const incremental = result.incremental;
  return {
    tokens: result.result.stats.tokens,
    references: result.result.stats.references,
    contexts: result.result.stats.contexts,
    affectedTokens: result.result.stats.affectedTokens ?? incremental?.affectedTokens ?? null,
    checkedTokens: result.result.stats.checkedTokens ?? null,
    resolverComputations: result.result.compilation.resolver.computations,
    changedTokens: incremental?.changedTokens ?? null,
    recomputedTokens: incremental?.recomputedTokens ?? null,
    graphTouchedNodes: incremental?.graphTouchedNodes ?? null,
    graphTouchedEdges: incremental?.graphTouchedEdges ?? null,
    outputFiles: result.result.outputs.length,
    outputBytes: result.result.outputs.reduce(
      (bytes, output) => bytes + Buffer.byteLength(output.content),
      0,
    ),
    diagnostics: diagnosticCounts(result),
    contextCycles: contextCycles(result),
  };
}

function stageTimings(result: BenchmarkRunResult): BenchmarkStageTimings {
  return { ...result.result.stats.timings };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}

function semanticSha256(result: BenchmarkRunResult): `sha256:${string}` {
  const semantic = {
    success: result.result.success,
    diagnostics: result.result.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      severity: diagnostic.severity,
      message: diagnostic.message,
    })),
    tokens: result.result.compilation.tokens.map((token) => ({
      id: token.id,
      type: token.type,
      value: token.value,
      context: token.context,
      dependencies: token.dependencies,
    })),
    outputs: result.result.outputs
      .map((output) => ({ path: output.path, content: output.content }))
      .toSorted((left, right) => left.path.localeCompare(right.path)),
  };
  return `sha256:${createHash("sha256").update(stableJson(semantic)).digest("hex")}`;
}

function sameRecord(
  left: Readonly<Record<string, number>>,
  right: Readonly<Record<string, number>>,
): boolean {
  const leftEntries = Object.entries(left).toSorted(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right).toSorted(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

function assertExpected(
  expected: BenchmarkExpectation,
  result: BenchmarkRunResult,
  measured: BenchmarkCounters,
): void {
  const checks: readonly [string, number | boolean | undefined, number | boolean][] = [
    ["success", expected.success, result.result.success],
    ["tokens", expected.tokens, measured.tokens],
    ["references", expected.references, measured.references],
    ["contexts", expected.contexts, measured.contexts],
    ["affectedTokens", expected.affectedTokens, measured.affectedTokens ?? -1],
    ["recomputedTokens", expected.recomputedTokens, measured.recomputedTokens ?? -1],
    ["outputFiles", expected.outputFiles, measured.outputFiles],
  ];
  for (const [name, wanted, actual] of checks)
    if (wanted !== undefined && wanted !== actual)
      throw new Error(`Benchmark expectation ${name}=${wanted} failed; received ${actual}`);
  if (expected.diagnostics && !sameRecord(expected.diagnostics, measured.diagnostics))
    throw new Error(
      `Benchmark diagnostics changed: expected ${JSON.stringify(expected.diagnostics)}, received ${JSON.stringify(measured.diagnostics)}`,
    );
  for (const [name, wanted] of Object.entries(expected.contextCycles ?? {})) {
    const actual = Reflect.get(measured.contextCycles, name);
    if (wanted !== actual)
      throw new Error(
        `Benchmark Context-cycle expectation ${name}=${String(wanted)} failed; received ${String(actual)}`,
      );
  }
}

function validation(result: BenchmarkRunResult, measured: BenchmarkCounters): BenchmarkValidation {
  return {
    compilationSuccess: result.result.success,
    matchesExpected: true,
    semanticSha256: semanticSha256(result),
    diagnostics: measured.diagnostics,
  };
}

function forceGarbageCollection(): void {
  const collector = Reflect.get(globalThis, "gc");
  if (typeof collector !== "function")
    throw new Error("Benchmark worker requires Node.js --expose-gc");
  Reflect.apply(collector, globalThis, []);
}

async function runTiming(options: TimingOptions): Promise<BenchmarkTimingWorkerResponse> {
  const definition = benchmarkCase(options.caseId);
  if (!definition) throw new Error(`Unknown benchmark case: ${options.caseId}`);
  for (let index = 0; index < options.warmups; index += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Warm-ups must execute sequentially in the measured worker.
    const invocation = await definition.createInvocation();
    forceGarbageCollection();
    // oxlint-disable-next-line eslint/no-await-in-loop -- Parallel work would invalidate warm-up semantics.
    const result = await invocation.run();
    assertExpected(definition.expected, result, counters(result));
  }

  const samples = [];
  let expectedValidation: BenchmarkValidation | undefined;
  for (let index = 0; index < options.samples; index += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Samples are sequential to prevent workload interference.
    const invocation = await definition.createInvocation();
    forceGarbageCollection();
    const start = performance.now();
    // oxlint-disable-next-line eslint/no-await-in-loop -- Parallel samples would corrupt latency measurements.
    const result = await invocation.run();
    const wallMs = performance.now() - start;
    const measuredCounters = counters(result);
    assertExpected(definition.expected, result, measuredCounters);
    const currentValidation = validation(result, measuredCounters);
    if (
      expectedValidation &&
      currentValidation.semanticSha256 !== expectedValidation.semanticSha256
    )
      throw new Error(`Benchmark semantics changed between samples for ${definition.id}`);
    expectedValidation ??= currentValidation;
    samples.push({
      index: index + 1,
      wallMs,
      stagesMs: stageTimings(result),
      counters: measuredCounters,
    });
  }
  if (!expectedValidation) throw new Error("Timing worker produced no samples");
  return { mode: "timing", samples, validation: expectedValidation };
}

async function runMemory(options: MemoryOptions): Promise<BenchmarkMemoryWorkerResponse> {
  const definition = benchmarkCase(options.caseId);
  if (!definition) throw new Error(`Unknown benchmark case: ${options.caseId}`);
  const invocation = await definition.createInvocation();
  forceGarbageCollection();
  const baselineRssBytes = process.memoryUsage.rss();
  const preMaxRssBytes = process.resourceUsage().maxRSS * 1_024;
  const result = await invocation.run();
  const peakRssBytes = process.resourceUsage().maxRSS * 1_024;
  const measuredCounters = counters(result);
  assertExpected(definition.expected, result, measuredCounters);
  return {
    mode: "memory",
    sample: {
      index: options.index,
      baselineRssBytes,
      preMaxRssBytes,
      peakRssBytes,
      peakIncreaseBytes: Math.max(0, peakRssBytes - preMaxRssBytes),
    },
    validation: validation(result, measuredCounters),
    counters: measuredCounters,
  };
}

export async function runWorker(
  options: WorkerOptions,
): Promise<BenchmarkMemoryWorkerResponse | BenchmarkTimingWorkerResponse> {
  const response = options.mode === "timing" ? await runTiming(options) : await runMemory(options);
  assertFiniteNumbers(response);
  return response;
}

async function main(): Promise<void> {
  const response = await runWorker(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
