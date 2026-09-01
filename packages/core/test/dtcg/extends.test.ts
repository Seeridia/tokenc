import { describe, expect, it } from "vite-plus/test";

import { compileDocumentsInternal as compileDocuments } from "../../src/compiler.js";
import { parseTokenDocument } from "../../src/parser.js";
import { createCompilerSession } from "../../src/session.js";
import { parseTokenId } from "../../src/token-id.js";

const inheritedSource = (small: number) => ({
  file: "/tokens/extends-incremental.json",
  content: JSON.stringify({
    base: { $type: "number", small: { $value: small } },
    derived: { $extends: "{base}" },
  }),
});

const inheritanceEdgeSource = (base: "first" | "second") => ({
  file: "/tokens/extends-edge.json",
  content: JSON.stringify({
    first: { $type: "number", value: { $value: 1 } },
    second: { $type: "number", value: { $value: 1 } },
    derived: { $extends: `{${base}}` },
  }),
});

describe("DTCG group $extends", () => {
  it.each(["{base}", "#/base"])("inherits group members through %s", (reference) => {
    const parsed = parseTokenDocument(
      JSON.stringify({
        base: {
          $type: "number",
          small: { $value: 1 },
          large: { $value: 2 },
        },
        derived: {
          $extends: reference,
          large: { $value: 3 },
        },
      }),
      "/tokens/extends.json",
    );
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.tokens.map((token) => token.id)).toEqual([
      "base.small",
      "base.large",
      "derived.small",
      "derived.large",
    ]);
    expect(parsed.tokens.find((token) => token.id === "derived.small")).toMatchObject({
      type: "number",
      value: { kind: "literal", value: 1 },
      dependencyOccurrences: [{ target: "base.small", kind: "inheritance" }],
      inheritance: { token: "base.small", group: "base" },
    });
    const local = parsed.tokens.find((token) => token.id === "derived.large");
    expect(local).toMatchObject({ value: { kind: "literal", value: 3 } });
    expect(local?.inheritance).toBeUndefined();
  });

  it("deeply combines nested group membership while replacing local tokens", () => {
    const parsed = parseTokenDocument(
      JSON.stringify({
        base: {
          $type: "number",
          nested: {
            first: { $value: 1 },
            second: { $value: 2 },
          },
        },
        derived: {
          $extends: "{base}",
          nested: { second: { $value: 20 }, third: { $value: 30 } },
        },
      }),
      "/tokens/nested-extends.json",
    );
    expect(parsed.diagnostics).toEqual([]);
    expect(
      parsed.tokens
        .filter((token) => String(token.id).startsWith("derived."))
        .map((token) => [token.id, token.value.kind === "literal" ? token.value.value : null]),
    ).toEqual([
      ["derived.nested.first", 1],
      ["derived.nested.second", 20],
      ["derived.nested.third", 30],
    ]);
  });

  it("supports multiple descendants and cross-document group references", async () => {
    const result = await compileDocuments([
      {
        file: "/tokens/base.json",
        content: JSON.stringify({ base: { $type: "number", value: { $value: 1 } } }),
      },
      {
        file: "/tokens/derived.json",
        content: JSON.stringify({
          first: { $extends: "{base}" },
          second: { $extends: "{base}" },
        }),
      },
    ]);
    expect(result.success).toBe(true);
    expect(result.graph.tokens.map((token) => token.id)).toEqual([
      "base.value",
      "first.value",
      "second.value",
    ]);
  });

  it("applies a derived group type to inherited untyped values", () => {
    const parsed = parseTokenDocument(
      JSON.stringify({
        base: { value: { $type: "number", $value: 1 } },
        derived: { $type: "number", $extends: "{base}" },
      }),
      "/tokens/extends-type.json",
    );
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.tokens.find((token) => token.id === "derived.value")?.type).toBe("number");
  });

  it("lets a derived group type override the extended group's type", () => {
    const parsed = parseTokenDocument(
      JSON.stringify({
        base: { $type: "number", value: { $value: 1 } },
        derived: { $type: "fontWeight", $extends: "{base}" },
      }),
      "/tokens/extends-type-override.json",
    );
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.tokens.find((token) => token.id === "derived.value")?.type).toBe("fontWeight");
  });

  it("keeps an explicit local token type above an inherited group type", () => {
    const parsed = parseTokenDocument(
      JSON.stringify({
        base: { $type: "number", value: { $value: 1 } },
        derived: {
          $extends: "{base}",
          value: { $type: "fontWeight", $value: 400 },
        },
      }),
      "/tokens/extends-local-type.json",
    );
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.tokens.find((token) => token.id === "derived.value")?.type).toBe("fontWeight");
  });

  it("applies the closest local type in a deeply nested inherited group", () => {
    const parsed = parseTokenDocument(
      JSON.stringify({
        base: {
          $type: "number",
          nested: { deep: { value: { $value: 1 } } },
        },
        derived: {
          $extends: "{base}",
          nested: { deep: { $type: "fontWeight" } },
        },
      }),
      "/tokens/nested-extends-type.json",
    );
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.tokens.find((token) => token.id === "derived.nested.deep.value")?.type).toBe(
      "fontWeight",
    );
  });

  it.each([
    ["{missing}", "DTCG_GROUP_EXTENDS_INVALID_TARGET"],
    ["#/value", "DTCG_GROUP_EXTENDS_INVALID_TARGET"],
  ])("diagnoses invalid target %s", (reference, code) => {
    const parsed = parseTokenDocument(
      JSON.stringify({
        value: { $type: "number", $value: 1 },
        derived: { $extends: reference },
      }),
      "/tokens/invalid-extends.json",
    );
    expect(parsed.diagnostics.map((diagnostic) => diagnostic.code)).toContain(code);
  });

  it("diagnoses extension cycles with related group sources", () => {
    const parsed = parseTokenDocument(
      JSON.stringify({
        a: { $extends: "{b}", value: { $type: "number", $value: 1 } },
        b: { $extends: "{c}" },
        c: { $extends: "{a}" },
      }),
      "/tokens/extends-cycle.json",
    );
    expect(parsed.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "DTCG_GROUP_EXTENDS_CYCLE",
        related: expect.arrayContaining([expect.objectContaining({ source: expect.any(Object) })]),
      }),
    );
  });

  it("preserves the inherited definition and extension provenance", () => {
    const parsed = parseTokenDocument(inheritedSource(1).content, "/tokens/provenance.json");
    const base = parsed.tokens.find((token) => token.id === "base.small");
    const derived = parsed.tokens.find((token) => token.id === "derived.small");
    expect(derived?.source).toEqual(base?.source);
    expect(derived?.inheritance).toMatchObject({
      token: "base.small",
      group: "base",
      source: base?.source,
      extendsSource: { file: "/tokens/provenance.json" },
    });
  });

  it("invalidates inherited tokens when a base member changes", async () => {
    const compiler = createCompilerSession();
    await compiler.apply({
      documents: [
        {
          kind: "add",
          document: { identity: inheritedSource(1).file, content: inheritedSource(1).content },
        },
      ],
    });
    const update = await compiler.apply({
      documents: [
        {
          kind: "update",
          document: { identity: inheritedSource(2).file, content: inheritedSource(2).content },
        },
      ],
    });
    if (update.status !== "valid") throw new Error("Expected a valid snapshot");
    expect(update.query.resolve(parseTokenId("derived.small"))?.value).toBe(2);
  });

  it("patches an inheritance edge even when the replacement base has the same value", async () => {
    const compiler = createCompilerSession();
    await compiler.apply({
      documents: [
        {
          kind: "add",
          document: {
            identity: inheritanceEdgeSource("first").file,
            content: inheritanceEdgeSource("first").content,
          },
        },
      ],
    });
    const update = await compiler.apply({
      documents: [
        {
          kind: "update",
          document: {
            identity: inheritanceEdgeSource("second").file,
            content: inheritanceEdgeSource("second").content,
          },
        },
      ],
    });
    expect(update.query.dependencies(parseTokenId("derived.value")).map((edge) => edge.to)).toEqual(
      ["second.value"],
    );
  });
});
