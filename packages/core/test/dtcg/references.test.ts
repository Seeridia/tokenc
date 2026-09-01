import { describe, expect, it } from "vite-plus/test";

import { compileDocumentsInternal as compileDocuments } from "../../src/compiler.js";
import { parseTokenDocument } from "../../src/parser.js";
import { createCompilerSession } from "../../src/session.js";
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
        dependencyOccurrences: [
          { target: "base", kind: "json-pointer", fieldPath: [], sourceOrder: 0 },
        ],
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
    expect(firstX?.dependencyOccurrences.map((occurrence) => occurrence.target)).toEqual(["curve"]);
    expect(result.graph.getIncomingEdges(parseTokenId("curve")).map((edge) => edge.from)).toEqual([
      "firstX",
    ]);
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
      dependencyOccurrences: [{ target: "red", kind: "json-pointer", fieldPath: ["color"] }],
      value: { kind: "literal", value: { color: { colorSpace: "srgb" } } },
    });
  });

  it("diagnoses a missing nested curly reference instead of silently dropping its token", async () => {
    const result = await compileDocuments([
      {
        file: "/tokens/nested-missing.json",
        content: JSON.stringify({
          border: {
            $type: "border",
            $value: {
              color: "{missing}",
              width: { value: 1, unit: "px" },
              style: "solid",
            },
          },
        }),
      },
    ]);
    expect(result.success).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "TOKEN_UNKNOWN_REFERENCE",
        message: "Unknown token `missing` in nested value",
      }),
    );
  });

  it("diagnoses nested reference cycles instead of silently dropping their tokens", () => {
    const parsed = parseTokenDocument(
      JSON.stringify({
        a: { $type: "shadow", $value: ["{b}"] },
        b: { $type: "shadow", $value: ["{a}"] },
      }),
      "/tokens/nested-cycle.json",
    );
    expect(parsed.tokens).toEqual([]);
    expect(parsed.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "TOKEN_CIRCULAR_REFERENCE",
        message: expect.stringContaining("b → a → b"),
      }),
    );
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
    const compiler = createCompilerSession();
    await compiler.apply({
      documents: [
        {
          kind: "add",
          document: { identity: pointerSource(0).file, content: pointerSource(0).content },
        },
      ],
    });
    const update = await compiler.apply({
      documents: [
        {
          kind: "update",
          document: { identity: pointerSource(0.5).file, content: pointerSource(0.5).content },
        },
      ],
    });
    if (update.status !== "valid") throw new Error("Expected a valid snapshot");
    expect(update.query.resolve(parseTokenId("firstX"))?.value).toBe(0.5);
  });

  it("resolves whole-token and component pointers from the same last-source winner", async () => {
    const result = await compileDocuments(
      [
        {
          file: "/tokens/base.json",
          content: JSON.stringify({
            curve: { $type: "cubicBezier", $value: [0.25, 0, 1, 1] },
            whole: { $ref: "#/curve" },
            component: { $type: "number", $ref: "#/curve/$value/0" },
          }),
        },
        {
          file: "/tokens/override.json",
          content: JSON.stringify({
            curve: { $type: "cubicBezier", $value: [0.75, 0, 1, 1] },
          }),
        },
      ],
      { allowTokenOverrides: true },
    );
    expect(result.success).toBe(true);
    expect(result.compilation.resolveToken(parseTokenId("curve"))?.value).toEqual([0.75, 0, 1, 1]);
    expect(result.compilation.resolveToken(parseTokenId("whole"))?.value).toEqual([0.75, 0, 1, 1]);
    expect(result.compilation.resolveToken(parseTokenId("component"))?.value).toBe(0.75);
  });
});
