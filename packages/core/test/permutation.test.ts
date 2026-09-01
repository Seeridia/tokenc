import { describe, expect, it, vi } from "vite-plus/test";

import { ALL_TOKEN_TYPES, type BackendPlan, type TokenBackend } from "../src/backend.js";
import { compileDocuments } from "../src/compiler.js";
import { parseResolverDocument, type ResolverDocument } from "../src/dtcg/resolver-document.js";
import {
  compareResolverPermutations,
  compileResolverPermutations,
  planResolverPermutations,
} from "../src/permutation.js";
import { createCompilerSession } from "../src/session.js";
import { compareSnapshots, serializeSnapshotDiff } from "../src/snapshot-diff.js";
import { parseTokenId } from "../src/token-id.js";

function resolver(themeLight = 1, themeDark = 2): ResolverDocument {
  const parsed = parseResolverDocument(
    JSON.stringify({
      version: "2025.10",
      sets: {
        light: { sources: [{ themeValue: { $type: "number", $value: themeLight } }] },
        dark: { sources: [{ themeValue: { $type: "number", $value: themeDark } }] },
        comfortable: { sources: [{ densityValue: { $type: "number", $value: 10 } }] },
        compact: { sources: [{ densityValue: { $type: "number", $value: 8 } }] },
      },
      modifiers: {
        theme: {
          default: "light",
          contexts: {
            light: [{ $ref: "#/sets/light" }],
            dark: [{ $ref: "#/sets/dark" }],
          },
        },
        density: {
          default: "comfortable",
          contexts: {
            comfortable: [{ $ref: "#/sets/comfortable" }],
            compact: [{ $ref: "#/sets/compact" }],
          },
        },
      },
      resolutionOrder: [{ $ref: "#/modifiers/theme" }, { $ref: "#/modifiers/density" }],
    }),
    "/tokens/project.resolver.json",
  );
  if (!parsed.document) throw new Error("Expected a valid Resolver document");
  return parsed.document;
}

function largeResolver(dimensions: number): ResolverDocument {
  const sets = Object.fromEntries(
    Array.from({ length: dimensions }, (_, index) => [
      `set${index}`,
      { sources: [{ [`token${index}`]: { $type: "number", $value: index } }] },
    ]),
  );
  const modifiers = Object.fromEntries(
    Array.from({ length: dimensions }, (_, index) => [
      `dimension${index}`,
      {
        default: "off",
        contexts: {
          off: [{ $ref: `#/sets/set${index}` }],
          on: [{ $ref: `#/sets/set${index}` }],
        },
      },
    ]),
  );
  const parsed = parseResolverDocument(
    JSON.stringify({
      version: "2025.10",
      sets,
      modifiers,
      resolutionOrder: Object.keys(modifiers).map((name) => ({ $ref: `#/modifiers/${name}` })),
    }),
    "/tokens/large.resolver.json",
  );
  if (!parsed.document) throw new Error("Expected a valid Resolver document");
  return parsed.document;
}

const capabilities = {
  tokenTypes: ALL_TOKEN_TYPES,
  referenceStrategies: new Set(["resolve" as const]),
  contextMode: "none" as const,
  colorSpaces: "preserve" as const,
  composite: "native" as const,
};

function backend(events: string[], sharedPath: boolean): TokenBackend {
  return {
    id: "test",
    capabilities,
    prepare: (ir): BackendPlan => {
      const theme = ir.resolutionContext?.theme ?? "unknown";
      events.push(`prepare:${theme}`);
      return {
        backendId: "test",
        diagnostics: [],
        symbols: [],
        artifacts: [
          {
            id: "main",
            path: sharedPath ? "tokens.css" : `${theme}.css`,
            mediaType: "text/css",
            tokenIds: ir.tokens.map((token) => token.id),
            payload: theme,
          },
        ],
        data: null,
      };
    },
    emit: vi.fn<TokenBackend["emit"]>((plan: BackendPlan) => {
      const theme = String(plan.artifacts[0]?.payload);
      events.push(`emit:${theme}`);
      return plan.artifacts.map((artifact) => ({
        id: artifact.id,
        path: artifact.path,
        content: String(artifact.payload),
      }));
    }),
  };
}

describe("Resolver permutation planning", () => {
  it("requires a bound for multiple permutations and diagnoses invalid filters", () => {
    const missingLimit = planResolverPermutations(resolver());
    expect(missingLimit).toMatchObject({ status: "invalid", estimatedCount: 4 });
    expect(missingLimit.diagnostics.map((item) => item.code)).toEqual([
      "RESOLVER_PERMUTATION_LIMIT_REQUIRED",
    ]);
    expect([...missingLimit]).toEqual([]);

    const exceededLimit = planResolverPermutations(resolver(), { limit: 3 });
    expect(exceededLimit.status).toBe("invalid");
    expect(exceededLimit.diagnostics.map((item) => item.code)).toEqual([
      "RESOLVER_PERMUTATION_LIMIT_EXCEEDED",
    ]);
    expect([...exceededLimit]).toEqual([]);

    const invalid = planResolverPermutations(resolver(), {
      filters: { platform: "web", theme: "unknown" },
      limit: 0,
    });
    expect(invalid.status).toBe("invalid");
    expect(invalid.diagnostics.map((item) => item.code)).toEqual([
      "RESOLVER_PERMUTATION_UNKNOWN_FILTER",
      "RESOLVER_PERMUTATION_INVALID_FILTER",
      "RESOLVER_PERMUTATION_INVALID_LIMIT",
    ]);
  });

  it("applies exact filters and yields deterministic combinations lazily", () => {
    const plan = planResolverPermutations(resolver(), {
      filters: { theme: "dark" },
      limit: 2,
    });
    expect(plan).toMatchObject({
      schemaVersion: "1",
      status: "ready",
      estimatedCount: 2,
      estimateSaturated: false,
      filters: { theme: "dark" },
    });
    expect([...plan].map((item) => item.context)).toEqual([
      { theme: "dark", density: "comfortable" },
      { theme: "dark", density: "compact" },
    ]);
    expect([...plan]).toEqual([...plan]);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.dimensions)).toBe(true);
  });

  it("does not materialize a large Cartesian product during planning", () => {
    const plan = planResolverPermutations(largeResolver(24), { limit: 2 ** 24 });
    expect(plan).toMatchObject({ status: "ready", estimatedCount: 2 ** 24 });
    const iterator = plan[Symbol.iterator]();
    expect(iterator.next().value?.index).toBe(0);
    expect(iterator.next().value?.index).toBe(1);
  });
});

