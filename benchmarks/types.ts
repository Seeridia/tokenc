import type { CompilationResult } from "@tokenc/core";

export type BenchmarkFixtureKind = "ecosystem" | "repository" | "synthetic";

export type BenchmarkFixtureGroup =
  | "deep"
  | "dtcg-examples"
  | "fan-out"
  | "incremental"
  | "multidimensional-context"
  | "override-heavy"
  | "representative"
  | "small"
  | "sparse-context"
  | "wide";

export type BenchmarkOperationKind = "cold-compile" | "incremental-update";

export interface BenchmarkFixtureMetadata {
  readonly kind: BenchmarkFixtureKind;
  readonly version: string;
  readonly sha256: `sha256:${string}`;
  readonly files: number;
  readonly bytes: number;
  readonly description: string;
  readonly parameters?: Readonly<Record<string, boolean | number | string>>;
  readonly package?: {
    readonly name: string;
    readonly version: string;
    readonly license: string;
  };
}

export interface BenchmarkOperationMetadata {
  readonly kind: BenchmarkOperationKind;
  readonly cacheState: "compiler-cold-runtime-warm" | "initialized-session";
  readonly outputTarget: "css" | "none";
  readonly ioIncluded: false;
}

export interface BenchmarkExpectation {
  readonly success: boolean;
  readonly tokens?: number;
  readonly references?: number;
  readonly contexts?: number;
  readonly affectedTokens?: number;
  readonly recomputedTokens?: number;
  readonly outputFiles?: number;
  readonly diagnostics?: Readonly<Record<string, number>>;
  readonly contextCycles?: Partial<BenchmarkContextCycleCounters>;
}

export interface BenchmarkIncrementalCounters {
  readonly changedTokens: number;
  readonly affectedTokens: number;
  readonly recomputedTokens: number;
  readonly graphTouchedNodes: number;
  readonly graphTouchedEdges: number;
}

export interface BenchmarkRunResult {
  readonly result: CompilationResult;
  readonly incremental?: BenchmarkIncrementalCounters;
}

/** A single-use operation. Runners create a fresh invocation for every warm-up or sample. */
export interface BenchmarkInvocation {
  run(): Promise<BenchmarkRunResult>;
}

export interface BenchmarkCaseDefinition {
  readonly id: string;
  readonly name: string;
  readonly group: BenchmarkFixtureGroup;
  readonly fixture: BenchmarkFixtureMetadata;
  readonly operation: BenchmarkOperationMetadata;
  readonly expected: BenchmarkExpectation;
  createInvocation(): Promise<BenchmarkInvocation>;
}

export interface BenchmarkDistribution {
  readonly count: number;
  readonly min: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

export interface BenchmarkStageTimings {
  readonly parse: number;
  readonly link: number;
  readonly graph: number;
  readonly check: number;
  readonly resolve: number;
  readonly emit: number;
  readonly total: number;
}

export interface BenchmarkContextCycleCounters {
  readonly candidateRegions: number;
  readonly relevantDimensions: number;
  readonly estimatedProjections: number;
  readonly estimateSaturated: boolean;
  readonly enumeratedProjections: number;
  readonly earlyExits: number;
  readonly limitHits: number;
}

export interface BenchmarkCounters {
  readonly tokens: number;
  readonly references: number;
  readonly contexts: number;
  readonly affectedTokens: number | null;
  readonly checkedTokens: number | null;
  readonly resolverComputations: number;
  readonly changedTokens: number | null;
  readonly recomputedTokens: number | null;
  readonly graphTouchedNodes: number | null;
  readonly graphTouchedEdges: number | null;
  readonly outputFiles: number;
  readonly outputBytes: number;
  readonly diagnostics: Readonly<Record<string, number>>;
  readonly contextCycles: BenchmarkContextCycleCounters;
}

export interface BenchmarkTimeSample {
  readonly index: number;
  readonly wallMs: number;
  readonly stagesMs: BenchmarkStageTimings;
  readonly counters: BenchmarkCounters;
}

export interface BenchmarkMemorySample {
  readonly index: number;
  readonly baselineRssBytes: number;
  readonly preMaxRssBytes: number;
  readonly peakRssBytes: number;
  readonly peakIncreaseBytes: number;
}

export interface BenchmarkValidation {
  readonly compilationSuccess: boolean;
  readonly matchesExpected: true;
  readonly semanticSha256: `sha256:${string}`;
  readonly diagnostics: Readonly<Record<string, number>>;
}

export interface BenchmarkCaseReport {
  readonly id: string;
  readonly name: string;
  readonly group: BenchmarkFixtureGroup;
  readonly fixture: BenchmarkFixtureMetadata;
  readonly operation: BenchmarkOperationMetadata;
  readonly validation: BenchmarkValidation;
  readonly timeSamples: readonly BenchmarkTimeSample[];
  readonly memorySamples: readonly BenchmarkMemorySample[];
  readonly summary: {
    readonly wallMs: BenchmarkDistribution;
    readonly stagesMs: Readonly<Record<keyof BenchmarkStageTimings, BenchmarkDistribution>>;
    readonly peakRssBytes: BenchmarkDistribution | null;
    readonly peakIncreaseBytes: BenchmarkDistribution | null;
  };
}

export interface BenchmarkReport {
  readonly $schema: string;
  readonly schemaVersion: 1;
  readonly suite: { readonly name: "tokenc-compiler"; readonly version: 1 };
  readonly generatedAt: string;
  readonly source: { readonly commit: string; readonly dirty: boolean };
  readonly environment: {
    readonly node: string;
    readonly v8: string;
    readonly platform: string;
    readonly arch: string;
    readonly cpuModel: string;
    readonly logicalCores: number;
    readonly totalMemoryBytes: number;
  };
  readonly methodology: {
    readonly profile: "baseline" | "quick";
    readonly warmupRuns: number;
    readonly sampleRuns: number;
    readonly memorySampleRuns: number;
    readonly percentileMethod: "linear-r7";
    readonly clock: "performance.now";
    readonly concurrency: 1;
    readonly fixturePreparationIncluded: false;
    readonly ioIncluded: false;
    readonly timingIsolation: "one-process-per-case";
    readonly memoryIsolation: "one-process-per-sample";
  };
  readonly cases: readonly BenchmarkCaseReport[];
}

export interface BenchmarkTimingWorkerResponse {
  readonly mode: "timing";
  readonly samples: readonly BenchmarkTimeSample[];
  readonly validation: BenchmarkValidation;
}

export interface BenchmarkMemoryWorkerResponse {
  readonly mode: "memory";
  readonly sample: BenchmarkMemorySample;
  readonly validation: BenchmarkValidation;
  readonly counters: BenchmarkCounters;
}
