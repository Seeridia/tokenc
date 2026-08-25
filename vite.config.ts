import { fileURLToPath } from "node:url";

import { defineConfig } from "vite-plus";

export default defineConfig({
  resolve: {
    alias: {
      "@tokenc/backend-css": fileURLToPath(
        new URL("./packages/backend-css/src/index.ts", import.meta.url),
      ),
      "@tokenc/backend-tailwind": fileURLToPath(
        new URL("./packages/backend-tailwind/src/index.ts", import.meta.url),
      ),
      "@tokenc/backend-typescript": fileURLToPath(
        new URL("./packages/backend-typescript/src/index.ts", import.meta.url),
      ),
      "@tokenc/cli": fileURLToPath(new URL("./packages/cli/src/index.ts", import.meta.url)),
      "@tokenc/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
    },
  },
  fmt: {
    printWidth: 100,
    tabWidth: 2,
    useTabs: false,
    semi: true,
    singleQuote: false,
    jsxSingleQuote: false,
    quoteProps: "as-needed",
    trailingComma: "all",
    bracketSpacing: true,
    bracketSameLine: false,
    arrowParens: "always",
    endOfLine: "lf",
    insertFinalNewline: true,
    proseWrap: "preserve",
    objectWrap: "preserve",
    sortImports: true,
    sortPackageJson: true,
    ignorePatterns: ["**/dist/**", "**/coverage/**", "**/node_modules/**", "pnpm-lock.yaml"],
  },
  lint: {
    plugins: ["eslint", "typescript", "unicorn", "oxc", "import", "vitest", "promise", "node"],
    categories: {
      correctness: "error",
      suspicious: "error",
      perf: "warn",
    },
    options: {
      denyWarnings: true,
      reportUnusedDisableDirectives: "error",
      typeAware: true,
      typeCheck: true,
    },
    rules: {
      "eslint/eqeqeq": "error",
      "eslint/no-console": "error",
      "eslint/no-debugger": "error",
      "typescript/no-explicit-any": "error",
      "unicorn/no-process-exit": "error",
      "unicorn/prefer-node-protocol": "error",
      "vitest/no-disabled-tests": "error",
      "vitest/no-focused-tests": "error",
      "vite-plus/prefer-vite-plus-imports": "error",
    },
    ignorePatterns: ["**/dist/**", "**/coverage/**", "**/node_modules/**"],
    jsPlugins: [
      {
        name: "vite-plus",
        specifier: "vite-plus/oxlint-plugin",
      },
    ],
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "scripts/test/**/*.test.mjs"],
    coverage: { reporter: ["text", "json-summary"] },
  },
});
