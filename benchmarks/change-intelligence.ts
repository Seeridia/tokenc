import { performance } from "node:perf_hooks";

import { css } from "@tokenc/backend-css";
import {
  compileDocuments,
  parseTokenId,
  type CompilationSnapshot,
  type ContextDefinition,
  type ImpactedTokenV1,
  type TokenSourceInput,
  type ValidCompilationSnapshot,
} from "@tokenc/core";

import {
  LAYERED_CONTEXTS,
  LAYERED_REFERENCE_COUNT,
  LAYERED_TOKEN_COUNT,
  layeredSources,
} from "./fixtures/change-intelligence/layered.js";
import type {
  BenchmarkCaseDefinition,
  BenchmarkFixtureKind,
  BenchmarkFixtureMetadata,
  BenchmarkInvocation,
  BenchmarkRunResult,
} from "./types.js";

interface FixtureDescriptorInput {
  readonly kind: BenchmarkFixtureKind;
  readonly version: string;
  readonly description: string;
  readonly files: readonly { readonly path: string; readonly content: string }[];
  readonly parameters?: Readonly<Record<string, boolean | number | string>>;
}

type FixtureDescriptor = (input: FixtureDescriptorInput) => BenchmarkFixtureMetadata;

interface ChangeBaselineInput {
  readonly baseSources: readonly TokenSourceInput[];
  readonly headSources: readonly TokenSourceInput[];
  readonly contexts?: ContextDefinition;
  readonly changedTokens: readonly string[];
  readonly extraReportEntries?: number;
}

function singleUse(run: () => Promise<BenchmarkRunResult>): BenchmarkInvocation {
  let used = false;
  return {
    async run() {
      if (used) throw new Error("Benchmark invocation has already run");
      used = true;
      return run();
    },
  };
}

function valid(snapshot: CompilationSnapshot, side: "base" | "head"): ValidCompilationSnapshot {
  if (snapshot.status !== "valid")
    throw new Error(`M2-00 ${side} benchmark Snapshot must be valid`);
  return snapshot;
}

function mergeImpact(
  base: readonly ImpactedTokenV1[],
  head: readonly ImpactedTokenV1[],
): readonly object[] {
  const entries = new Map<
    string,
    { readonly token: string; readonly condition: ImpactedTokenV1["condition"]; sides: string[] }
  >();
  for (const [side, values] of [
    ["base", base],
    ["head", head],
  ] as const) {
    for (const value of values) {
      const key = `${value.token}\0${value.condition.key}`;
      const previous = entries.get(key);
      if (previous) previous.sides.push(side);
      else entries.set(key, { token: value.token, condition: value.condition, sides: [side] });
    }
  }
  return [...entries.values()]
    .map((entry) => ({
      token: entry.token,
      condition: entry.condition,
      sides: Object.freeze(entry.sides),
    }))
    .toSorted((left, right) =>
      left.token === right.token
        ? left.condition.key.localeCompare(right.condition.key)
        : left.token.localeCompare(right.token),
    );
}

function uniqueTokens(entries: readonly object[]): number {
  return new Set(entries.map((entry) => Reflect.get(entry, "token"))).size;
}

