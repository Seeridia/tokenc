import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

const workspace = fileURLToPath(new URL("../../..", import.meta.url));
const coreSource = resolve(workspace, "packages/core/src");
const consumerRoots = [
  "packages/cli/src",
  "packages/backend-css/src",
  "packages/backend-tailwind/src",
  "packages/backend-typescript/src",
].map((path) => resolve(workspace, path));

async function sourceFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) => {
        const path = resolve(directory, entry.name);
        return entry.isDirectory() ? sourceFiles(path) : Promise.resolve([path]);
      }),
    )
  )
    .flat()
    .filter((path) => extname(path) === ".ts");
}

describe("public consumer architecture", () => {
  it("keeps the CLI and bundled backends on the @tokenc/core root API", async () => {
    const violations: string[] = [];
    const files = (await Promise.all(consumerRoots.map(sourceFiles))).flat();
    const sources = await Promise.all(
      files.map(async (file) => ({ file, source: await readFile(file, "utf8") })),
    );
    for (const { file, source } of sources) {
      for (const match of source.matchAll(/(?:from\s+|import\s*\()["']([^"']+)["']/gu)) {
        const specifier = match[1];
        if (!specifier) continue;
        const deepCoreImport = specifier.startsWith("@tokenc/core/");
        const relativeTarget = specifier.startsWith(".")
          ? resolve(dirname(file), specifier.replace(/\.js$/u, ".ts"))
          : undefined;
        if (deepCoreImport || relativeTarget?.startsWith(`${coreSource}/`))
          violations.push(`${file}: ${specifier}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps CLI compilation on CompilerSession instead of the one-shot compile facade", async () => {
    const source = await readFile(resolve(workspace, "packages/cli/src/index.ts"), "utf8");
    expect(source).toContain("createCompilerSession");
    expect(source).not.toMatch(/\bcompile\s*\(/u);
  });
});
