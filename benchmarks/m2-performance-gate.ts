import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  compareResolverPermutations,
  compareSnapshots,
  compileDocuments,
  createCompilerSession,
  parseResolverDocument,
  planResolverPermutations,
  type ResolverDocument,
  type TokenSourceInput,
} from "@tokenc/core";

import {
  LAYERED_CONTEXTS,
  LAYERED_TOKEN_COUNT,
  layeredSources,
} from "./fixtures/change-intelligence/layered.js";

const BUDGETS = Object.freeze({
  oneFileDiff: Object.freeze({
    tokensPerRevision: LAYERED_TOKEN_COUNT,
    changedTokens: 1,
    directlyAffectedTokens: 1,
    indirectlyAffectedTokens: 1,
  }),
  highFanOutImpact: Object.freeze({
    consumers: 2_000,
    changedTokens: 1,
    directlyAffectedTokens: 2_000,
    indirectlyAffectedTokens: 0,
  }),
  boundedPermutationComparison: Object.freeze({
    estimatedCount: 12,
    comparisons: 12,
    maximumParseRecomputedAfterFirst: 2,
    maximumLinkRecomputedAfterFirst: 2,
  }),
});

function tokenCount(entries: readonly { readonly token: unknown }[]): number {
  return new Set(entries.map((entry) => entry.token)).size;
}

function exact(name: string, actual: number, expected: number): void {
  if (actual !== expected) throw new Error(`${name}=${actual}; expected ${expected}`);
}

function maximum(name: string, actual: number, expected: number): void {
  if (actual > expected) throw new Error(`${name}=${actual}; maximum ${expected}`);
}

function fanOutSources(value: number): readonly TokenSourceInput[] {
  return [
    {
      file: "/benchmark/change-intelligence/fan-out-base.tokens.json",
      content: JSON.stringify({ primitive: { $type: "number", $value: value } }),
    },
    {
      file: "/benchmark/change-intelligence/fan-out-consumers.tokens.json",
      content: JSON.stringify(
        Object.fromEntries(
          Array.from({ length: BUDGETS.highFanOutImpact.consumers }, (_, index) => [
            `consumer${index}`,
            { $type: "number", $value: "{primitive}" },
          ]),
        ),
      ),
    },
  ];
}

function permutationResolver(offset: number): ResolverDocument {
  const dimensions = [
    { name: "theme", values: ["light", "dark", "contrast"] },
    { name: "density", values: ["comfortable", "compact", "dense", "touch"] },
  ] as const;
  const sets = Object.fromEntries(
    dimensions.flatMap((dimension, dimensionIndex) =>
      dimension.values.map((value, valueIndex) => [
        `${dimension.name}-${value}`,
        {
          sources: [
            {
              [dimension.name]: {
                $type: "number",
                $value: offset + dimensionIndex * 100 + valueIndex,
              },
            },
          ],
        },
      ]),
    ),
  );
  const modifiers = Object.fromEntries(
    dimensions.map((dimension) => [
      dimension.name,
      {
        default: dimension.values[0],
        contexts: Object.fromEntries(
          dimension.values.map((value) => [value, [{ $ref: `#/sets/${dimension.name}-${value}` }]]),
        ),
      },
    ]),
  );
  const parsed = parseResolverDocument(
    JSON.stringify({
      version: "2025.10",
      sets,
      modifiers,
      resolutionOrder: dimensions.map((dimension) => ({
        $ref: `#/modifiers/${dimension.name}`,
      })),
    }),
    `/benchmark/change-intelligence/permutation-${offset}.resolver.json`,
  );
  if (!parsed.document) throw new Error("M2 permutation performance fixture must be valid");
  return parsed.document;
}

async function oneFileDiff() {
  const [base, head] = await Promise.all([
    compileDocuments(layeredSources(false), { contexts: LAYERED_CONTEXTS }),
    compileDocuments(layeredSources(true), { contexts: LAYERED_CONTEXTS }),
  ]);
  const diff = await compareSnapshots(base, head, {
    context: { theme: "light", density: "comfortable" },
  });
  const actual = {
    tokensPerRevision: head.stats.tokens,
    changedTokens: tokenCount(diff.impact.changed),
    directlyAffectedTokens: tokenCount(diff.impact.directlyAffected),
    indirectlyAffectedTokens: tokenCount(diff.impact.indirectlyAffected),
  };
  exact(
    "oneFileDiff.tokensPerRevision",
    actual.tokensPerRevision,
    BUDGETS.oneFileDiff.tokensPerRevision,
  );
  exact("oneFileDiff.changedTokens", actual.changedTokens, BUDGETS.oneFileDiff.changedTokens);
  exact(
    "oneFileDiff.directlyAffectedTokens",
    actual.directlyAffectedTokens,
    BUDGETS.oneFileDiff.directlyAffectedTokens,
  );
  exact(
    "oneFileDiff.indirectlyAffectedTokens",
    actual.indirectlyAffectedTokens,
    BUDGETS.oneFileDiff.indirectlyAffectedTokens,
  );
  return actual;
}

