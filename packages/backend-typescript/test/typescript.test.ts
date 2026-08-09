import { compileDocuments } from "@tokenc/core";
import { describe, expect, it } from "vitest";

import { typescript } from "../src/index.js";

const source = {
  file: "tokens.json",
  content:
    '{"color":{"$type":"color","blue":{"600":{"$value":"#0052D9"}},"brand":{"default":{"$value":"{color.blue.600}"}}}}',
};

describe("TypeScript backend", () => {
  it("emits flat symbol references", async () => {
    const result = await compileDocuments([source], {
      outputs: [typescript({ mode: "flat", references: "symbol" })],
    });
    expect(result.outputs[0]?.content).toBe(
      'export const colorBlue600 = "#0052D9";\nexport const colorBrandDefault = colorBlue600;\n',
    );
  });

  it("emits flat resolved references", async () => {
    const result = await compileDocuments([source], {
      outputs: [typescript({ mode: "flat", references: "resolve" })],
    });
    expect(result.outputs[0]?.content).toContain('export const colorBrandDefault = "#0052D9";');
  });

  it("emits a nested const object", async () => {
    const result = await compileDocuments([source], { outputs: [typescript({ mode: "object" })] });
    expect(result.outputs[0]?.content).toContain('export const tokens = {\n  "color": {');
    expect(result.outputs[0]?.content).toContain('"600": "#0052D9"');
    expect(result.outputs[0]?.content).toContain('"default": "#0052D9"');
    expect(result.outputs[0]?.content).toContain("} as const;");
  });
});
