#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readPendingChangesets } from "./public-packages.mjs";
import {
  assertReleaseEnvironment,
  createPackedRelease,
  createRegistryClient,
  DEFAULT_REGISTRY,
  publishRelease,
  readReleaseManifest,
  RELEASE_TAGS,
  verifyPackedRelease,
} from "./release-integrity.mjs";

function output(message) {
  process.stdout.write(`${message}\n`);
}

function parseArguments(arguments_) {
  const options = { dryRun: false, tag: "latest", registry: DEFAULT_REGISTRY };
  const seen = new Set();
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--dry-run") {
      if (seen.has(argument)) throw new Error(`Duplicate argument: ${argument}`);
      seen.add(argument);
      options.dryRun = true;
      continue;
    }
    if (!["--manifest", "--registry", "--tag"].includes(argument))
      throw new Error(`Unexpected argument: ${String(argument)}`);
    if (seen.has(argument)) throw new Error(`Duplicate argument: ${argument}`);
    seen.add(argument);
    const value = arguments_[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
    options[argument.slice(2)] = value;
    index += 1;
  }
  if (!RELEASE_TAGS.includes(options.tag))
    throw new Error(`Expected --tag to be one of: ${RELEASE_TAGS.join(", ")}`);
  if (!options.dryRun && !options.manifest)
    throw new Error("Publishing requires --manifest <path>; use --dry-run for a local rehearsal");
  return options;
}

function gitHead(runCommand) {
  return runCommand("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function assertManifestMatches(release, options, head) {
  if (release.tag !== options.tag)
    throw new Error(`Requested dist-tag ${options.tag} does not match manifest tag ${release.tag}`);
  if (release.commit !== head)
    throw new Error(`HEAD ${head} does not match release manifest commit ${release.commit}`);
}

async function checkPendingChangesets({ dryRun, repositoryRoot, writeOutput }) {
  const pendingChangesets = await readPendingChangesets(repositoryRoot);
  if (pendingChangesets.length === 0) return;
  const details = pendingChangesets.map((name) => `.changeset/${name}`).join(", ");
  const message = `Release is blocked while changesets are pending (${details})`;
  if (!dryRun) throw new Error(message);
  writeOutput(`Dry-run only: ${message}`);
}

function publishArchive(runCommand, candidate, tag, registry, dryRun) {
  const publishArguments = [
    "publish",
    candidate.archivePath,
    "--access",
    "public",
    "--tag",
    tag,
    "--registry",
    registry,
  ];
  publishArguments.push(dryRun ? "--dry-run" : "--provenance");
  runCommand("npm", publishArguments, { stdio: "inherit" });
}

export async function runPublishPackages(
  arguments_,
  {
    repositoryRoot = process.cwd(),
    environment = process.env,
    runCommand = execFileSync,
    writeOutput = output,
    registryClientFactory = createRegistryClient,
    packRelease = createPackedRelease,
    loadRelease = readReleaseManifest,
    verifyRelease = verifyPackedRelease,
    assertEnvironment = assertReleaseEnvironment,
    publish = publishRelease,
  } = {},
) {
  const options = parseArguments(arguments_);
  let temporaryDirectory;
  try {
    let release;
    if (options.manifest) {
      release = await loadRelease(resolve(repositoryRoot, options.manifest));
    } else {
      temporaryDirectory = await mkdtemp(join(tmpdir(), "tokenc-publish-"));
      const packed = await packRelease({
        repositoryRoot,
        outputDirectory: temporaryDirectory,
        tag: options.tag,
        commit: gitHead(runCommand),
        runCommand,
      });
      release = await loadRelease(packed.manifestPath);
    }

    assertManifestMatches(release, options, gitHead(runCommand));
    await verifyRelease(release);
    await checkPendingChangesets({
      dryRun: options.dryRun,
      repositoryRoot,
      writeOutput,
    });

    if (options.dryRun) {
      for (const candidate of release.packages) {
        publishArchive(runCommand, candidate, release.tag, options.registry, true);
        writeOutput(
          `Dry-run verified ${candidate.name}@${candidate.version} with tag ${release.tag}`,
        );
      }
      return { release, dryRun: true };
    }

    assertEnvironment(release, environment, (gitArguments, commandOptions = {}) =>
      runCommand("git", gitArguments, { encoding: "utf8", ...commandOptions }).trim(),
    );
    const plan = await publish({
      release,
      registryClient: registryClientFactory({ registry: options.registry }),
      publish(candidate, tag) {
        publishArchive(runCommand, candidate, tag, options.registry, false);
        writeOutput(`Published ${candidate.name}@${candidate.version} with tag ${tag}`);
      },
    });
    for (const candidate of plan.verified)
      writeOutput(`Skipping ${candidate.name}@${candidate.version}: registry artifact verified`);
    writeOutput(
      `Publication complete: ${plan.missing.length} published, ${plan.verified.length} already verified`,
    );
    return { release, plan, dryRun: false };
  } finally {
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runPublishPackages(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
