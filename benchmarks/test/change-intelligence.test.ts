import { readFile } from "node:fs/promises";

import { compileDocuments, parseTokenId } from "@tokenc/core";
import { describe, expect, it } from "vite-plus/test";

import { BENCHMARK_CASES } from "../fixtures.js";
import {
  LAYERED_CONTEXTS,
  LAYERED_REFERENCE_COUNT,
  LAYERED_TOKEN_COUNT,
  layeredSources,
} from "../fixtures/change-intelligence/layered.js";

const matrixUrl = new URL("../fixtures/change-intelligence/matrix.v1.json", import.meta.url);
const expectationUrl = new URL(
  "../fixtures/change-intelligence/layered-v1.expect.json",
  import.meta.url,
);
const snapshotSchemaUrl = new URL(
  "../../packages/core/schema/snapshot-diff-v1.schema.json",
  import.meta.url,
);
const impactSchemaUrl = new URL(
  "../../packages/core/schema/impact-report-v1.schema.json",
  import.meta.url,
);
const snapshotExampleUrl = new URL(
  "../../docs/schemas/examples/snapshot-diff-v1.example.json",
  import.meta.url,
);
const impactExampleUrl = new URL(
  "../../docs/schemas/examples/impact-report-v1.example.json",
  import.meta.url,
);

async function json(url: URL): Promise<unknown> {
  const value: unknown = JSON.parse(await readFile(url, "utf8"));
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError(`${label} must be an object`);
  return Object.fromEntries(Object.keys(value).map((key) => [key, Reflect.get(value, key)]));
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  return value;
}

function strings(value: unknown, label: string): readonly string[] {
  return array(value, label).map((entry) => string(entry, `${label} entry`));
}

function compactImpact(
  entries: readonly {
    readonly token: string;
    readonly condition: { readonly clauses: readonly object[] };
  }[],
) {
  return entries.map((entry) => ({
    token: entry.token,
    condition: entry.condition.clauses[0] ?? {},
  }));
}

describe("M2-00 change-intelligence evidence", () => {
  it("maps every required change category to an authored before/after case", async () => {
    const matrix = record(await json(matrixUrl), "fixture matrix");
    const cases = array(matrix.cases, "fixture cases").map((fixture) =>
      record(fixture, "fixture case"),
    );
    const required = [
      "added",
      "removed",
      "rename-unambiguous",
      "rename-ambiguous",
      "direct-value",
      "propagated-value",
      "type",
      "metadata",
      "dependency",
      "context-coverage",
      "mutually-exclusive-context",
      "invalid-base",
      "invalid-head",
      "backend-symbol",
      "backend-artifact-path",
      "configuration",
    ];
    const covered = new Set(cases.flatMap((fixture) => strings(fixture.categories, "categories")));

    expect(matrix.schemaVersion).toBe("1");
    expect(Object.keys(record(matrix.categoryFieldMap, "category field map")).toSorted()).toEqual(
      required.toSorted(),
    );
    expect(required.every((category) => covered.has(category))).toBe(true);
    expect(new Set(cases.map((fixture) => string(fixture.id, "fixture id"))).size).toBe(
      cases.length,
    );
    expect(
      cases.every((fixture) => {
        record(fixture.base, "base fixture");
        record(fixture.head, "head fixture");
        return Object.keys(record(fixture.expected, "fixture expectation")).length > 0;
      }),
    ).toBe(true);
  });

  it("records invalid sides and untrusted configuration as incomplete", async () => {
    const matrix = record(await json(matrixUrl), "fixture matrix");
    const cases = array(matrix.cases, "fixture cases").map((fixture) =>
      record(fixture, "fixture case"),
    );
    for (const id of ["invalid-base", "invalid-head", "trusted-configuration-change"]) {
      const fixture = cases.find((candidate) => candidate.id === id);
      expect(fixture?.expected).toMatchObject({
        status: "incomplete",
        policyVerdict: "unavailable",
      });
    }
    expect(
      cases.find((fixture) => fixture.id === "trusted-configuration-change")?.expected,
    ).toMatchObject({ historicalExecutableConfigRuns: 0 });
  });

  it("proves the layered fixture's exact direct and transitive impact", async () => {
    const expected = record(await json(expectationUrl), "layered expectation");
    const parameters = record(expected.parameters, "layered parameters");
    const expectedImpact = record(expected.expectedImpact, "layered impact");
    const [base, head] = await Promise.all([
      compileDocuments(layeredSources(), { contexts: LAYERED_CONTEXTS }),
      compileDocuments(layeredSources(true), { contexts: LAYERED_CONTEXTS }),
    ]);
    for (const snapshot of [base, head]) {
      expect(snapshot.status).toBe("valid");
      expect(snapshot.stats).toMatchObject({
        tokens: LAYERED_TOKEN_COUNT,
        references: LAYERED_REFERENCE_COUNT,
      });
    }
    expect(parameters).toMatchObject({
      totalTokens: LAYERED_TOKEN_COUNT,
      references: LAYERED_REFERENCE_COUNT,
    });

    const changedToken = parseTokenId(string(parameters.changedToken, "changed token"));
    for (const snapshot of [base, head]) {
      const impact = snapshot.query.impact([changedToken]);
      expect(compactImpact(impact.changed)).toEqual(expectedImpact.changed);
      expect(compactImpact(impact.directlyAffected)).toEqual(expectedImpact.directlyAffected);
      expect(compactImpact(impact.indirectlyAffected)).toEqual(expectedImpact.indirectlyAffected);
    }
  });

  it("registers all four pre-implementation baseline operations", () => {
    const cases = BENCHMARK_CASES.filter(
      (definition) => definition.group === "change-intelligence",
    );
    expect(cases.map((definition) => definition.id)).toEqual([
      "m2/unchanged/layered-1200",
      "m2/one-file-edit/layered-1200",
      "m2/high-fan-out/2000",
      "m2/report-serialization/10000",
    ]);
    expect(cases.every((definition) => definition.operation.outputTarget === "backend-plan")).toBe(
      true,
    );
  });

  it("keeps schemas strict and examples aligned with their top-level contracts", async () => {
    const pairs = [
      [
        snapshotSchemaUrl,
        snapshotExampleUrl,
        "https://tokenc.dev/schemas/snapshot-diff-v1.schema.json",
      ],
      [
        impactSchemaUrl,
        impactExampleUrl,
        "https://tokenc.dev/schemas/impact-report-v1.schema.json",
      ],
    ] as const;
    const loaded = await Promise.all(
      pairs.map(async ([schemaUrl, exampleUrl, schemaId]) => {
        const [schemaValue, exampleValue] = await Promise.all([json(schemaUrl), json(exampleUrl)]);
        return [schemaValue, exampleValue, schemaId] as const;
      }),
    );
    for (const [schemaValue, exampleValue, schemaId] of loaded) {
      const schema = record(schemaValue, "schema");
      const example = record(exampleValue, "example");
      expect(schema).toMatchObject({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
      });
      expect(schema.$id).toBe(schemaId);
      expect(Object.keys(example).toSorted()).toEqual(
        strings(schema.required, "required").toSorted(),
      );
      expect(example.schemaVersion).toBe("1");
    }
  });
});