async function runChangeBaseline(input: ChangeBaselineInput): Promise<BenchmarkRunResult> {
  const compilationOptions = input.contexts ? { contexts: input.contexts } : {};
  const snapshotStart = performance.now();
  const base = valid(await compileDocuments(input.baseSources, compilationOptions), "base");
  const head = valid(await compileDocuments(input.headSources, compilationOptions), "head");
  const snapshotConstruction = performance.now() - snapshotStart;

  const roots = input.changedTokens.map(parseTokenId);
  const impactStart = performance.now();
  const baseImpact = base.query.impact(roots);
  const headImpact = head.query.impact(roots);
  const changed = mergeImpact(baseImpact.changed, headImpact.changed);
  const directlyAffected = mergeImpact(baseImpact.directlyAffected, headImpact.directlyAffected);
  const indirectlyAffected = mergeImpact(
    baseImpact.indirectlyAffected,
    headImpact.indirectlyAffected,
  );
  const impactTraversal = performance.now() - impactStart;

  const backendStart = performance.now();
  const backend = css({
    output: "tokens.css",
    references: "preserve",
    ...(input.contexts
      ? {
          selectors: {
            "theme=dark&density=comfortable": "[data-theme='dark']",
            "theme=light&density=compact": "[data-density='compact']",
            "theme=dark&density=compact": "[data-theme='dark'][data-density='compact']",
          },
        }
      : {}),
  });
  const [basePreparation, headPreparation] = await Promise.all([
    base.prepare([backend]),
    head.prepare([backend]),
  ]);
  const backendPreparation = performance.now() - backendStart;
  if (!basePreparation.success || !headPreparation.success)
    throw new Error("M2-00 baseline Backend preparation must succeed");

  const padding = Array.from({ length: input.extraReportEntries ?? 0 }, (_, index) => ({
    changeId: `baseline-${index.toString().padStart(5, "0")}`,
    kind: "direct-value",
    token: `serialization.entry${index}`,
    condition: {},
    sides: ["base", "head"],
  }));
  const report = {
    schemaVersion: "1",
    benchmarkModel: "m2-00-preimplementation-baseline",
    status: "complete",
    base: {
      sourceRevision: base.sourceRevision,
      configurationIdentity: base.configurationIdentity,
    },
    head: {
      sourceRevision: head.sourceRevision,
      configurationIdentity: head.configurationIdentity,
    },
    changes: [...changed.map((entry) => ({ kind: "direct-value", ...entry })), ...padding],
    impact: { changed, directlyAffected, indirectlyAffected },
    backendPlans: [...basePreparation.plans, ...headPreparation.plans].map((plan) => ({
      backendId: plan.backendId,
      symbols: plan.symbols.map((symbol) => ({ token: symbol.token, name: symbol.name })),
      artifacts: plan.artifacts.map((artifact) => ({ id: artifact.id, path: artifact.path })),
    })),
    diagnostics: [],
  };
  const reportStart = performance.now();
  const reportJson = JSON.stringify(report);
  const reportSerialization = performance.now() - reportStart;

  return {
    snapshot: head,
    changeIntelligence: {
      stagesMs: {
        snapshotConstruction,
        impactTraversal,
        backendPreparation,
        reportSerialization,
      },
      counters: {
        baseTokens: base.stats.tokens,
        headTokens: head.stats.tokens,
        changedTokens: uniqueTokens(changed),
        directlyAffectedTokens: uniqueTokens(directlyAffected),
        indirectlyAffectedTokens: uniqueTokens(indirectlyAffected),
        backendPlans: basePreparation.plans.length + headPreparation.plans.length,
        reportEntries:
          changed.length + directlyAffected.length + indirectlyAffected.length + padding.length,
        reportBytes: Buffer.byteLength(reportJson),
      },
      reportJson,
    },
  };
}

function prefixedFiles(
  side: "base" | "head",
  sources: readonly TokenSourceInput[],
): readonly { readonly path: string; readonly content: string }[] {
  return sources.map((entry) => ({
    path: `${side}/${entry.file.replace(/^\/benchmark\//u, "")}`,
    content: entry.content,
  }));
}

function fanOutSources(changed: boolean, count: number): readonly TokenSourceInput[] {
  return [
    {
      file: "/benchmark/change-intelligence/fan-out-base.tokens.json",
      content: JSON.stringify({
        primitive: { $type: "number", $value: changed ? 2 : 1 },
      }),
    },
    {
      file: "/benchmark/change-intelligence/fan-out-consumers.tokens.json",
      content: JSON.stringify(
        Object.fromEntries(
          Array.from({ length: count }, (_, index) => [
            `consumer${index}`,
            { $type: "number", $value: "{primitive}" },
          ]),
        ),
      ),
    },
  ];
}

function serializationSources(): readonly TokenSourceInput[] {
  return [
    {
      file: "/benchmark/change-intelligence/serialization.tokens.json",
      content: JSON.stringify({ seed: { $type: "number", $value: 1 } }),
    },
  ];
}

function caseDefinition(
  input: Omit<BenchmarkCaseDefinition, "createInvocation"> & {
    readonly baseline: ChangeBaselineInput;
  },
): BenchmarkCaseDefinition {
  return {
    id: input.id,
    name: input.name,
    group: input.group,
    fixture: input.fixture,
    operation: input.operation,
    expected: input.expected,
    async createInvocation() {
      return singleUse(() => runChangeBaseline(input.baseline));
    },
  };
}

