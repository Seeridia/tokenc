import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertAlignedPublicVersions,
  readPendingChangesets,
  readPublicPackageDefinitions,
} from "./public-packages.mjs";

const cliArguments = process.argv.slice(2);
const tagIndex = cliArguments.indexOf("--tag");
const tag = tagIndex === -1 ? "latest" : cliArguments[tagIndex + 1];
const dryRun = cliArguments.includes("--dry-run");
const allowedTags = new Set(["latest", "next", "beta"]);

if (!tag || !allowedTags.has(tag)) {
  throw new Error("Expected --tag to be one of: latest, next, beta");
}

function output(message) {
  process.stdout.write(`${message}\n`);
}

function packageIsPublished(name, version) {
  const result = spawnSync("npm", ["view", `${name}@${version}`, "version", "--json"], {
    encoding: "utf8",
  });
  if (result.status === 0) return true;
  const diagnostic = `${result.stdout}${result.stderr}`;
  if (diagnostic.includes("E404") || diagnostic.includes("404 Not Found")) return false;
  throw new Error(`Could not query ${name}@${version}:\n${diagnostic.trim()}`);
}

function archiveName(name, version) {
  return `${name.replace(/^@/u, "").replace("/", "-")}-${version}.tgz`;
}

const packageDefinitions = await readPublicPackageDefinitions();
const alignedVersion = assertAlignedPublicVersions(packageDefinitions);
const pendingChangesets = await readPendingChangesets();

if (pendingChangesets.length > 0) {
  const details = pendingChangesets.map((name) => `.changeset/${name}`).join(", ");
  if (!dryRun) {
    throw new Error(
      `Refusing to publish ${alignedVersion} while changesets are pending (${details}). Merge the generated Version Packages pull request first.`,
    );
  }
  output(
    `Dry-run only: publishing ${alignedVersion} would be blocked while changesets are pending (${details})`,
  );
}

const destination = await mkdtemp(join(tmpdir(), "tokenc-publish-"));

try {
  for (const { directory, manifest } of packageDefinitions) {
    const { name, version } = manifest;
    if (!dryRun && packageIsPublished(name, version)) {
      output(`Skipping ${name}@${version}: already published`);
      continue;
    }

    execFileSync("vp", ["-C", directory, "pm", "pack", "--pack-destination", destination], {
      stdio: "inherit",
    });
    const archive = join(destination, archiveName(name, version));

    if (dryRun) {
      output(`Would publish ${name}@${version} with npm tag ${tag}`);
      continue;
    }
    execFileSync("npm", ["publish", archive, "--access", "public", "--tag", tag], {
      stdio: "inherit",
    });
  }
} finally {
  await rm(destination, { recursive: true, force: true });
}
