import { compileDocuments } from "@tokenc/core";
import { describe, expect, it } from "vite-plus/test";

import { tailwind } from "../src/index.js";

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

  it("can inline resolved semantic values", async () => {
    const result = await compileDocuments([source], {
      outputs: [tailwind({ references: "resolve" })],
    });
    expect(result.outputs[0]?.content).toContain("--token-color-brand-primary: #0052d9;");
  });
});
