#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRepositoryRoot = resolve(import.meta.dirname, "..");

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

export async function checkPublicContracts({
  repositoryRoot = defaultRepositoryRoot,
  manifestPath = resolve(repositoryRoot, "contracts/m1-public-contracts.json"),
} = {}) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.schemaVersion !== 1 || typeof manifest.files !== "object" || !manifest.files)
    throw new TypeError(`Invalid public contract manifest: ${manifestPath}`);
  const comparisons = await Promise.all(
    Object.entries(manifest.files).map(async ([path, expected]) => {
      let content;
      try {
        content = await readFile(resolve(repositoryRoot, path));
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
          throw new Error(`Missing public contract artifact ${path}; run \`vp run build\` first`, {
            cause: error,
          });
        throw error;
      }
      const actual = sha256(content);
      return actual === expected ? undefined : `${path}: expected ${expected}, received ${actual}`;
    }),
  );
  const mismatches = comparisons.filter((entry) => entry !== undefined);
  if (mismatches.length > 0)
    throw new Error(
      `Public contract changed without an explicit snapshot update:\n${mismatches.join("\n")}`,
    );
  return Object.keys(manifest.files).length;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  void checkPublicContracts()
    .then((count) => {
      process.stdout.write(`Verified ${count} public contracts\n`);
      return undefined;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
