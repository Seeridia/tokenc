import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const packageDirectories = [
  "packages/core",
  "packages/backend-css",
  "packages/backend-tailwind",
  "packages/backend-typescript",
  "packages/cli",
];

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

const destination = await mkdtemp(join(tmpdir(), "tokenc-publish-"));
const packageDefinitions = await Promise.all(
  packageDirectories.map(async (directory) => ({
    directory,
    manifest: JSON.parse(await readFile(join(directory, "package.json"), "utf8")),
  })),
);

try {
  for (const { directory, manifest } of packageDefinitions) {
    const { name, version } = manifest;
    if (typeof name !== "string" || typeof version !== "string") {
      throw new TypeError(`Invalid package manifest: ${directory}/package.json`);
    }
    if (!dryRun && packageIsPublished(name, version)) {
      output(`Skipping ${name}@${version}: already published`);
      continue;
    }

    execFileSync("pnpm", ["--filter", name, "pack", "--pack-destination", destination], {
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
