import { describe, expect, it } from "vite-plus/test";

import { compileDocuments } from "../../src/compiler.js";
import { parseTokenDocument } from "../../src/parser.js";

describe("DTCG reference-driven type inference", () => {
  it("infers a forward alias and a reference chain without source-order semantics", () => {
    const parsed = parseTokenDocument(
      JSON.stringify({
        a: { $value: "{b}" },
        b: { $value: "{c}" },
        c: { $type: "number", $value: 42 },
      }),
      "/tokens/inference.json",
    );
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.tokens.map((token) => [token.id, token.type])).toEqual([
      ["a", "number"],
      ["b", "number"],
      ["c", "number"],
    ]);
  });

  it("infers across already-loaded documents", async () => {
    const result = await compileDocuments([
      { file: "/tokens/alias.json", content: '{"alias":{"$value":"{base}"}}' },
      { file: "/tokens/base.json", content: '{"base":{"$type":"number","$value":1}}' },
    ]);
    expect(result.success).toBe(true);
    expect(result.graph.getToken(result.graph.tokens[0]!.id)?.type).toBe("number");
    expect(result.graph.tokens.map((token) => [token.id, token.type])).toEqual([
      ["alias", "number"],
      ["base", "number"],
    ]);
  });

  it("uses an explicit token type and lets the checker report a conflict", async () => {
    const result = await compileDocuments([
      {
        file: "/tokens/conflict.json",
        content: JSON.stringify({
          base: { $type: "number", $value: 1 },
          alias: { $type: "color", $value: "{base}" },
        }),
      },
    ]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "TOKEN_REFERENCE_TYPE_MISMATCH",
        related: [expect.objectContaining({ message: expect.stringContaining("base") })],
      }),
    );
  });

  it("prefers a reference target type over an inherited group type", () => {
    const parsed = parseTokenDocument(
      JSON.stringify({
        number: { $type: "number", $value: 1 },
        colors: { $type: "color", alias: { $value: "{number}" } },
      }),
      "/tokens/precedence.json",
    );
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.tokens.find((token) => token.id === "colors.alias")?.type).toBe("number");
  });

  it("diagnoses a missing target when its type is required", () => {
    const parsed = parseTokenDocument(
      '{"alias":{"$value":"{missing.token}"}}',
      "/tokens/missing.json",
    );
    expect(parsed.diagnostics[0]).toMatchObject({
      code: "TOKEN_CANNOT_INFER_TYPE",
      source: { file: "/tokens/missing.json" },
      related: [{ message: "The referenced token does not exist" }],
    });
  });

  it("keeps known-type cycles in the typed graph", async () => {
    const result = await compileDocuments([
      {
        file: "/tokens/known-cycle.json",
        content: JSON.stringify({
          a: { $type: "number", $value: "{b}" },
          b: { $value: "{a}" },
        }),
      },
    ]);
    expect(result.graph.tokens.map((token) => token.type)).toEqual(["number", "number"]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "TOKEN_CIRCULAR_REFERENCE",
    );
  });

  it("diagnoses an unknown-type cycle without recursion failure", () => {
    const parsed = parseTokenDocument(
      JSON.stringify({ a: { $value: "{b}" }, b: { $value: "{a}" } }),
      "/tokens/unknown-cycle.json",
    );
    expect(parsed.tokens).toEqual([]);
    expect(parsed.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "TOKEN_CANNOT_INFER_TYPE",
      "TOKEN_CIRCULAR_REFERENCE",
    ]);
  });

  it("coalesces an unknown-type JSON Pointer cycle into one structured report", () => {
    const parsed = parseTokenDocument(
      JSON.stringify({ a: { $ref: "#/b" }, b: { $ref: "#/a" } }),
      "/tokens/unknown-pointer-cycle.json",
    );
    expect(parsed.tokens).toEqual([]);
    expect(parsed.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "TOKEN_CANNOT_INFER_TYPE",
      "TOKEN_CIRCULAR_REFERENCE",
    ]);
    expect(parsed.diagnostics[0]?.related).toHaveLength(1);
  });

  it.each(["extra-black", "ultra-black"])("accepts the fontWeight alias %s", (weight) => {
    const parsed = parseTokenDocument(
      JSON.stringify({ weight: { $type: "fontWeight", $value: weight } }),
      "/tokens/font-weight.json",
    );
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.tokens[0]?.value).toMatchObject({ kind: "literal", value: weight });
  });
});
