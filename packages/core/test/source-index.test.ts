import { describe, expect, it } from "vite-plus/test";

import editorSymbolSchema from "../schema/editor-symbol-v1.schema.json" with { type: "json" };
import { compileDocuments } from "../src/compiler.js";
import { parseTokenId } from "../src/token-id.js";
import { assertSchemaConformance } from "./support/schema-conformance.js";

describe("EditorSourceIndex", () => {
  it("preserves exact UTF-16 declaration and alias spans across CRLF text", async () => {
    const content =
      '{\r\n  "emoji😀": { "$type": "number", "$value": 1 },\r\n  "alias": { "$type": "number", "$value": "{emoji😀}" }\r\n}\r\n';
    const file = "/workspace/alpha/tokens.tokens.json";
    const snapshot = await compileDocuments([{ file, content }]);
    if (snapshot.status !== "valid") throw new Error("Expected a valid snapshot");

    expect(snapshot.sourceIndex.all()).toMatchObject([
      {
        role: "declaration",
        owner: "emoji😀",
        target: "emoji😀",
        source: { offset: 5, length: 9, line: 2, column: 3 },
      },
      {
        role: "declaration",
        owner: "alias",
        target: "alias",
        source: { offset: 55, length: 7, line: 3, column: 3 },
      },
      {
        role: "alias",
        owner: "alias",
        target: "emoji😀",
        source: { offset: 96, length: 9, line: 3, column: 44 },
      },
    ]);
    expect(snapshot.query.definition(parseTokenId("emoji😀"))).toMatchObject({
      offset: 5,
      length: 9,
    });
    expect(snapshot.query.symbolAt(file, 97)).toMatchObject({
      role: "alias",
      target: "emoji😀",
    });
    expect(snapshot.query.documentSymbols(file).map((symbol) => symbol.target)).toEqual([
      "emoji😀",
      "alias",
    ]);
    expect(snapshot.query.occurrences(parseTokenId("emoji😀"))).toHaveLength(1);
    expect(Object.isFrozen(snapshot.sourceIndex)).toBe(true);
    expect(Object.isFrozen(snapshot.sourceIndex.all())).toBe(true);
    expect(Object.isFrozen(snapshot.sourceIndex.all()[0]?.source)).toBe(true);
    for (const symbol of snapshot.sourceIndex.all())
      expect(() => assertSchemaConformance(symbol, editorSymbolSchema)).not.toThrow();
  });

  it("normalizes pointer, composite, and inheritance occurrences to semantic targets", async () => {
    const file = "/workspace/roles.tokens.json";
    const content = JSON.stringify({
      base: {
        value: { $type: "number", $value: 1 },
      },
      alias: { $type: "number", $value: "{base.value}" },
      pointer: { $type: "number", $ref: "#/base/value/$value" },
      gradient: {
        $type: "gradient",
        $value: ["{gradientBase}"],
      },
      gradientBase: {
        $type: "gradient",
        $value: [
          {
            color: { colorSpace: "srgb", components: [1, 0, 0] },
            position: 0,
          },
        ],
      },
      derived: { $extends: "{base}" },
    });
    const snapshot = await compileDocuments([{ file, content }]);
    if (snapshot.status !== "valid") throw new Error("Expected a valid snapshot");

    expect(
      snapshot.sourceIndex
        .all(file)
        .filter((symbol) => symbol.role !== "declaration")
        .map((symbol) => [symbol.role, symbol.owner, symbol.target, symbol.fieldPath]),
    ).toEqual([
      ["alias", "alias", "base.value", []],
      ["json-pointer", "pointer", "base.value", []],
      ["alias", "gradient", "gradientBase", [0]],
      ["inheritance", "derived", "base", ["$extends"]],
    ]);
  });

  it("filters exact occurrences with the same Context predicates as graph usages", async () => {
    const file = "/workspace/context.tokens.json";
    const snapshot = await compileDocuments(
      [
        {
          file,
          content: JSON.stringify({
            base: { $type: "number", $value: 1 },
            conditional: {
              $type: "number",
              $value: 2,
              $extensions: {
                "org.token-compiler.contexts": { "theme=dark": "{base}" },
              },
            },
          }),
        },
      ],
      { contexts: { theme: { default: "light", values: ["light", "dark"] } } },
    );
    if (snapshot.status !== "valid") throw new Error("Expected a valid snapshot");
    const base = parseTokenId("base");

    expect(snapshot.query.occurrences(base, { context: { theme: "light" } })).toEqual([]);
    expect(snapshot.query.occurrences(base, { context: { theme: "dark" } })).toMatchObject([
      { owner: "conditional", target: "base", condition: { clauses: [{ theme: ["dark"] }] } },
    ]);
  });

  it("retains syntax-proven declarations in an invalid current document", async () => {
    const file = "/workspace/invalid.tokens.json";
    const content = '{"good":{"$type":"number","$value":1},"partial":{"$type":"number","$value":';
    const snapshot = await compileDocuments([{ file, content }]);

    expect(snapshot.status).toBe("invalid");
    expect(snapshot.sourceIndex.declarations(file).map((symbol) => symbol.target)).toEqual([
      "good",
      "partial",
    ]);
    expect(snapshot.sourceIndex.occurrences(parseTokenId("good"))).toEqual([]);
  });

  it("indexes escaped names, nested groups, $root, and duplicate declarations by raw span", async () => {
    const file = "/workspace/edge-cases.tokens.json";
    const content =
      '{"nested":{"quote\\\"name":{"$type":"number","$value":1},"$root":{"$type":"number","$value":2}},"dup":{"$type":"number","$value":3},"dup":{"$type":"number","$value":4}}';
    const snapshot = await compileDocuments([{ file, content }]);
    const declarations = snapshot.sourceIndex.declarations(file);
    const rawKeys = ['"quote\\\"name"', '"$root"', '"dup"', '"dup"'];

    expect(snapshot.status).toBe("invalid");
    expect(declarations.map((symbol) => symbol.target)).toEqual([
      'nested.quote"name',
      "nested.$root",
      "dup",
      "dup",
    ]);
    expect(declarations.map((symbol) => symbol.source.offset)).toEqual([
      content.indexOf(rawKeys[0]!),
      content.indexOf(rawKeys[1]!),
      content.indexOf(rawKeys[2]!),
      content.lastIndexOf(rawKeys[3]!),
    ]);
    expect(declarations.map((symbol) => symbol.source.length)).toEqual(
      rawKeys.map((key) => key.length),
    );
  });
});
