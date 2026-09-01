import { describe, expect, it } from "vite-plus/test";

import impactReportSchema from "../schema/impact-report-v1.schema.json" with { type: "json" };
import { compileDocuments } from "../src/compiler.js";
import { buildImpactReport, serializeImpactReport } from "../src/impact-report.js";
import { contextPredicateMatches } from "../src/predicate.js";
import { assertSchemaConformance } from "./support/schema-conformance.js";

function source(file: string, value: unknown) {
  return { file, content: typeof value === "string" ? value : JSON.stringify(value) };
}

describe("buildImpactReport", () => {
  it("maps source-owned Tokens and preserves direct and transitive impact", async () => {
    const snapshot = await compileDocuments([
      source("tokens/primitive.json", {
        primitive: { $type: "number", $value: 1 },
      }),
      source("tokens/semantic.json", {
        semantic: { $type: "number", $value: "{primitive}" },
      }),
      source("tokens/component.json", {
        component: { $type: "number", $value: "{semantic}" },
      }),
    ]);

    const first = buildImpactReport(snapshot, { documents: ["tokens/primitive.json"] });
    const second = buildImpactReport(snapshot, { documents: ["tokens/primitive.json"] });

    expect(first).toMatchObject({
      schemaVersion: "1",
      status: "complete",
      request: {
        documents: ["tokens/primitive.json"],
        sources: [{ document: "tokens/primitive.json", status: "matched", tokens: ["primitive"] }],
        tokens: ["primitive"],
        context: {},
      },
    });
    expect(first.impact.changed.map((entry) => entry.token)).toEqual(["primitive"]);
    expect(first.impact.directlyAffected.map((entry) => entry.token)).toEqual(["semantic"]);
    expect(first.impact.indirectlyAffected.map((entry) => entry.token)).toEqual(["component"]);
    expect(serializeImpactReport(first)).toBe(serializeImpactReport(second));
    expect(Object.isFrozen(first)).toBe(true);
    expect(() => assertSchemaConformance(first, impactReportSchema)).not.toThrow();
  });

  it("reports known empty and unknown sources explicitly", async () => {
    const snapshot = await compileDocuments([
      source("tokens/empty.json", {}),
      source("tokens/value.json", { value: { $type: "number", $value: 1 } }),
    ]);
    const report = buildImpactReport(snapshot, {
      documents: ["tokens/missing.json", "tokens/empty.json"],
    });

    expect(report.status).toBe("incomplete");
    expect(report.request.sources).toEqual([
      { document: "tokens/empty.json", status: "empty", tokens: [] },
      { document: "tokens/missing.json", status: "unknown", tokens: [] },
    ]);
    expect(report.impact.changed).toEqual([]);
  });

  it("retains Predicate regions without a Context and filters an explicit Context", async () => {
    const snapshot = await compileDocuments(
      [
        source("tokens/source.json", {
          source: { $type: "number", $value: 1 },
        }),
        source("tokens/consumer.json", {
          consumer: {
            $type: "number",
            $value: 0,
            $extensions: { "org.token-compiler.contexts": { "theme=dark": "{source}" } },
          },
        }),
      ],
      { contexts: { theme: { default: "light", values: ["light", "dark"] } } },
    );

    const all = buildImpactReport(snapshot, { documents: ["tokens/source.json"] });
    const dark = buildImpactReport(snapshot, {
      documents: ["tokens/source.json"],
      context: { theme: "dark" },
    });
    const light = buildImpactReport(snapshot, {
      documents: ["tokens/source.json"],
      context: { theme: "light" },
    });

    expect(all.impact.directlyAffected).toHaveLength(1);
    expect(
      contextPredicateMatches(all.impact.directlyAffected[0]!.condition, { theme: "dark" }),
    ).toBe(true);
    expect(
      contextPredicateMatches(all.impact.directlyAffected[0]!.condition, { theme: "light" }),
    ).toBe(false);
    expect(dark.impact.directlyAffected.map((entry) => entry.token)).toEqual(["consumer"]);
    expect(light.impact.directlyAffected).toEqual([]);
  });

  it("uses document ownership for inherited Tokens", async () => {
    const snapshot = await compileDocuments([
      source("tokens/base.json", {
        base: { $type: "number", value: { $value: 1 } },
      }),
      source("tokens/derived.json", {
        derived: { $extends: "{base}" },
      }),
    ]);
    const report = buildImpactReport(snapshot, { documents: ["tokens/derived.json"] });

    expect(report.request.tokens).toEqual(["derived.value"]);
    expect(report.impact.changed.map((entry) => entry.token)).toEqual(["derived.value"]);
  });

  it("covers alias, JSON Pointer, inheritance, and composite-field dependencies", async () => {
    const snapshot = await compileDocuments([
      source("tokens/roots.json", {
        value: { $type: "number", $value: 1 },
        curve: { $type: "cubicBezier", $value: [0.25, 0.1, 0.25, 1] },
        pointer: { $type: "number", $ref: "#/curve/$value/0" },
        color: {
          $type: "color",
          $value: {
            colorSpace: "srgb",
            components: [0, 0, 0],
            alpha: 1,
          },
        },
        base: { $type: "number", child: { $value: 1 } },
      }),
      source("tokens/consumers.json", {
        alias: { $type: "number", $value: "{value}" },
        shadow: {
          $type: "shadow",
          $value: {
            color: "{color}",
            offsetX: { value: 0, unit: "px" },
            offsetY: { value: 0, unit: "px" },
            blur: { value: 4, unit: "px" },
            spread: { value: 0, unit: "px" },
          },
        },
        derived: { $extends: "{base}" },
      }),
    ]);
    const report = buildImpactReport(snapshot, { documents: ["tokens/roots.json"] });

    expect(
      snapshot.query
        .graph()
        .map((edge) => edge.kind)
        .toSorted(),
    ).toEqual(["alias", "composite-field", "inheritance", "json-pointer"]);
    expect(report.impact.changed.map((entry) => entry.token)).toEqual([
      "base.child",
      "color",
      "curve",
      "pointer",
      "value",
    ]);
    expect(report.impact.directlyAffected.map((entry) => entry.token)).toEqual([
      "alias",
      "derived.child",
      "shadow",
    ]);
  });

  it("includes removed Tokens and base-only consumers from an optional base Snapshot", async () => {
    const [base, head] = await Promise.all([
      compileDocuments([
        source("tokens/removed.json", { removed: { $type: "number", $value: 1 } }),
        source("tokens/consumer.json", {
          consumer: { $type: "number", $value: "{removed}" },
        }),
      ]),
      compileDocuments([
        source("tokens/consumer.json", {
          consumer: { $type: "number", $value: 1 },
        }),
      ]),
    ]);
    const report = buildImpactReport(head, {
      base,
      documents: ["tokens/removed.json"],
    });

    expect(report.request.tokens).toEqual(["removed"]);
    expect(report.impact.changed).toEqual([
      expect.objectContaining({ token: "removed", sides: ["base"] }),
    ]);
    expect(report.impact.directlyAffected).toEqual([
      expect.objectContaining({ token: "consumer", sides: ["base"] }),
    ]);
  });

  it("fails closed for invalid Snapshots and invalid Context coverage", async () => {
    const invalid = await compileDocuments([source("tokens/invalid.json", "{")]);
    const invalidReport = buildImpactReport(invalid, {
      documents: ["tokens/invalid.json"],
    });
    expect(invalidReport).toMatchObject({
      status: "incomplete",
      coverage: { compared: [], omitted: [{ reason: "invalid-head" }] },
    });
    expect(invalidReport.diagnostics[0]).toMatchObject({
      side: "head",
      diagnostic: { code: "TOKEN_INVALID_JSON" },
    });

    const valid = await compileDocuments(
      [source("tokens/value.json", { value: { $type: "number", $value: 1 } })],
      { contexts: { theme: { default: "light", values: ["light", "dark"] } } },
    );
    const invalidContext = buildImpactReport(valid, {
      documents: ["tokens/value.json"],
      context: { theme: "unknown" },
    });
    expect(invalidContext.status).toBe("incomplete");
    expect(invalidContext.coverage.omitted).toEqual([
      expect.objectContaining({
        reason: "unsupported",
        detail: expect.stringContaining("unknown"),
      }),
    ]);
    expect(invalidContext.diagnostics).toEqual([
      expect.objectContaining({
        side: "comparison",
        diagnostic: expect.objectContaining({ code: "TOKEN_CONTEXT_UNKNOWN_VALUE" }),
      }),
    ]);
  });
});
