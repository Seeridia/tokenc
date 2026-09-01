import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { checkPublicContracts } from "../check-public-contracts.mjs";

const directories = [];

async function fixture(expected) {
  const directory = await mkdtemp(join(tmpdir(), "tokenc-contracts-"));
  directories.push(directory);
  await writeFile(join(directory, "public.d.ts"), "export type Value = 1;\n", "utf8");
  const manifestPath = join(directory, "contracts.json");
  await writeFile(
    manifestPath,
    `${JSON.stringify({ schemaVersion: 1, files: { "public.d.ts": expected } })}\n`,
    "utf8",
  );
  return { directory, manifestPath };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("public contract snapshots", () => {
  it("accepts byte-identical declarations", async () => {
    const digest = createHash("sha256").update("export type Value = 1;\n").digest("hex");
    const { directory, manifestPath } = await fixture(digest);

    await expect(checkPublicContracts({ repositoryRoot: directory, manifestPath })).resolves.toBe(
      1,
    );
  });

  it("rejects an unreviewed declaration change", async () => {
    const { directory, manifestPath } = await fixture("0".repeat(64));

    await expect(checkPublicContracts({ repositoryRoot: directory, manifestPath })).rejects.toThrow(
      "Public contract changed",
    );
  });
});
