import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { checkTokenGraph, suggestTokenIds } from "../src/checker.js";
import { TokenGraph } from "../src/graph.js";
import type { TokenId } from "../src/model.js";
import { parseTokenDocument } from "../src/parser.js";

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`fixtures/${name}`, import.meta.url)), "utf8");
const diagnostics = (name: string) =>
  checkTokenGraph(new TokenGraph(parseTokenDocument(fixture(name), name).tokens));

describe("type checker", () => {
  it("accepts same-type alias chains", () =>
    expect(diagnostics("aliases/tokens.json")).toEqual([]));

  it("rejects cross-type references with related source", () => {
    const result = diagnostics("types/invalid.json");
    expect(result[0]).toMatchObject({
      code: "TOKEN_REFERENCE_TYPE_MISMATCH",
      related: [{ source: { file: "types/invalid.json" } }],
    });
  });

  it("suggests nearby unknown token IDs", () => {
    const result = diagnostics("invalid/unknown.json");
    expect(result[0]).toMatchObject({
      code: "TOKEN_UNKNOWN_REFERENCE",
      suggestions: ["color.blue.600", "color.blue.700"],
    });
  });

  it("reports cycle paths and source locations", () => {
    const result = diagnostics("cycles/tokens.json");
    expect(result[0]?.code).toBe("TOKEN_CIRCULAR_REFERENCE");
    expect(result[0]?.message).toContain("a\n    └── b\n        └── c\n            └── a");
    expect(result[0]?.source?.line).toBe(2);
  });

  it("ranks same-prefix suggestions first", () => {
    expect(
      suggestTokenIds(
        "color.blue.650" as TokenId,
        ["space.650", "color.blue.600", "color.red.650"] as TokenId[],
        1,
      ),
    ).toEqual(["color.blue.600"]);
  });
});
