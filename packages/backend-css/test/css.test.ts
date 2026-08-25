import { compileDocuments } from "@tokenc/core";
import { describe, expect, it } from "vite-plus/test";

import { css } from "../src/index.js";

const srgb = (red: number, green: number, blue: number, hex: string) => ({
  colorSpace: "srgb",
  components: [red, green, blue],
  alpha: 1,
  hex,
});

const source = {
  file: "tokens.json",
  content: JSON.stringify({
    color: {
      $type: "color",
      blue: {
        "600": {
          $value: srgb(0, 82 / 255, 217 / 255, "#0052D9"),
          $extensions: {
            "org.token-compiler.contexts": {
              "theme=dark": srgb(119 / 255, 170 / 255, 1, "#77aaff"),
            },
          },
        },
      },
      brand: { default: { $value: "{color.blue.600}" } },
    },
  }),
};
const contexts = { theme: { default: "light", values: ["light", "dark"] } } as const;
const red = { colorSpace: "srgb", components: [1, 0, 0], alpha: 1 };
const px = (value: number) => ({ value, unit: "px" });
const ms = (value: number) => ({ value, unit: "ms" });
const multidimensionalContexts = {
  theme: { default: "light", values: ["light", "dark"] },
  brand: { default: "consumer", values: ["consumer", "enterprise"] },
} as const;
const contextualSource = {
  file: "contextual.json",
  content: JSON.stringify({
    value: {
      $type: "number",
      $value: 0,
      $extensions: {
        "org.token-compiler.contexts": {
          "theme=dark": 1,
          "brand=enterprise": 2,
        },
      },
    },
  }),
};

