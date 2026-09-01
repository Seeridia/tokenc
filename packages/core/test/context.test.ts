import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { compileDocumentsInternal as compileDocuments } from "../src/compiler.js";
import {
  checkContexts,
  contextKey,
  defaultContext,
  parseContextKey,
  selectTokenExpression,
} from "../src/context.js";
import type { ContextDefinition } from "../src/model.js";
import { parseTokenDocument } from "../src/parser.js";
import { parseTokenId } from "../src/token-id.js";

const content = readFileSync(
  fileURLToPath(new URL("fixtures/themes/tokens.json", import.meta.url)),
  "utf8",
);
const token = parseTokenDocument(content, "themes.json").tokens[0]!;
const contexts: ContextDefinition = {
  theme: { default: "light", values: ["light", "dark"] },
  brand: { default: "default", values: ["default", "enterprise"] },
};

describe("context selection", () => {
  it("builds the default context", () =>
    expect(defaultContext(contexts)).toEqual({ theme: "light", brand: "default" }));

  it("uses unambiguous round-trippable cache keys for reserved separators", () => {
    const first = { a: " x&b=y ", b: "z" };
    const second = { a: "x", b: "y&b=z" };
    expect(contextKey(first)).not.toBe(contextKey(second));
    expect(parseContextKey(contextKey(first))).toEqual(first);
    expect(parseContextKey(contextKey(second))).toEqual(second);
  });

  it("sorts Unicode dimension names independently of insertion order", () => {
    const composedFirst = { ä: "x", "a\u0308": "y" };
    const decomposedFirst = { "a\u0308": "y", ä: "x" };
    expect(contextKey(composedFirst)).toBe(contextKey(decomposedFirst));
  });

  it("does not cross-contaminate resolver cache entries whose old context keys collided", async () => {
    const result = await compileDocuments(
      [
        {
          file: "context-key.json",
          content: JSON.stringify({
            value: {
              $type: "number",
              $value: 1,
              $extensions: { "org.token-compiler.contexts": { "a=x": 2 } },
            },
          }),
        },
      ],
      {
        contexts: {
          a: { default: "x&b=y", values: ["x&b=y", "x"] },
          b: { default: "z", values: ["z", "y&b=z"] },
        },
      },
    );
    const id = parseTokenId("value");
    expect(result.compilation.resolveToken(id)?.value).toBe(1);
    expect(result.compilation.resolveToken(id, { a: "x", b: "y&b=z" })?.value).toBe(2);
  });

  it("uses the base expression in the default context", () => {
    expect(selectTokenExpression(token, defaultContext(contexts))).toMatchObject({
      kind: "literal",
      value: { hex: "#ffffff" },
    });
  });

  it("selects a dark-mode override", () => {
    expect(selectTokenExpression(token, { theme: "dark", brand: "default" })).toMatchObject({
      kind: "literal",
      value: { hex: "#111111" },
    });
  });

  it("selects the most-specific multi-modifier override", () => {
    expect(selectTokenExpression(token, { theme: "dark", brand: "enterprise" })).toMatchObject({
      kind: "literal",
      value: { hex: "#003cab" },
    });
  });

  it("validates modifier names and values", () => {
    expect(
      checkContexts([token], { theme: contexts.theme! }).map((diagnostic) => diagnostic.code),
    ).toContain("TOKEN_CONTEXT_UNKNOWN_DIMENSION");
  });

  it("does not treat object prototype properties as declared context dimensions", () => {
    const parsed = parseTokenDocument(
      JSON.stringify({
        value: {
          $type: "number",
          $value: 0,
          $extensions: { "org.token-compiler.contexts": { "constructor=alternate": 1 } },
        },
      }),
      "prototype-context.json",
    );
    expect(checkContexts(parsed.tokens, {})).toContainEqual(
      expect.objectContaining({
        code: "TOKEN_CONTEXT_UNKNOWN_DIMENSION",
        message: expect.stringContaining("constructor"),
      }),
    );
  });

  it("uses explicit context dimension order for equally specific matches", () => {
    const parsed = parseTokenDocument(
      JSON.stringify({
        value: {
          $type: "number",
          $value: 0,
          $extensions: {
            "org.token-compiler.contexts": {
              "brand=enterprise": 2,
              "theme=dark": 1,
            },
          },
        },
      }),
      "precedence.json",
    );
    expect(
      selectTokenExpression(parsed.tokens[0]!, { theme: "dark", brand: "enterprise" }, [
        "theme",
        "brand",
      ]),
    ).toMatchObject({ kind: "literal", value: 2 });
  });

  it("diagnoses duplicate selectors rather than using declaration order", () => {
    const parsed = parseTokenDocument(
      '{"value":{"$type":"number","$value":0,"$extensions":{"org.token-compiler.contexts":{"theme=dark":1,"theme=dark":2}}}}',
      "ambiguous.json",
    );
    expect(checkContexts(parsed.tokens, contexts)[0]?.code).toBe("TOKEN_RESOLUTION_AMBIGUOUS");
  });
});
