import { css } from "@tokenc/backend-css";
import { defineConfig } from "@tokenc/core";

export default defineConfig({
  source: ["tokens/**/*.json"],
  resolver: {
    source: "tokens.resolver.json",
    input: { theme: "dark" },
  },
  outputs: [css({ output: "dist/tokens.css", references: "preserve" })],
});
