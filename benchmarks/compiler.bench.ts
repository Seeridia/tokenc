import { execFile, execFileSync } from "node:child_process";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { arch, cpus, platform, totalmem } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { BENCHMARK_CASES } from "./fixtures.js";
import { assertFiniteNumbers, summarizeDistribution } from "./statistics.js";
import type {
  BenchmarkCaseDefinition,
  BenchmarkCaseReport,
  BenchmarkContextCycleCounters,
  BenchmarkCounters,
  BenchmarkDistribution,
  BenchmarkMemorySample,
  BenchmarkMemoryWorkerResponse,
  BenchmarkReport,
  BenchmarkStageTimings,
  BenchmarkTimeSample,
  BenchmarkTimingWorkerResponse,
  BenchmarkValidation,
} from "./types.js";

const executeFile = promisify(execFile);
const workerPath = fileURLToPath(new URL("./compiler.worker.ts", import.meta.url));
export const BENCHMARK_SCHEMA_URL =
  "https://raw.githubusercontent.com/Seeridia/tokenc/main/benchmarks/benchmark-report.v1.schema.json";

interface BenchmarkCliOptions {
  readonly profile: "baseline" | "quick";
  readonly warmupRuns: number;
  readonly sampleRuns: number;
  readonly memorySampleRuns: number;
  readonly caseIds: readonly string[];
  readonly output?: string;
  readonly list: boolean;
  readonly help: boolean;
}

const PROFILE_DEFAULTS = {
  baseline: { warmupRuns: 5, sampleRuns: 20, memorySampleRuns: 3 },
  quick: { warmupRuns: 1, sampleRuns: 3, memorySampleRuns: 1 },
} as const;

function integer(value: string | undefined, flag: string, minimum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum)
    throw new TypeError(`${flag} must be an integer greater than or equal to ${minimum}`);
  return parsed;
}

export function parseBenchmarkArguments(arguments_: readonly string[]): BenchmarkCliOptions {
  let profile: "baseline" | "quick" = "quick";
  let warmupRuns: number | undefined;
  let sampleRuns: number | undefined;
  let memorySampleRuns: number | undefined;
  let output: string | undefined;
  let list = false;
  let showHelp = false;
  const caseIds: string[] = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--") continue;
    if (argument === "--list") list = true;
    else if (argument === "--help" || argument === "-h") showHelp = true;
    else {
      const value = arguments_[index + 1];
      if (!value) throw new TypeError(`${argument} requires a value`);
      index += 1;
      if (argument === "--profile") {
        if (value !== "baseline" && value !== "quick")
          throw new TypeError("--profile must be baseline or quick");
        profile = value;
      } else if (argument === "--warmups") warmupRuns = integer(value, argument, 0);
      else if (argument === "--samples") sampleRuns = integer(value, argument, 1);
      else if (argument === "--memory-samples") memorySampleRuns = integer(value, argument, 0);
      else if (argument === "--case") caseIds.push(value);
      else if (argument === "--output") output = value;
      else throw new TypeError(`Unknown benchmark option: ${argument}`);
    }
  }
  const defaults = PROFILE_DEFAULTS[profile];
  return {
    profile,
    warmupRuns: warmupRuns ?? defaults.warmupRuns,
    sampleRuns: sampleRuns ?? defaults.sampleRuns,
    memorySampleRuns: memorySampleRuns ?? defaults.memorySampleRuns,
    caseIds,
    ...(output ? { output } : {}),
    list,
    help: showHelp,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberField(record: Record<string, unknown>, name: string): number {
  const value = record[name];
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new TypeError(`Worker field ${name} must be a finite number`);
  return value;
}

function integerOrNull(record: Record<string, unknown>, name: string): number | null {
  const value = record[name];
  if (value === null) return null;
  const parsed = numberField(record, name);
  if (!Number.isInteger(parsed) || parsed < 0)
    throw new TypeError(`Worker field ${name} must be a non-negative integer or null`);
  return parsed;
}

function diagnostics(value: unknown): Readonly<Record<string, number>> {
  if (!isRecord(value)) throw new TypeError("Worker diagnostics must be an object");
  const result: Record<string, number> = {};
  for (const [code, count] of Object.entries(value)) {
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1)
      throw new TypeError(`Worker diagnostic ${code} must be a positive integer`);
    result[code] = count;
  }
  return result;
}

