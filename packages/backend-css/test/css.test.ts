import { compileDocuments } from "@tokenc/core";
import { describe, expect, it } from "vite-plus/test";

import { css } from "../src/index.js";

const source = {
  file: "tokens.json",
  content: JSON.stringify({
    color: {
      $type: "color",
      blue: {
        "600": {
          $value: "#0052D9",
          $extensions: { "org.token-compiler.contexts": { "theme=dark": "#77aaff" } },
        },
      },
      brand: { default: { $value: "{color.blue.600}" } },
    },
  }),
};
const contexts = { theme: { default: "light", values: ["light", "dark"] } } as const;

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
      outputs: [css({ name: (token) => `--dt-${token.id}` })],
    });
    expect(result.outputs[0]?.content).toContain("--dt-color.blue.600");
  });
});