describe("CSS backend", () => {
  it("emits literals and preserves reference edges", async () => {
    const result = await compileDocuments([source], { contexts, outputs: [css()] });
    expect(result.outputs[0]?.content).toContain("--color-blue-600: #0052d9;");
    expect(result.outputs[0]?.content).toContain("--color-brand-default: var(--color-blue-600);");
  });

  it("can resolve references", async () => {
    const result = await compileDocuments([source], {
      contexts,
      outputs: [css({ references: "resolve" })],
    });
    expect(result.outputs[0]?.content).toContain("--color-brand-default: #0052d9;");
  });

  it("emits only changed declarations under theme selectors", async () => {
    const result = await compileDocuments([source], {
      contexts,
      outputs: [
        css({ selectors: { "theme=light": ":root", "theme=dark": "[data-theme='dark']" } }),
      ],
    });
    expect(result.outputs[0]?.content).toContain(
      "[data-theme='dark'] {\n  --color-blue-600: #77aaff;\n}",
    );
    expect(result.outputs[0]?.content.match(/--color-brand-default/g)).toHaveLength(1);
  });

  it("supports custom naming", async () => {
    const result = await compileDocuments([source], {
      contexts,
      outputs: [css({ name: (token) => `--dt-${String(token.id).replaceAll(".", "-")}` })],
    });
    expect(result.outputs[0]?.content).toContain("--dt-color-blue-600");
  });

  it("rejects an invalid custom-property name from a custom naming policy", async () => {
    const result = await compileDocuments([source], {
      contexts,
      outputs: [css({ name: (token) => `--dt-${token.id}` })],
    });
    expect(result.success).toBe(false);
    expect(result.outputs).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "BACKEND_INVALID_OUTPUT_NAME",
        message: expect.stringContaining("--dt-color.blue.600"),
      }),
    );
  });

  it("serializes structured DTCG color spaces without converting them", async () => {
    const result = await compileDocuments(
      [
        {
          file: "strict.json",
          content: JSON.stringify({
            accent: {
              $type: "color",
              $value: { colorSpace: "hsl", components: [120, 50, 25], alpha: 0.5 },
            },
            wide: {
              $type: "color",
              $value: { colorSpace: "display-p3", components: [0.1, 0.2, 0.3] },
            },
          }),
        },
      ],
      { outputs: [css()] },
    );
    expect(result.outputs[0]?.content).toContain("--accent: hsl(120 50% 25% / 0.5);");
    expect(result.outputs[0]?.content).toContain("--wide: color(display-p3 0.1 0.2 0.3);");
  });

  it("preserves number precision and does not quantize non-8-bit sRGB colors", async () => {
    const result = await compileDocuments(
      [
        {
          file: "precise.json",
          content: JSON.stringify({
            ratio: { $type: "number", $value: 0.123456789 },
            color: {
              $type: "color",
              $value: { colorSpace: "srgb", components: [0.1, 0.2, 0.3], alpha: 1 },
            },
            translucent: {
              $type: "color",
              $value: { colorSpace: "srgb", components: [1, 0, 0], alpha: 0.5 },
            },
          }),
        },
      ],
      { outputs: [css()] },
    );
    expect(result.success).toBe(true);
    expect(result.outputs[0]?.content).toContain("--ratio: 0.123456789;");
    expect(result.outputs[0]?.content).toContain("--color: color(srgb 0.1 0.2 0.3);");
    expect(result.outputs[0]?.content).toContain("--translucent: color(srgb 1 0 0 / 0.5);");
    expect(result.outputs[0]?.content).not.toContain("--color: #1a334d;");
    expect(result.outputs[0]?.content).not.toContain("--translucent: #ff000080;");
  });

  it("uses CSS escapes rather than JSON escapes for font-family control characters", async () => {
    const result = await compileDocuments(
      [
        {
          file: "font-family.json",
          content: JSON.stringify({
            family: { $type: "fontFamily", $value: 'Line\n"Quoted"\\Path' },
          }),
        },
      ],
      { outputs: [css()] },
    );
    expect(result.success).toBe(true);
    expect(result.outputs[0]?.content).toContain(String.raw`--family: "Line\A \"Quoted\"\\Path";`);
  });

  it("rejects a font family containing a null code point", async () => {
    const result = await compileDocuments(
      [
        {
          file: "font-family-null.json",
          content: JSON.stringify({ family: { $type: "fontFamily", $value: "A\0B" } }),
        },
      ],
      { outputs: [css()] },
    );
    expect(result.success).toBe(false);
    expect(result.outputs).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "BACKEND_UNSUPPORTED_VALUE",
        message: expect.stringContaining("font-family strings"),
      }),
    );
  });

  it("serializes DTCG composites as consumable CSS values and sub-values", async () => {
    const result = await compileDocuments(
      [
        {
          file: "composites.json",
          content: JSON.stringify({
            easing: { $type: "cubicBezier", $value: [0.25, 0.1, 0.25, 1] },
            border: {
              $type: "border",
              $value: { color: red, width: px(1), style: "dashed" },
            },
            transition: {
              $type: "transition",
              $value: {
                duration: ms(200),
                delay: ms(50),
                timingFunction: [0, 0, 1, 1],
              },
            },
            shadow: {
              $type: "shadow",
              $value: {
                color: red,
                offsetX: px(0),
                offsetY: px(2),
                blur: px(4),
                spread: px(0),
                inset: true,
              },
            },
            body: {
              $type: "typography",
              $value: {
                fontFamily: ["Inter", "sans-serif"],
                fontSize: px(16),
                fontWeight: "semi-bold",
                letterSpacing: px(0),
                lineHeight: 1.5,
              },
            },
            bodyAlias: { $type: "typography", $value: "{body}" },
          }),
        },
      ],
      { outputs: [css()] },
    );
    expect(result.success).toBe(true);
    const output = result.outputs[0]?.content;
    expect(output).toContain("--easing: cubic-bezier(0.25, 0.1, 0.25, 1);");
    expect(output).toContain("--border: 1px dashed #ff0000;");
    expect(output).toContain("--transition: 200ms cubic-bezier(0, 0, 1, 1) 50ms;");
    expect(output).toContain("--shadow: inset 0px 2px 4px 0px #ff0000;");
    expect(output).toContain('--body-font-family: "Inter", sans-serif;');
    expect(output).toContain("--body-font-size: 16px;");
    expect(output).toContain("--body-font-weight: 600;");
    expect(output).toContain("--body-letter-spacing: 0px;");
    expect(output).toContain("--body-line-height: 1.5;");
    expect(output).toContain("--bodyalias-font-size: var(--body-font-size);");
    expect(output).not.toContain('{"color"');
  });

  it("allows a negative transition delay", async () => {
    const result = await compileDocuments(
      [
        {
          file: "negative-delay.json",
          content: JSON.stringify({
            transition: {
              $type: "transition",
              $value: {
                duration: ms(200),
                delay: ms(-50),
                timingFunction: [0, 0, 1, 1],
              },
            },
          }),
        },
      ],
      { outputs: [css()] },
    );
    expect(result.success).toBe(true);
    expect(result.outputs[0]?.content).toContain(
      "--transition: 200ms cubic-bezier(0, 0, 1, 1) -50ms;",
    );
  });

  it.each([
    [
      "border width",
      "border",
      { color: red, width: px(-1), style: "solid" },
      "border widths cannot be negative",
    ],
    [
      "transition duration",
      "transition",
      { duration: ms(-1), delay: ms(0), timingFunction: [0, 0, 1, 1] },
      "transition durations cannot be negative",
    ],
    [
      "shadow blur radius",
      "shadow",
      {
        color: red,
        offsetX: px(0),
        offsetY: px(0),
        blur: px(-1),
        spread: px(0),
      },
      "shadow blur radii cannot be negative",
    ],
    [
      "typography font size",
      "typography",
      {
        fontFamily: "Inter",
        fontSize: px(-1),
        fontWeight: 400,
        letterSpacing: px(0),
        lineHeight: 1.5,
      },
      "font sizes and line heights cannot be negative",
    ],
    [
      "typography line height",
      "typography",
      {
        fontFamily: "Inter",
        fontSize: px(16),
        fontWeight: 400,
        letterSpacing: px(0),
        lineHeight: -1,
      },
      "font sizes and line heights cannot be negative",
    ],
  ])("rejects a negative %s as an unsupported CSS value", async (_label, type, value, reason) => {
    const result = await compileDocuments(
      [
        {
          file: "negative-composite.json",
          content: JSON.stringify({ invalid: { $type: type, $value: value } }),
        },
      ],
      { outputs: [css()] },
    );
    expect(result.success).toBe(false);
    expect(result.outputs).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "BACKEND_UNSUPPORTED_VALUE",
        severity: "error",
        message: expect.stringContaining(reason),
      }),
    );
  });

  it("rejects simple and referenced nested gradients without flattening their stops", async () => {
    const result = await compileDocuments(
      [
        {
          file: "gradients.json",
          content: JSON.stringify({
            simple: {
              $type: "gradient",
              $value: [
                { color: red, position: 0 },
                { color: red, position: 1 },
              ],
            },
            nested: {
              $type: "gradient",
              $value: ["{simple}", { color: red, position: 0.5 }],
            },
          }),
        },
      ],
      { outputs: [css()] },
    );
    expect(result.success).toBe(false);
    expect(result.outputs).toEqual([]);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "BACKEND_UNSUPPORTED_VALUE",
          message: expect.stringContaining("`simple`"),
        }),
        expect.objectContaining({
          code: "BACKEND_UNSUPPORTED_VALUE",
          message: expect.stringContaining("`nested`"),
        }),
      ]),
    );
  });

  it("reports a structured error instead of emitting an unsupported composite as JSON", async () => {
    const result = await compileDocuments(
      [
        {
          file: "stroke.json",
          content: JSON.stringify({
            stroke: {
              $type: "strokeStyle",
              $value: { dashArray: [px(1), px(2)], lineCap: "round" },
            },
          }),
        },
      ],
      { outputs: [css()] },
    );
    expect(result.success).toBe(false);
    expect(result.outputs).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "BACKEND_UNSUPPORTED_VALUE",
        severity: "error",
        source: expect.objectContaining({ file: "stroke.json" }),
      }),
    );
  });

  it("rejects custom-property collisions after name normalization", async () => {
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
      { outputs: [css()] },
    );
    expect(result.success).toBe(false);
    expect(result.outputs).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "BACKEND_NAME_COLLISION",
        message: expect.stringContaining("--foo-bar"),
        related: [expect.objectContaining({ source: expect.any(Object) })],
      }),
    );
  });

  it("requires explicit selectors for compatible context combinations", async () => {
    const result = await compileDocuments([contextualSource], {
      contexts: multidimensionalContexts,
      outputs: [css()],
    });
    expect(result.success).toBe(false);
    expect(result.outputs).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "BACKEND_CONTEXT_COVERAGE",
        message: expect.stringContaining("context predicate `theme=dark`"),
      }),
    );
  });

  it("rejects a partial automatic predicate when another declared dimension varies", async () => {
    const result = await compileDocuments(
      [
        {
          file: "partial-context.json",
          content: JSON.stringify({
            value: {
              $type: "number",
              $value: 0,
              $extensions: { "org.token-compiler.contexts": { "theme=dark": 1 } },
            },
          }),
        },
      ],
      { contexts: multidimensionalContexts, outputs: [css()] },
    );
    expect(result.success).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "BACKEND_CONTEXT_COVERAGE",
        message: expect.stringContaining("omits varying dimension `brand`"),
      }),
    );
  });

  it("rejects an automatic default-context override without reset coverage", async () => {
    const result = await compileDocuments(
      [
        {
          file: "default-override.json",
          content: JSON.stringify({
            value: {
              $type: "number",
              $value: 0,
              $extensions: { "org.token-compiler.contexts": { "theme=light": 1 } },
            },
          }),
        },
      ],
      { contexts, outputs: [css()] },
    );
    expect(result.success).toBe(false);
    expect(result.outputs).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "BACKEND_CONTEXT_COVERAGE",
        message: expect.stringContaining("default-context override `theme=light`"),
      }),
    );
  });

  it("uses encoded canonical context keys in automatic selectors", async () => {
    const special = 'da"rk\\contrast';
    const result = await compileDocuments(
      [
        {
          file: "escaped-context.json",
          content: JSON.stringify({
            value: {
              $type: "number",
              $value: 0,
              $extensions: { "org.token-compiler.contexts": { [`theme=${special}`]: 1 } },
            },
          }),
        },
      ],
      {
        contexts: { theme: { default: "light", values: ["light", special] } },
        outputs: [css()],
      },
    );
    expect(result.success).toBe(true);
    expect(result.outputs[0]?.content).toContain('[data-context="theme=da%0022rk%005Ccontrast"] {');
  });

  it("encodes null characters in canonical runtime context keys", async () => {
    const special = "da\0rk";
    const result = await compileDocuments(
      [
        {
          file: "null-context.json",
          content: JSON.stringify({
            value: {
              $type: "number",
              $value: 0,
              $extensions: { "org.token-compiler.contexts": { [`theme=${special}`]: 1 } },
            },
          }),
        },
      ],
      {
        contexts: { theme: { default: "light", values: ["light", special] } },
        outputs: [css()],
      },
    );
    expect(result.success).toBe(true);
    expect(result.outputs[0]?.content).toContain(
      '[data-context="theme=da%0000rk"] {\n  --value: 1;\n}',
    );
  });

  it("treats configured selectors as the explicit context output set", async () => {
    const result = await compileDocuments([contextualSource], {
      contexts: multidimensionalContexts,
      outputs: [
        css({
          selectors: {
            "theme=light&brand=consumer": "#app",
            "theme=dark&brand=enterprise": '#app[data-mode="enterprise-dark"]',
          },
        }),
      ],
    });
    expect(result.success).toBe(true);
    const output = result.outputs[0]?.content;
    expect(output).toContain("#app {\n  --value: 0;\n}");
    expect(output).toContain('#app[data-mode="enterprise-dark"] {\n  --value: 2;\n}');
    expect(output).not.toContain("data-context");
  });

  it("validates only contexts selected for explicit output", async () => {
    const result = await compileDocuments(
      [
        {
          file: "selected-contexts.json",
          content: JSON.stringify({
            stroke: {
              $type: "strokeStyle",
              $value: "solid",
              $extensions: {
                "org.token-compiler.contexts": {
                  "theme=dark": { dashArray: [px(1), px(2)], lineCap: "round" },
                },
              },
            },
          }),
        },
      ],
      {
        contexts,
        outputs: [css({ selectors: { "theme=light": ":root" } })],
      },
    );
    expect(result.success).toBe(true);
    expect(result.outputs[0]?.content).toContain("--stroke: solid;");
    expect(result.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: "BACKEND_UNSUPPORTED_VALUE" }),
    );
  });

  it("locates an unsupported contextual value at its selected override", async () => {
    const result = await compileDocuments(
      [
        {
          file: "contextual-diagnostic.json",
          content: JSON.stringify(
            {
              stroke: {
                $type: "strokeStyle",
                $value: "solid",
                $extensions: {
                  "org.token-compiler.contexts": {
                    "theme=dark": { dashArray: [px(1), px(2)], lineCap: "round" },
                  },
                },
              },
            },
            null,
            2,
          ),
        },
      ],
      {
        contexts,
        outputs: [css({ selectors: { "theme=light": ":root", "theme=dark": ".dark" } })],
      },
    );
    const overrideSource = result.graph.tokens[0]?.overrides[0]?.source;
    const diagnostic = result.diagnostics.find(
      (entry) => entry.code === "BACKEND_UNSUPPORTED_VALUE",
    );
    expect(result.success).toBe(false);
    expect(overrideSource).toBeDefined();
    expect(diagnostic?.source).toEqual(overrideSource);
  });

  it.each([
    ["theme=dark&theme=light", ".dark"],
    ["mode=dark", ".dark"],
    ["constructor=alternate", ".alternate"],
    ["theme=sepia", ".sepia"],
    ["theme=dark", "   "],
  ])("rejects invalid configured context selector %s", async (key, selector) => {
    const result = await compileDocuments([contextualSource], {
      contexts: multidimensionalContexts,
      outputs: [css({ selectors: { [key]: selector } })],
    });
    expect(result.success).toBe(false);
    expect(result.outputs).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "BACKEND_INVALID_CONTEXT_SELECTOR", severity: "error" }),
    );
  });

  it("rejects an empty base selector", async () => {
    const result = await compileDocuments([source], { contexts, outputs: [css({ selector: "" })] });
    expect(result.success).toBe(false);
    expect(result.outputs).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "BACKEND_INVALID_CONTEXT_SELECTOR", severity: "error" }),
    );
  });

  it("requires explicit context selectors with a custom base selector", async () => {
    const result = await compileDocuments([source], {
      contexts,
      outputs: [css({ selector: "#app" })],
    });
    expect(result.success).toBe(false);
    expect(result.outputs).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "BACKEND_CONTEXT_COVERAGE", severity: "error" }),
    );
  });

  it("accepts a context dimension named like an object prototype property", async () => {
    const result = await compileDocuments(
      [{ file: "prototype-name.json", content: '{"value":{"$type":"number","$value":1}}' }],
      {
        contexts: { constructor: { default: "base", values: ["base", "alternate"] } },
        outputs: [css({ selectors: { "constructor=alternate": ".alternate" } })],
      },
    );
    expect(result.success).toBe(true);
    expect(result.outputs[0]?.content).toContain(":root {\n  --value: 1;\n}");
  });

  it("rejects configured keys that normalize to the same complete context", async () => {
    const result = await compileDocuments([contextualSource], {
      contexts: multidimensionalContexts,
      outputs: [
        css({
          selectors: {
            "theme=dark": ".dark",
            "theme=dark&brand=consumer": ".also-dark",
          },
        }),
      ],
    });
    expect(result.success).toBe(false);
    expect(result.outputs).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "BACKEND_INVALID_CONTEXT_SELECTOR",
        message: expect.stringContaining("more than once"),
      }),
    );
  });

  it("rejects distinct contexts that reuse the same selector", async () => {
    const result = await compileDocuments([source], {
      contexts,
      outputs: [css({ selectors: { "theme=light": " .tokens ", "theme=dark": ".tokens" } })],
    });
    expect(result.success).toBe(false);
    expect(result.outputs).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "BACKEND_INVALID_CONTEXT_SELECTOR",
        message: expect.stringContaining("same selector `.tokens`"),
      }),
    );
  });

  it("requires an explicit default context when a custom base has explicit variants", async () => {
    const result = await compileDocuments([source], {
      contexts,
      outputs: [css({ selector: "#app", selectors: { "theme=dark": "#app.dark" } })],
    });
    expect(result.success).toBe(false);
    expect(result.outputs).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "BACKEND_CONTEXT_COVERAGE",
        message: expect.stringContaining("explicit default-context selector"),
      }),
    );
  });

  it("rejects a non-default context that aliases the effective base selector", async () => {
    const result = await compileDocuments([source], {
      contexts,
      outputs: [css({ selectors: { "theme=dark": ":root" } })],
    });
    expect(result.success).toBe(false);
    expect(result.outputs).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "BACKEND_INVALID_CONTEXT_SELECTOR",
        message: expect.stringContaining("duplicates the effective base selector"),
      }),
    );
  });
});