function parseContextCycles(value: unknown): BenchmarkContextCycleCounters {
  if (!isRecord(value)) throw new TypeError("Worker contextCycles must be an object");
  const estimateSaturated = value.estimateSaturated;
  if (typeof estimateSaturated !== "boolean")
    throw new TypeError("Worker estimateSaturated must be boolean");
  return {
    candidateRegions: integerOrNull(value, "candidateRegions") ?? 0,
    relevantDimensions: integerOrNull(value, "relevantDimensions") ?? 0,
    estimatedProjections: integerOrNull(value, "estimatedProjections") ?? 0,
    estimateSaturated,
    enumeratedProjections: integerOrNull(value, "enumeratedProjections") ?? 0,
    earlyExits: integerOrNull(value, "earlyExits") ?? 0,
    limitHits: integerOrNull(value, "limitHits") ?? 0,
  };
}

function parseCounters(value: unknown): BenchmarkCounters {
  if (!isRecord(value)) throw new TypeError("Worker counters must be an object");
  return {
    tokens: integerOrNull(value, "tokens") ?? 0,
    references: integerOrNull(value, "references") ?? 0,
    contexts: integerOrNull(value, "contexts") ?? 0,
    affectedTokens: integerOrNull(value, "affectedTokens"),
    checkedTokens: integerOrNull(value, "checkedTokens"),
    resolverComputations: integerOrNull(value, "resolverComputations") ?? 0,
    changedTokens: integerOrNull(value, "changedTokens"),
    recomputedTokens: integerOrNull(value, "recomputedTokens"),
    graphTouchedNodes: integerOrNull(value, "graphTouchedNodes"),
    graphTouchedEdges: integerOrNull(value, "graphTouchedEdges"),
    outputFiles: integerOrNull(value, "outputFiles") ?? 0,
    outputBytes: integerOrNull(value, "outputBytes") ?? 0,
    diagnostics: diagnostics(value.diagnostics),
    contextCycles: parseContextCycles(value.contextCycles),
  };
}

function parseStages(value: unknown): BenchmarkStageTimings {
  if (!isRecord(value)) throw new TypeError("Worker stagesMs must be an object");
  return {
    parse: numberField(value, "parse"),
    link: numberField(value, "link"),
    graph: numberField(value, "graph"),
    check: numberField(value, "check"),
    resolve: numberField(value, "resolve"),
    emit: numberField(value, "emit"),
    total: numberField(value, "total"),
  };
}

function parseValidation(value: unknown): BenchmarkValidation {
  if (!isRecord(value)) throw new TypeError("Worker validation must be an object");
  if (typeof value.compilationSuccess !== "boolean")
    throw new TypeError("Worker validation.compilationSuccess must be boolean");
  if (value.matchesExpected !== true)
    throw new TypeError("Worker validation.matchesExpected must be true");
  if (
    typeof value.semanticSha256 !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.semanticSha256)
  )
    throw new TypeError("Worker validation.semanticSha256 is invalid");
  const semanticSha256 = `sha256:${value.semanticSha256.slice("sha256:".length)}` as const;
  return {
    compilationSuccess: value.compilationSuccess,
    matchesExpected: true,
    semanticSha256,
    diagnostics: diagnostics(value.diagnostics),
  };
}

function parseTimeSample(value: unknown): BenchmarkTimeSample {
  if (!isRecord(value)) throw new TypeError("Worker time sample must be an object");
  return {
    index: integerOrNull(value, "index") ?? 0,
    wallMs: numberField(value, "wallMs"),
    stagesMs: parseStages(value.stagesMs),
    counters: parseCounters(value.counters),
  };
}

