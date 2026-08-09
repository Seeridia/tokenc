import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { checkContexts, defaultContext, selectTokenExpression } from "../src/context.js";
import type { ContextDefinition } from "../src/model.js";
import { parseTokenDocument } from "../src/parser.js";

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

  it("uses the base expression in the default context", () => {
    expect(selectTokenExpression(token, defaultContext(contexts))).toMatchObject({
      kind: "literal",
      value: { original: "#ffffff" },
    });
  });

  it("selects a dark-mode override", () => {
    expect(selectTokenExpression(token, { theme: "dark", brand: "default" })).toMatchObject({
      kind: "literal",
      value: { original: "#111111" },
    });
  });

  it("selects the most-specific multi-modifier override", () => {
    expect(selectTokenExpression(token, { theme: "dark", brand: "enterprise" })).toMatchObject({
      kind: "literal",
      value: { original: "#003cab" },
    });
  });

  it("validates modifier names and values", () => {
    expect(
      checkContexts([token], { theme: contexts.theme! }).map((diagnostic) => diagnostic.code),
    ).toContain("TOKEN_CONTEXT_UNKNOWN_DIMENSION");
  });
});