describe("Resolver permutation execution", () => {
  it("reuses one Session and matches independent cold compilations", async () => {
    const document = resolver();
    const plan = planResolverPermutations(document, { limit: 4 });
    const session = createCompilerSession({ config: { resolver: document } });
    const batch = await compileResolverPermutations(session, plan);

    expect(batch.status).toBe("complete");
    expect(batch.entries).toHaveLength(4);
    const coldSnapshots = await Promise.all(
      batch.entries.map((entry) =>
        compileDocuments([], {
          resolver: document,
          resolverInput: entry.permutation.context,
        }),
      ),
    );
    for (const [index, entry] of batch.entries.entries()) {
      const cold = coldSnapshots[index];
      expect(cold).toBeDefined();
      expect(entry.snapshot.status).toBe("valid");
      expect(entry.snapshot.query.resolve(parseTokenId("themeValue"))).toEqual(
        cold?.query.resolve(parseTokenId("themeValue")),
      );
      expect(entry.snapshot.query.resolve(parseTokenId("densityValue"))).toEqual(
        cold?.query.resolve(parseTokenId("densityValue")),
      );
    }
    expect(batch.entries[1]?.metrics?.stages.parse.hits).toBeGreaterThan(0);
    expect(batch.entries[1]?.metrics?.stages.link.hits).toBeGreaterThan(0);
    await session.close();
  });

  it("preflights every selected output before emitting and blocks cross-context collisions", async () => {
    const document = resolver();
    const plan = planResolverPermutations(document, { filters: { density: "compact" }, limit: 2 });
    const collisionEvents: string[] = [];
    const collidingBackend = backend(collisionEvents, true);
    const collisionSession = createCompilerSession({ config: { resolver: document } });
    const collision = await compileResolverPermutations(collisionSession, plan, {
      backends: [collidingBackend],
      emit: true,
    });

    expect(collision.status).toBe("incomplete");
    expect(collision.diagnostics.map((item) => item.code)).toContain(
      "RESOLVER_PERMUTATION_OUTPUT_COLLISION",
    );
    expect(collisionEvents).toEqual(["prepare:light", "prepare:dark"]);
    await collisionSession.close();

    const events: string[] = [];
    const uniqueBackend = backend(events, false);
    const session = createCompilerSession({ config: { resolver: document } });
    const emitted = await compileResolverPermutations(session, plan, {
      backends: [uniqueBackend],
      emit: true,
    });
    expect(emitted.status).toBe("complete");
    expect(events).toEqual(["prepare:light", "prepare:dark", "emit:light", "emit:dark"]);
    expect(
      emitted.entries.flatMap((entry) => entry.emission?.outputs ?? []).map((item) => item.path),
    ).toEqual(["light.css", "dark.css"]);
    await session.close();
  });

  it("compares matching contexts through Snapshot Diff v1 with cold-build parity", async () => {
    const baseResolver = resolver(1, 2);
    const headResolver = resolver(3, 4);
    const plan = planResolverPermutations(baseResolver, {
      filters: { density: "comfortable" },
      limit: 2,
    });
    const baseSession = createCompilerSession({ config: { resolver: baseResolver } });
    const headSession = createCompilerSession({ config: { resolver: headResolver } });
    const batch = await compareResolverPermutations(baseSession, headSession, plan, {
      baseLabel: "base",
      headLabel: "head",
    });

    expect(batch.status).toBe("complete");
    expect(batch.comparisons).toHaveLength(2);
    const coldDiffs = await Promise.all(
      batch.comparisons.map(async (entry) => {
        const [coldBase, coldHead] = await Promise.all([
          compileDocuments([], {
            resolver: baseResolver,
            resolverInput: entry.permutation.context,
          }),
          compileDocuments([], {
            resolver: headResolver,
            resolverInput: entry.permutation.context,
          }),
        ]);
        return compareSnapshots(coldBase, coldHead, {
          context: entry.permutation.context,
          baseLabel: "base",
          headLabel: "head",
        });
      }),
    );
    for (const [index, entry] of batch.comparisons.entries()) {
      const cold = coldDiffs[index];
      if (!cold) throw new Error(`Missing cold comparison ${index}`);
      expect(serializeSnapshotDiff(entry.diff)).toBe(serializeSnapshotDiff(cold));
    }
    expect(batch.comparisons[1]?.baseMetrics?.stages.parse.hits).toBeGreaterThan(0);
    expect(batch.comparisons[1]?.headMetrics?.stages.parse.hits).toBeGreaterThan(0);
    await Promise.all([baseSession.close(), headSession.close()]);
  });
});