function parseMemorySample(value: unknown): BenchmarkMemorySample {
  if (!isRecord(value)) throw new TypeError("Worker memory sample must be an object");
  return {
    index: integerOrNull(value, "index") ?? 0,
    baselineRssBytes: integerOrNull(value, "baselineRssBytes") ?? 0,
    preMaxRssBytes: integerOrNull(value, "preMaxRssBytes") ?? 0,
    peakRssBytes: integerOrNull(value, "peakRssBytes") ?? 0,
    peakIncreaseBytes: integerOrNull(value, "peakIncreaseBytes") ?? 0,
  };
}

function parseTimingResponse(output: string): BenchmarkTimingWorkerResponse {
  const parsed: unknown = JSON.parse(output);
  if (!isRecord(parsed) || parsed.mode !== "timing" || !Array.isArray(parsed.samples))
    throw new TypeError("Invalid timing worker response");
  return {
    mode: "timing",
    samples: parsed.samples.map(parseTimeSample),
    validation: parseValidation(parsed.validation),
  };
}

function parseMemoryResponse(output: string): BenchmarkMemoryWorkerResponse {
  const parsed: unknown = JSON.parse(output);
  if (!isRecord(parsed) || parsed.mode !== "memory")
    throw new TypeError("Invalid memory worker response");
  return {
    mode: "memory",
    sample: parseMemorySample(parsed.sample),
    validation: parseValidation(parsed.validation),
    counters: parseCounters(parsed.counters),
  };
}

async function worker(arguments_: readonly string[]): Promise<string> {
  const { stdout } = await executeFile(
    process.execPath,
    ["--expose-gc", "--import", "tsx", workerPath, ...arguments_],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 64 * 1_024 * 1_024,
      env: { ...process.env, NO_COLOR: "1" },
    },
  );
  return stdout.trim();
}

function sameValidation(left: BenchmarkValidation, right: BenchmarkValidation): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function summarizeStages(
  samples: readonly BenchmarkTimeSample[],
): Readonly<Record<keyof BenchmarkStageTimings, BenchmarkDistribution>> {
  const distribution = (stage: keyof BenchmarkStageTimings): BenchmarkDistribution =>
    summarizeDistribution(samples.map((sample) => sample.stagesMs[stage]));
  return {
    parse: distribution("parse"),
    link: distribution("link"),
    graph: distribution("graph"),
    check: distribution("check"),
    resolve: distribution("resolve"),
    emit: distribution("emit"),
    total: distribution("total"),
  };
}

async function runCase(
  definition: BenchmarkCaseDefinition,
  options: BenchmarkCliOptions,
): Promise<BenchmarkCaseReport> {
  process.stderr.write(`benchmark ${definition.id}\n`);
  const timing = parseTimingResponse(
    await worker([
      "--mode",
      "timing",
      "--case",
      definition.id,
      "--warmups",
      String(options.warmupRuns),
      "--samples",
      String(options.sampleRuns),
    ]),
  );
  if (timing.samples.length !== options.sampleRuns)
    throw new Error(`Timing worker returned an incorrect sample count for ${definition.id}`);
  const memorySamples: BenchmarkMemorySample[] = [];
  for (let index = 1; index <= options.memorySampleRuns; index += 1) {
    // Each call starts a fresh process so maxRSS is not inherited from another sample.
    const memory = parseMemoryResponse(
      // oxlint-disable-next-line eslint/no-await-in-loop -- Concurrent workers would contaminate peak RSS.
      await worker(["--mode", "memory", "--case", definition.id, "--index", String(index)]),
    );
    if (!sameValidation(timing.validation, memory.validation))
      throw new Error(`Memory and timing semantics differ for ${definition.id}`);
    memorySamples.push(memory.sample);
  }
  return {
    id: definition.id,
    name: definition.name,
    group: definition.group,
    fixture: definition.fixture,
    operation: definition.operation,
    validation: timing.validation,
    timeSamples: timing.samples,
    memorySamples,
    summary: {
      wallMs: summarizeDistribution(timing.samples.map((sample) => sample.wallMs)),
      stagesMs: summarizeStages(timing.samples),
      peakRssBytes:
        memorySamples.length > 0
          ? summarizeDistribution(memorySamples.map((sample) => sample.peakRssBytes))
          : null,
      peakIncreaseBytes:
        memorySamples.length > 0
          ? summarizeDistribution(memorySamples.map((sample) => sample.peakIncreaseBytes))
          : null,
    },
  };
}