export function changeIntelligenceBenchmarkCases(
  describeFixture: FixtureDescriptor,
): readonly BenchmarkCaseDefinition[] {
  const layeredBase = layeredSources(false);
  const layeredHead = layeredSources(true);
  const fanOutBase = fanOutSources(false, 2_000);
  const fanOutHead = fanOutSources(true, 2_000);
  const serializationBase = serializationSources();
  const serializationHead = serializationSources();
  const commonOperation = {
    cacheState: "compiler-cold-runtime-warm" as const,
    outputTarget: "backend-plan" as const,
    ioIncluded: false as const,
  };
  return [
    caseDefinition({
      id: "m2/unchanged/layered-1200",
      name: "M2 unchanged two-Snapshot baseline",
      group: "change-intelligence",
      fixture: describeFixture({
        kind: "synthetic",
        version: "m2-00-v1",
        description: "Two identical 1,200-token layered revisions with two Context dimensions",
        files: [...prefixedFiles("base", layeredBase), ...prefixedFiles("head", layeredBase)],
        parameters: { tokensPerRevision: LAYERED_TOKEN_COUNT, dimensions: 2 },
      }),
      operation: { ...commonOperation, kind: "change-intelligence-unchanged" },
      expected: {
        success: true,
        tokens: LAYERED_TOKEN_COUNT,
        references: LAYERED_REFERENCE_COUNT,
        outputFiles: 0,
        changeIntelligence: {
          baseTokens: LAYERED_TOKEN_COUNT,
          headTokens: LAYERED_TOKEN_COUNT,
          changedTokens: 0,
          directlyAffectedTokens: 0,
          indirectlyAffectedTokens: 0,
          backendPlans: 2,
          reportEntries: 0,
        },
      },
      baseline: {
        baseSources: layeredBase,
        headSources: layeredBase,
        contexts: LAYERED_CONTEXTS,
        changedTokens: [],
      },
    }),
    caseDefinition({
      id: "m2/one-file-edit/layered-1200",
      name: "M2 one-file layered impact baseline",
      group: "change-intelligence",
      fixture: describeFixture({
        kind: "synthetic",
        version: "m2-00-v1",
        description:
          "One primitive edit across a 1,200-token primitive/semantic/component hierarchy",
        files: [...prefixedFiles("base", layeredBase), ...prefixedFiles("head", layeredHead)],
        parameters: { tokensPerRevision: LAYERED_TOKEN_COUNT, changedFiles: 1, dimensions: 2 },
      }),
      operation: { ...commonOperation, kind: "change-intelligence-one-file-edit" },
      expected: {
        success: true,
        tokens: LAYERED_TOKEN_COUNT,
        references: LAYERED_REFERENCE_COUNT,
        outputFiles: 0,
        changeIntelligence: {
          baseTokens: LAYERED_TOKEN_COUNT,
          headTokens: LAYERED_TOKEN_COUNT,
          changedTokens: 1,
          directlyAffectedTokens: 1,
          indirectlyAffectedTokens: 1,
          backendPlans: 2,
          reportEntries: 3,
        },
      },
      baseline: {
        baseSources: layeredBase,
        headSources: layeredHead,
        contexts: LAYERED_CONTEXTS,
        changedTokens: ["primitive.scale0"],
      },
    }),
    caseDefinition({
      id: "m2/high-fan-out/2000",
      name: "M2 2,000-way dual-Graph impact baseline",
      group: "change-intelligence",
      fixture: describeFixture({
        kind: "synthetic",
        version: "m2-00-v1",
        description: "One changed primitive referenced by 2,000 direct consumers on both sides",
        files: [...prefixedFiles("base", fanOutBase), ...prefixedFiles("head", fanOutHead)],
        parameters: { tokensPerRevision: 2_001, directConsumers: 2_000 },
      }),
      operation: { ...commonOperation, kind: "change-intelligence-high-fan-out" },
      expected: {
        success: true,
        tokens: 2_001,
        references: 2_000,
        outputFiles: 0,
        changeIntelligence: {
          baseTokens: 2_001,
          headTokens: 2_001,
          changedTokens: 1,
          directlyAffectedTokens: 2_000,
          indirectlyAffectedTokens: 0,
          backendPlans: 2,
          reportEntries: 2_001,
        },
      },
      baseline: {
        baseSources: fanOutBase,
        headSources: fanOutHead,
        changedTokens: ["primitive"],
      },
    }),
    caseDefinition({
      id: "m2/report-serialization/10000",
      name: "M2 10,000-entry report serialization baseline",
      group: "change-intelligence",
      fixture: describeFixture({
        kind: "synthetic",
        version: "m2-00-v1",
        description: "One-token snapshots plus a deterministic 10,000-entry draft report payload",
        files: [
          ...prefixedFiles("base", serializationBase),
          ...prefixedFiles("head", serializationHead),
          {
            path: "report-shape.json",
            content: JSON.stringify({ entries: 10_000, schemaVersion: "1" }),
          },
        ],
        parameters: { tokensPerRevision: 1, reportEntries: 10_000 },
      }),
      operation: {
        ...commonOperation,
        kind: "change-intelligence-report-serialization",
      },
      expected: {
        success: true,
        tokens: 1,
        references: 0,
        outputFiles: 0,
        changeIntelligence: {
          baseTokens: 1,
          headTokens: 1,
          changedTokens: 0,
          directlyAffectedTokens: 0,
          indirectlyAffectedTokens: 0,
          backendPlans: 2,
          reportEntries: 10_000,
        },
      },
      baseline: {
        baseSources: serializationBase,
        headSources: serializationHead,
        changedTokens: [],
        extraReportEntries: 10_000,
      },
    }),
  ];
}