async function highFanOutImpact() {
  const [base, head] = await Promise.all([
    compileDocuments(fanOutSources(1)),
    compileDocuments(fanOutSources(2)),
  ]);
  const diff = await compareSnapshots(base, head);
  const actual = {
    consumers: head.stats.references,
    changedTokens: tokenCount(diff.impact.changed),
    directlyAffectedTokens: tokenCount(diff.impact.directlyAffected),
    indirectlyAffectedTokens: tokenCount(diff.impact.indirectlyAffected),
  };
  exact("highFanOutImpact.consumers", actual.consumers, BUDGETS.highFanOutImpact.consumers);
  exact(
    "highFanOutImpact.changedTokens",
    actual.changedTokens,
    BUDGETS.highFanOutImpact.changedTokens,
  );
  exact(
    "highFanOutImpact.directlyAffectedTokens",
    actual.directlyAffectedTokens,
    BUDGETS.highFanOutImpact.directlyAffectedTokens,
  );
  exact(
    "highFanOutImpact.indirectlyAffectedTokens",
    actual.indirectlyAffectedTokens,
    BUDGETS.highFanOutImpact.indirectlyAffectedTokens,
  );
  return actual;
}

async function boundedPermutationComparison() {
  const baseResolver = permutationResolver(0);
  const headResolver = permutationResolver(1_000);
  const plan = planResolverPermutations(baseResolver, {
    limit: BUDGETS.boundedPermutationComparison.estimatedCount,
  });
  const baseSession = createCompilerSession({ config: { resolver: baseResolver } });
  const headSession = createCompilerSession({ config: { resolver: headResolver } });
  try {
    const batch = await compareResolverPermutations(baseSession, headSession, plan);
    const later = batch.comparisons.slice(1);
    const actual = {
      estimatedCount: plan.estimatedCount,
      comparisons: batch.comparisons.length,
      maximumParseRecomputedAfterFirst: Math.max(
        ...later.flatMap((entry) => [
          entry.baseMetrics?.stages.parse.recomputed ?? Number.POSITIVE_INFINITY,
          entry.headMetrics?.stages.parse.recomputed ?? Number.POSITIVE_INFINITY,
        ]),
      ),
      maximumLinkRecomputedAfterFirst: Math.max(
        ...later.flatMap((entry) => [
          entry.baseMetrics?.stages.link.recomputed ?? Number.POSITIVE_INFINITY,
          entry.headMetrics?.stages.link.recomputed ?? Number.POSITIVE_INFINITY,
        ]),
      ),
    };
    exact(
      "boundedPermutationComparison.estimatedCount",
      actual.estimatedCount,
      BUDGETS.boundedPermutationComparison.estimatedCount,
    );
    exact(
      "boundedPermutationComparison.comparisons",
      actual.comparisons,
      BUDGETS.boundedPermutationComparison.comparisons,
    );
    maximum(
      "boundedPermutationComparison.maximumParseRecomputedAfterFirst",
      actual.maximumParseRecomputedAfterFirst,
      BUDGETS.boundedPermutationComparison.maximumParseRecomputedAfterFirst,
    );
    maximum(
      "boundedPermutationComparison.maximumLinkRecomputedAfterFirst",
      actual.maximumLinkRecomputedAfterFirst,
      BUDGETS.boundedPermutationComparison.maximumLinkRecomputedAfterFirst,
    );
    return actual;
  } finally {
    await Promise.all([baseSession.close(), headSession.close()]);
  }
}

/** Stable M2 CI gate over semantic work; wall-clock latency remains benchmark-only evidence. */
export async function runM2PerformanceGate(): Promise<void> {
  const [oneFile, fanOut, permutation] = await Promise.all([
    oneFileDiff(),
    highFanOutImpact(),
    boundedPermutationComparison(),
  ]);
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        milestone: "M2",
        budgets: BUDGETS,
        actual: {
          oneFileDiff: oneFile,
          highFanOutImpact: fanOut,
          boundedPermutationComparison: permutation,
        },
      },
      null,
      2,
    )}\n`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  void runM2PerformanceGate().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