function selectedCases(ids: readonly string[]): readonly BenchmarkCaseDefinition[] {
  if (ids.length === 0) return BENCHMARK_CASES;
  const selected = ids.map((id) => BENCHMARK_CASES.find((definition) => definition.id === id));
  const missing = ids.filter((_, index) => !selected[index]);
  if (missing.length > 0) throw new Error(`Unknown benchmark case: ${missing.join(", ")}`);
  return selected.filter((definition): definition is BenchmarkCaseDefinition =>
    Boolean(definition),
  );
}

function gitOutput(arguments_: readonly string[]): string {
  return execFileSync("git", arguments_, { encoding: "utf8" }).trim();
}

export async function runBenchmark(options: BenchmarkCliOptions): Promise<BenchmarkReport> {
  const cases: BenchmarkCaseReport[] = [];
  for (const definition of selectedCases(options.caseIds)) {
    // Benchmarks are intentionally sequential to avoid workload interference.
    // oxlint-disable-next-line eslint/no-await-in-loop -- Concurrent cases invalidate comparisons.
    cases.push(await runCase(definition, options));
  }
  const processors = cpus();
  const report: BenchmarkReport = {
    $schema: BENCHMARK_SCHEMA_URL,
    schemaVersion: 1,
    suite: { name: "tokenc-compiler", version: 1 },
    generatedAt: new Date().toISOString(),
    source: {
      commit: gitOutput(["rev-parse", "HEAD"]),
      dirty: gitOutput(["status", "--porcelain"]).length > 0,
    },
    environment: {
      node: process.version,
      v8: process.versions.v8,
      platform: platform(),
      arch: arch(),
      cpuModel: processors[0]?.model ?? "unknown",
      logicalCores: processors.length,
      totalMemoryBytes: totalmem(),
    },
    methodology: {
      profile: options.profile,
      warmupRuns: options.warmupRuns,
      sampleRuns: options.sampleRuns,
      memorySampleRuns: options.memorySampleRuns,
      percentileMethod: "linear-r7",
      clock: "performance.now",
      concurrency: 1,
      fixturePreparationIncluded: false,
      ioIncluded: false,
      timingIsolation: "one-process-per-case",
      memoryIsolation: "one-process-per-sample",
    },
    cases,
  };
  assertFiniteNumbers(report);
  return report;
}

async function writeReport(report: BenchmarkReport, output: string | undefined): Promise<void> {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (!output || output === "-") {
    process.stdout.write(serialized);
    return;
  }
  const target = resolve(output);
  const temporary = `${target}.${process.pid}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  try {
    await writeFile(temporary, serialized, "utf8");
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  process.stderr.write(`wrote ${target}\n`);
}

function helpText(): string {
  return `Usage: vp run bench -- [options]

Options:
  --profile quick|baseline   Sampling profile (default: quick)
  --case <id>                Run one case; repeat to select several cases
  --warmups <count>          Override warm-up count
  --samples <count>          Override timing sample count
  --memory-samples <count>   Override isolated memory sample count
  --output <path|->          Write JSON atomically to a file or to stdout
  --list                     List case IDs
  --help                     Show this help
`;
}

async function main(): Promise<void> {
  const options = parseBenchmarkArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(helpText());
    return;
  }
  if (options.list) {
    process.stdout.write(`${BENCHMARK_CASES.map((definition) => definition.id).join("\n")}\n`);
    return;
  }
  await writeReport(await runBenchmark(options), options.output);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
