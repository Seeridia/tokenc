import { css } from "@tokenc/backend-css";
import { typescript } from "@tokenc/backend-typescript";
import { defineConfig } from "@tokenc/core";

export default defineConfig({
  source: ["tokens/**/*.json"],
  contexts: {
    theme: { default: "light", values: ["light", "dark"] },
  },
  outputs: [
    css({
      output: "src/generated/tokens.css",
      references: "preserve",
      selectors: {
        "theme=light": ":root",
        "theme=dark": '[data-theme="dark"]',
      },
    }),
    typescript({
      output: "src/generated/tokens.ts",
      mode: "flat",
      references: "symbol",
    }),
  ],
});
