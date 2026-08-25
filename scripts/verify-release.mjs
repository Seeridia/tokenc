#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runConsumerSmoke } from "./consumer-smoke.mjs";
import { readPendingChangesets } from "./public-packages.mjs";
import {
  createPackedRelease,
  createRegistryClient,
  planPublication,
  readReleaseManifest,
  RELEASE_TAGS,
  verifyLocalReleaseTags,
  verifyPackedRelease,
  verifyPublishedRelease,
  verifyRemoteReleaseTags,
} from "./release-integrity.mjs";

function output(message) {
  process.stdout.write(`${message}\n`);
}

function parseArguments(arguments_) {
  const allowedArguments = new Set([
    "attempts",
    "commit",
    "delay-ms",
    "manifest",
    "output",
    "phase",
    "registry",
    "remote",
    "tag",
  ]);
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument?.startsWith("--")) throw new Error(`Unexpected argument: ${String(argument)}`);
    const name = argument.slice(2);
    if (!allowedArguments.has(name)) throw new Error(`Unexpected argument: ${argument}`);
    if (values.has(name)) throw new Error(`Duplicate argument: ${argument}`);
    const value = arguments_[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
    values.set(name, value);
    index += 1;
  }
  const phase = values.get("phase");
  const phases = ["packed", "prepublish", "local-tags", "published", "remote-tags"];
  if (!phase || !phases.includes(phase))
    throw new Error("Expected --phase packed|prepublish|local-tags|published|remote-tags");
  const tag = values.get("tag");
  if (tag && !RELEASE_TAGS.includes(tag))
    throw new Error(`Expected --tag to be one of: ${RELEASE_TAGS.join(", ")}`);
  const attempts = values.has("attempts") ? Number(values.get("attempts")) : undefined;
  if (attempts !== undefined && (!Number.isSafeInteger(attempts) || attempts < 1))
    throw new Error("--attempts must be a positive integer");
  const delayMs = values.has("delay-ms") ? Number(values.get("delay-ms")) : undefined;
  if (delayMs !== undefined && (!Number.isSafeInteger(delayMs) || delayMs < 0))
    throw new Error("--delay-ms must be a non-negative integer");
  return {
    phase,
    tag,
    commit: values.get("commit"),
    outputDirectory: values.get("output"),
    manifestPath: values.get("manifest"),
    registry: values.get("registry"),
    remote: values.get("remote") ?? "origin",
    attempts,
    delayMs,
  };
}

function gitHead() {
  return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function requireValue(value, description) {
  if (!value) throw new Error(`Expected ${description}`);
  return value;
}

function assertManifestArguments(release, options) {
  if (options.tag && options.tag !== release.tag)
    throw new Error(`Requested dist-tag ${options.tag} does not match manifest tag ${release.tag}`);
  if (options.commit && options.commit !== release.commit)
    throw new Error(`Requested commit ${options.commit} does not match manifest ${release.commit}`);
  const head = gitHead();
  if (head !== release.commit)
    throw new Error(`HEAD ${head} does not match release manifest commit ${release.commit}`);
}

async function loadManifest(options) {
  const manifestPath = resolve(requireValue(options.manifestPath, "--manifest <path>"));
  const release = await readReleaseManifest(manifestPath);
  assertManifestArguments(release, options);
  return release;
}

async function verifyPrepublish(release, options) {
  const pendingChangesets = await readPendingChangesets();
  if (pendingChangesets.length > 0)
    throw new Error(
      `Refusing release while changesets are pending: ${pendingChangesets.map((name) => `.changeset/${name}`).join(", ")}`,
    );
  await verifyPackedRelease(release);
  const plan = await planPublication({
    release,
    registryClient: createRegistryClient({ registry: options.registry }),
  });
  for (const { candidate, status } of plan.states)
    output(`${candidate.name}@${candidate.version}: ${status}`);
  output(
    `Pre-publish verification passed: ${plan.missing.length} package(s) to publish, ${plan.verified.length} verified`,
  );
}

async function verifyPublished(release, options) {
  const retryOptions = {};
  if (options.attempts !== undefined) retryOptions.attempts = options.attempts;
  if (options.delayMs !== undefined) retryOptions.delayMs = options.delayMs;
  await verifyPublishedRelease({
    release,
    registryClient: createRegistryClient({ registry: options.registry }),
    ...retryOptions,
  });
  await runConsumerSmoke({
    source: "registry",
    packages: release.packages,
    version: release.version,
    registry: options.registry,
  });
  output(`Published release ${release.version} passed registry, provenance, and consumer checks`);
}

export async function runVerifyRelease(arguments_) {
  const options = parseArguments(arguments_);
  if (options.phase === "packed") {
    const outputDirectory = resolve(requireValue(options.outputDirectory, "--output <directory>"));
    const tag = requireValue(options.tag, "--tag <latest|next|beta>");
    const commit = options.commit ?? gitHead();
    const { manifestPath } = await createPackedRelease({ outputDirectory, tag, commit });
    const release = await readReleaseManifest(manifestPath);
    await verifyPackedRelease(release);
    await runConsumerSmoke({
      source: "packed",
      packages: release.packages,
      version: release.version,
    });
    output(`Packed release verified: ${manifestPath}`);
    return;
  }

  const release = await loadManifest(options);
  if (options.phase === "prepublish") {
    await verifyPrepublish(release, options);
    return;
  }
  if (options.phase === "local-tags") {
    verifyLocalReleaseTags(release);
    output(`Verified ${release.packages.length} local annotated release tags`);
    return;
  }
  if (options.phase === "published") {
    await verifyPublished(release, options);
    return;
  }
  if (options.phase === "remote-tags") {
    verifyRemoteReleaseTags(release, options.remote);
    output(
      `Verified ${release.packages.length} remote annotated release tags on ${options.remote}`,
    );
    return;
  }
  throw new Error(`Unknown release verification phase: ${options.phase}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runVerifyRelease(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
