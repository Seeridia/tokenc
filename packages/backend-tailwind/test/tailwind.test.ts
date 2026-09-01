import {
  compileDocuments as compileSnapshot,
  type CompilationOptions,
  type TokenBackend,
  type TokenSourceInput,
} from "@tokenc/core";
import { describe, expect, it } from "vite-plus/test";

import { tailwind } from "../src/index.js";

async function compileDocuments(
  sources: readonly TokenSourceInput[],
  options: CompilationOptions & { readonly outputs?: readonly TokenBackend[] } = {},
) {
  const { outputs = [], ...compilationOptions } = options;
  const snapshot = await compileSnapshot(sources, compilationOptions);
  if (snapshot.status === "invalid")
    return { success: false, diagnostics: snapshot.diagnostics, outputs: [] };
  const operation = await snapshot.emit(outputs);
  return {
    success: operation.success,
    diagnostics: [...snapshot.diagnostics, ...operation.diagnostics],
    outputs: operation.outputs,
  };
}

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
      brand: { primary: { $value: "{color.blue.600}" } },
    },
    spacing: { "4": { $type: "dimension", $value: { value: 16, unit: "px" } } },
    radius: { md: { $type: "dimension", $value: { value: 8, unit: "px" } } },
  }),
};
const red = { colorSpace: "srgb", components: [1, 0, 0], alpha: 1 };
const px = (value: number) => ({ value, unit: "px" });
const contexts = {
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

describe("Tailwind v4 backend", () => {
  it("shares runtime variables with @theme namespaces", async () => {
    const result = await compileDocuments([source], { outputs: [tailwind()] });
    const output = result.outputs[0]?.content;
    expect(output).toContain("--token-color-brand-primary: var(--token-color-blue-600);");
    expect(output).toContain("@theme {");
    expect(output).toContain("--color-brand-primary: var(--token-color-brand-primary);");
  });

  it("maps dimensions to spacing and radius namespaces", async () => {
    const result = await compileDocuments([source], { outputs: [tailwind()] });
    expect(result.outputs[0]?.content).toContain("--spacing-4: var(--token-spacing-4);");
    expect(result.outputs[0]?.content).toContain("--radius-md: var(--token-radius-md);");
  });

  it("canonicalizes DTCG token segments in Tailwind theme names", async () => {
    const result = await compileDocuments(
      [
        {
          file: "names.json",
          content: JSON.stringify({
            color: {
              $type: "color",
              "brand blue": { $value: red },
              "accent:strong": { $value: red },
              "surface/raised": { $value: red },
            },
          }),
        },
      ],
      { outputs: [tailwind()] },
    );
    expect(result.success).toBe(true);
    expect(result.outputs[0]?.content).toContain(
      "--color-brand-blue: var(--token-color-brand-blue);",
    );
    expect(result.outputs[0]?.content).toContain(
      "--color-accent-strong: var(--token-color-accent-strong);",
    );
    expect(result.outputs[0]?.content).toContain(
      "--color-surface-raised: var(--token-color-surface-raised);",
    );
  });

  it("rejects collisions after canonicalizing final Tailwind theme names", async () => {
    const result = await compileDocuments(
      [
        {
          file: "theme-collision.json",
          content: JSON.stringify({
            color: { "brand blue": { $type: "color", $value: red } },
            "brand:blue": { $type: "color", $value: red },
          }),
        },
      ],
      { outputs: [tailwind()] },
    );
    expect(result.success).toBe(false);
    expect(result.outputs).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "BACKEND_SYMBOL_COLLISION",
        message: expect.stringContaining("--color-brand-blue"),
      }),
    );
  });

  it("can inline resolved semantic values", async () => {
    const result = await compileDocuments([source], {
      outputs: [tailwind({ references: "resolve" })],
    });
    expect(result.outputs[0]?.content).toContain("--token-color-brand-primary: #0052d9;");
  });

  it("preserves non-8-bit sRGB precision through the shared CSS serializer", async () => {
    const result = await compileDocuments(
      [
        {
          file: "precise-color.json",
          content: JSON.stringify({
            color: {
              $type: "color",
              $value: { colorSpace: "srgb", components: [0.1, 0.2, 0.3], alpha: 1 },
            },
          }),
        },
      ],
      { outputs: [tailwind()] },
    );
    expect(result.success).toBe(true);
    expect(result.outputs[0]?.content).toContain("--token-color: color(srgb 0.1 0.2 0.3);");
    expect(result.outputs[0]?.content).not.toContain("--token-color: #1a334d;");
  });

  it("serializes shadow values and gives a top-level shadow a non-empty theme name", async () => {
    const result = await compileDocuments(
      [
        {
          file: "shadow.json",
          content: JSON.stringify({
            shadow: {
              $type: "shadow",
              $value: {
                color: red,
                offsetX: px(0),
                offsetY: px(2),
                blur: px(4),
                spread: px(0),
              },
            },
          }),
        },
      ],
      { outputs: [tailwind()] },
    );
    expect(result.success).toBe(true);
    expect(result.outputs[0]?.content).toContain("--token-shadow: 0px 2px 4px 0px #ff0000;");
    expect(result.outputs[0]?.content).toContain("--shadow-default: var(--token-shadow);");
    expect(result.outputs[0]?.content).not.toContain("--shadow-:");
    expect(result.outputs[0]?.content).not.toContain('{"color"');
  });

  it("reports unsupported CSS value shapes before emitting", async () => {
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
      { outputs: [tailwind()] },
    );
    expect(result.success).toBe(false);
    expect(result.outputs).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "BACKEND_UNSUPPORTED_VALUE", severity: "error" }),
    );
  });

  it("preflights gradients and invalid negative composites before emitting", async () => {
    const result = await compileDocuments(
      [
        {
          file: "unsupported-values.json",
          content: JSON.stringify({
            gradient: {
              $type: "gradient",
              $value: [
                { color: red, position: 0 },
                { color: red, position: 1 },
              ],
            },
            shadow: {
              $type: "shadow",
              $value: {
                color: red,
                offsetX: px(0),
                offsetY: px(1),
                blur: px(-1),
                spread: px(0),
              },
            },
          }),
        },
      ],
      { outputs: [tailwind()] },
    );
    expect(result.success).toBe(false);
    expect(result.outputs).toEqual([]);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "BACKEND_UNSUPPORTED_VALUE",
          message: expect.stringContaining("DTCG gradients define color stops"),
        }),
        expect.objectContaining({
          code: "BACKEND_UNSUPPORTED_VALUE",
          message: expect.stringContaining("shadow blur radii cannot be negative"),
        }),
      ]),
    );
  });

  it("rejects runtime variable collisions after name normalization", async () => {
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
      { outputs: [tailwind()] },
    );
    expect(result.success).toBe(false);
    expect(result.outputs).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "BACKEND_SYMBOL_COLLISION",
        message: expect.stringContaining("--token-foo-bar"),
      }),
    );
  });

  it("uses exact canonical data-context selectors in automatic mode", async () => {
    const result = await compileDocuments(
      [
        {
          file: "theme.json",
          content: JSON.stringify({
            value: {
              $type: "number",
              $value: 0,
              $extensions: { "org.token-compiler.contexts": { "theme=dark": 1 } },
            },
          }),
        },
      ],
      {
        contexts: { theme: contexts.theme },
        outputs: [tailwind()],
      },
    );
    expect(result.success).toBe(true);
    expect(result.outputs[0]?.content).toContain(
      '[data-context="theme=dark"] {\n  --token-value: 1;\n}',
    );
    expect(result.outputs[0]?.content).not.toContain("[data-theme=");
  });

  it("requires explicit selectors for compatible context combinations", async () => {
    const result = await compileDocuments([contextualSource], {
      contexts,
      outputs: [tailwind()],
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
      { contexts, outputs: [tailwind()] },
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
      {
        contexts: { theme: contexts.theme },
        outputs: [tailwind()],
      },
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
        outputs: [tailwind()],
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
        outputs: [tailwind()],
      },
    );
    expect(result.success).toBe(true);
    expect(result.outputs[0]?.content).toContain(
      '[data-context="theme=da%0000rk"] {\n  --token-value: 1;\n}',
    );
  });

  it("treats configured selectors as the explicit context output set", async () => {
    const result = await compileDocuments([contextualSource], {
      contexts,
      outputs: [
        tailwind({
          selectors: {
            "theme=light&brand=consumer": "#app",
            "theme=dark&brand=enterprise": '#app[data-mode="enterprise-dark"]',
          },
        }),
      ],
    });
    expect(result.success).toBe(true);
    const output = result.outputs[0]?.content;
    expect(output).toContain("#app {\n  --token-value: 0;\n}");
    expect(output).toContain('#app[data-mode="enterprise-dark"] {\n  --token-value: 2;\n}');
    expect(output).not.toContain("data-context");
  });

  it.each([
    ["theme=dark&theme=light", ".dark"],
    ["mode=dark", ".dark"],
    ["constructor=alternate", ".alternate"],
    ["theme=sepia", ".sepia"],
    ["theme=dark", "   "],
  ])("rejects invalid configured context selector %s", async (key, selector) => {
    const result = await compileDocuments([contextualSource], {
      contexts,
      outputs: [tailwind({ selectors: { [key]: selector } })],
    });
    expect(result.success).toBe(false);
    expect(result.outputs).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "BACKEND_INVALID_CONTEXT_SELECTOR", severity: "error" }),
    );
  });

  it("rejects configured keys that normalize to the same complete context", async () => {
    const result = await compileDocuments([contextualSource], {
      contexts,
      outputs: [
        tailwind({
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
      outputs: [tailwind({ selectors: { "theme=light": " .tokens ", "theme=dark": ".tokens" } })],
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

  it("rejects a non-default context that aliases the implicit base selector", async () => {
    const result = await compileDocuments([source], {
      contexts,
      outputs: [tailwind({ selectors: { "theme=dark": ":root" } })],
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
