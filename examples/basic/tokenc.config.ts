import { css } from "@tokenc/backend-css";
import { tailwind } from "@tokenc/backend-tailwind";
import { typescript } from "@tokenc/backend-typescript";
import { defineConfig } from "@tokenc/core";

export default defineConfig({
  source: ["tokens/**/*.json"],
  outputs: [
    css({ output: "dist/tokens.css", references: "preserve" }),
    tailwind({ output: "dist/tailwind.css" }),
    typescript({ output: "dist/tokens.ts", mode: "flat", references: "symbol" }),
  ],
});
