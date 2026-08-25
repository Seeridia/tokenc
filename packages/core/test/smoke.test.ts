import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { VERSION } from "../src/index.js";

const manifest: unknown = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
if (
  typeof manifest !== "object" ||
  manifest === null ||
  !("version" in manifest) ||
  typeof manifest.version !== "string"
)
  throw new TypeError("Core package manifest must contain a string version");

describe("core package", () => {
  it("exports the package manifest version", () => expect(VERSION).toBe(manifest.version));
});
