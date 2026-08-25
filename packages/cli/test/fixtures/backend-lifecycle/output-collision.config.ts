import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, type TokenBackend } from "@tokenc/core";

const absoluteOutput = resolve(dirname(fileURLToPath(import.meta.url)), "dist/shared.txt");

const first: TokenBackend = {
  name: "first",
  emit: () => [{ path: absoluteOutput, content: "first" }],
};

const second: TokenBackend = {
  name: "second",
  emit: () => [{ path: "dist/shared.txt", content: "second" }],
};

export default defineConfig({ source: ["tokens.json"], outputs: [first, second] });
