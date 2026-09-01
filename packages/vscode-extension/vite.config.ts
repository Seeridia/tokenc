import { fileURLToPath } from "node:url";

import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    alias: {
      "@tokenc/backend-css": fileURLToPath(new URL("../backend-css/src/index.ts", import.meta.url)),
      "@tokenc/backend-tailwind": fileURLToPath(
        new URL("../backend-tailwind/src/index.ts", import.meta.url),
      ),
      "@tokenc/backend-typescript": fileURLToPath(
        new URL("../backend-typescript/src/index.ts", import.meta.url),
      ),
      "@tokenc/cli": fileURLToPath(new URL("../cli/src/index.ts", import.meta.url)),
      "@tokenc/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
      "@tokenc/language-server": fileURLToPath(
        new URL("../language-server/src/index.ts", import.meta.url),
      ),
      "jsonc-parser": fileURLToPath(
        new URL("../core/node_modules/jsonc-parser/lib/esm/main.js", import.meta.url),
      ),
    },
    entry: {
      extension: "src/extension.ts",
      server: "src/server.ts",
      smoke: "test/smoke.ts",
    },
    clean: true,
    deps: {
      alwaysBundle: (id) => id !== "vscode" && !id.startsWith("node:"),
      neverBundle: ["vscode"],
      onlyBundle: false,
    },
    dts: false,
    fixedExtension: true,
    format: ["cjs"],
    hash: false,
    platform: "node",
    sourcemap: true,
    target: "node22",
    tsconfig: "tsconfig.json",
  },
});
