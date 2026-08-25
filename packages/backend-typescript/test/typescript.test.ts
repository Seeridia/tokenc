import { compileDocuments } from "@tokenc/core";
import { describe, expect, it } from "vite-plus/test";

import { typescript } from "../src/index.js";

const source = {
  file: "tokens.json",
  content: JSON.stringify({
    color: {
      $type: "color",
      blue: {
        "600": {
          $value: {
            colorSpace: "srgb",
            components: [0, 82 / 255, 217 / 255],
            alpha: 1,
            hex: "#0052D9",
          },
        },
      },
      brand: { default: { $value: "{color.blue.600}" } },
    },
  }),
};

describe("TypeScript backend", () => {
  it("emits flat symbol references", async () => {
    const result = await compileDocuments([source], {
      outputs: [typescript({ mode: "flat", references: "symbol" })],
    });
    expect(result.outputs[0]?.content).toBe(
      'export const colorBlue600 = "#0052d9";\nexport const colorBrandDefault = colorBlue600;\n',
    );
  });

  it("emits flat resolved references", async () => {
    const result = await compileDocuments([source], {
      outputs: [typescript({ mode: "flat", references: "resolve" })],
    });
    expect(result.outputs[0]?.content).toContain('export const colorBrandDefault = "#0052d9";');
  });

  it("emits a nested const object", async () => {
    const result = await compileDocuments([source], { outputs: [typescript({ mode: "object" })] });
    expect(result.outputs[0]?.content).toContain('export const tokens = {\n  "color": {');
    expect(result.outputs[0]?.content).toContain('"600": "#0052d9"');
    expect(result.outputs[0]?.content).toContain('"default": "#0052d9"');
    expect(result.outputs[0]?.content).toContain("} as const;");
  });

  it.each([
    {
      name: "a channel",
      value: { colorSpace: "srgb", components: [0.1, 0.2, 0.3], alpha: 1 },
      expected: 'export const color = "color(srgb 0.1 0.2 0.3)";\n',
    },
    {
      name: "alpha",
      value: { colorSpace: "srgb", components: [0, 1, 0], alpha: 0.5 },
      expected: 'export const color = "color(srgb 0 1 0 / 0.5)";\n',
    },
  ])("preserves sRGB precision when $name is not exactly representable as 8-bit", async (entry) => {
    const result = await compileDocuments(
      [
        {
          file: "color.json",
          content: JSON.stringify({ color: { $type: "color", $value: entry.value } }),
        },
      ],
      { outputs: [typescript({ mode: "flat" })] },
    );
    expect(result.success).toBe(true);
    expect(result.outputs[0]?.content).toBe(entry.expected);
  });

  it("emits eight-digit hex when sRGB channels and alpha are exactly representable as 8-bit", async () => {
    const result = await compileDocuments(
      [
        {
          file: "color.json",
          content: JSON.stringify({
            color: {
              $type: "color",
              $value: { colorSpace: "srgb", components: [0, 1, 0], alpha: 128 / 255 },
            },
          }),
        },
      ],
      { outputs: [typescript({ mode: "flat" })] },
    );
    expect(result.success).toBe(true);
    expect(result.outputs[0]?.content).toBe('export const color = "#00ff0080";\n');
  });

  it("rejects flat binding collisions after identifier normalization", async () => {
    const result = await compileDocuments(
      [
        {
          file: "collision.json",
          content: JSON.stringify({
            "foo-bar": { $type: "number", $value: 1 },
            foo: { bar: { $type: "number", $value: 2 } },
          }),
        },
      ],
      { outputs: [typescript({ mode: "flat" })] },
    );
    expect(result.success).toBe(false);
    expect(result.outputs).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "BACKEND_NAME_COLLISION",
        message: expect.stringContaining("fooBar"),
      }),
    );
  });

  it.each(["class", "eval", "arguments"])(
    "prefixes the reserved or strict-mode binding name %s",
    async (name) => {
      const result = await compileDocuments(
        [
          {
            file: "reserved.json",
            content: JSON.stringify({ [name]: { $type: "number", $value: 1 } }),
          },
        ],
        { outputs: [typescript({ mode: "flat" })] },
      );
      expect(result.success).toBe(true);
      expect(result.outputs[0]?.content).toBe(
        `export const token${name[0]?.toUpperCase()}${name.slice(1)} = 1;\n`,
      );
    },
  );

  it("orders symbols by dependencies active in the default context", async () => {
    const result = await compileDocuments(
      [
        {
          file: "conditional-order.json",
          content: JSON.stringify({
            a: {
              $type: "number",
              $value: 1,
              $extensions: { "org.token-compiler.contexts": { "theme=dark": "{b}" } },
            },
            b: {
              $type: "number",
              $value: 2,
              $extensions: { "org.token-compiler.contexts": { "theme=light": "{a}" } },
            },
          }),
        },
      ],
      {
        contexts: { theme: { default: "dark", values: ["light", "dark"] } },
        outputs: [typescript({ mode: "flat", references: "symbol" })],
      },
    );
    expect(result.success).toBe(true);
    expect(result.outputs[0]?.content).toBe("export const b = 2;\nexport const a = b;\n");
  });

  it("rejects a value token that is also an object namespace across documents", async () => {
    const result = await compileDocuments(
      [
        { file: "value.json", content: '{"a":{"$type":"number","$value":1}}' },
        {
          file: "namespace.json",
          content: '{"a":{"b":{"$type":"number","$value":2}}}',
        },
      ],
      { outputs: [typescript({ mode: "object" })] },
    );
    expect(result.success).toBe(false);
    expect(result.outputs).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "BACKEND_NAME_COLLISION",
        message: expect.stringContaining("both `a` and `a.b`"),
      }),
    );
  });
});
