import { describe, expect, it } from "vite-plus/test";

import { compileDocuments } from "../../src/compiler.js";
import { IncrementalCompiler } from "../../src/incremental.js";
import { parseTokenDocument } from "../../src/parser.js";
import { parseTokenId } from "../../src/token-id.js";

const pointerSource = (value: number) => ({
  file: "/tokens/incremental-pointer.json",
  content: JSON.stringify({
    curve: { $type: "cubicBezier", $value: [value, 0, 1, 1] },
    firstX: { $type: "number", $ref: "#/curve/$value/0" },
  }),
});

describe("DTCG JSON Pointer references", () => {
  it.each(["#/base", "#/base/$value"])(
    "links a whole-token alias through %s and infers its type",
    (reference) => {
      const parsed = parseTokenDocument(
        JSON.stringify({
          base: { $type: "number", $value: 42 },
          alias: { $ref: reference },
        }),
        "/tokens/reference.json",
      );
      expect(parsed.diagnostics).toEqual([]);
      expect(parsed.tokens[1]).toMatchObject({
        id: "alias",
        type: "number",
        value: { kind: "reference", target: "base", pointer: reference },
        dependencies: ["base"],
      });
    },
  );

  it("resolves a component while retaining its owning token dependency", async () => {
    const result = await compileDocuments([
      {
        file: "/tokens/component.json",
        content: JSON.stringify({
          curve: { $type: "cubicBezier", $value: [0.25, 0.1, 0.25, 1] },
          firstX: { $type: "number", $ref: "#/curve/$value/0" },
        }),
      },
    ]);
    const firstX = result.graph.getToken(parseTokenId("firstX"));
    expect(result.success).toBe(true);
    expect(firstX?.value).toMatchObject({
      kind: "json-pointer-reference",
      pointer: "#/curve/$value/0",
      target: "curve",
      value: 0.25,
    });
    expect(firstX?.dependencies).toEqual(["curve"]);
    expect(result.graph.getDependents(parseTokenId("curve"))).toEqual(["firstX"]);
    expect(result.compilation.resolveToken(parseTokenId("firstX"))?.value).toBe(0.25);
  });

  it("supports escaped object keys", () => {
    const parsed = parseTokenDocument(
      JSON.stringify({
        "a/b~c": { $type: "number", $value: 3 },
        alias: { $ref: "#/a~1b~0c" },
      }),
      "/tokens/escaped.json",
    );
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.tokens[1]?.value).toMatchObject({ target: "a/b~c" });
  });

  it("resolves nested reference objects inside composites", () => {
    const parsed = parseTokenDocument(
      JSON.stringify({
        red: {
          $type: "color",
          $value: { colorSpace: "srgb", components: [1, 0, 0] },
        },
        border: {
          $type: "border",
          $value: {
            color: { $ref: "#/red/$value" },
            width: { value: 1, unit: "px" },
            style: "solid",
          },
        },
      }),
      "/tokens/nested.json",
    );
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.tokens[1]).toMatchObject({
      dependencies: ["red"],
      propertyReferences: [{ pointer: "#/red/$value", target: "red" }],
      value: { kind: "literal", value: { color: { colorSpace: "srgb" } } },
    });
  });

  it.each([
    ["#/missing", "DTCG_JSON_POINTER_NOT_FOUND"],
    ["#/curve/$value/4", "DTCG_JSON_POINTER_INVALID_ARRAY_INDEX"],
    ["#/bad~2escape", "DTCG_INVALID_JSON_POINTER"],
    ["#", "DTCG_JSON_POINTER_INVALID_TARGET"],
    ["other.json#/curve", "DTCG_UNSUPPORTED_EXTERNAL_JSON_POINTER"],
  ])("diagnoses %s with %s", (reference, code) => {
    const parsed = parseTokenDocument(
      JSON.stringify({
        curve: { $type: "cubicBezier", $value: [0, 0, 1, 1] },
        alias: { $type: "number", $ref: reference },
      }),
      "/tokens/invalid-pointer.json",
    );
    expect(parsed.diagnostics.map((diagnostic) => diagnostic.code)).toContain(code);
  });

  it("invalidates pointer dependents incrementally", async () => {
    const compiler = new IncrementalCompiler();
    await compiler.initialize([pointerSource(0)]);
    const update = await compiler.update(pointerSource(0.5));
    expect(update.affected).toEqual(new Set(["curve", "firstX"]));
    expect(update.result.compilation.resolveToken(parseTokenId("firstX"))?.value).toBe(0.5);
  });
});
