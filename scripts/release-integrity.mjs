import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

import {
  assertAlignedPublicVersions,
  packageArchiveName,
  packageReleaseTag,
  PUBLIC_PACKAGES,
  readPublicPackageDefinitions,
} from "./public-packages.mjs";

export const RELEASE_MANIFEST_SCHEMA = 1;
export const DEFAULT_REGISTRY = "https://registry.npmjs.org";
export const DEFAULT_REPOSITORY = "https://github.com/Seeridia/tokenc";
export const DEFAULT_WORKFLOW_PATH = ".github/workflows/publish.yml";
export const DEFAULT_RELEASE_REF = "refs/heads/main";
export const DEFAULT_REGISTRY_TIMEOUT_MS = 15_000;
export const RELEASE_TAGS = Object.freeze(["latest", "next", "beta"]);

const INTERNAL_DEPENDENCY_SECTIONS = Object.freeze([
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
]);
const TRANSIENT_POST_PUBLISH_CODES = new Set([
  "REGISTRY_NOT_FOUND",
  "REGISTRY_REQUEST_FAILED",
  "REGISTRY_STATE_INCONSISTENT",
  "DIST_TAG_MISMATCH",
  "PROVENANCE_MISSING",
]);
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*))?(?:\+[\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*)?$/u;

export class ReleaseIntegrityError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "ReleaseIntegrityError";
    this.code = code;
  }
}

function fail(code, message, options) {
  throw new ReleaseIntegrityError(code, message, options);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalizeJson(value) {
  if (Array.isArray(value)) return value.map((item) => canonicalizeJson(item));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map((key) => [key, canonicalizeJson(value[key])]),
  );
}

function parseSemanticVersion(version) {
  if (typeof version !== "string") fail("INVALID_SEMVER", `Invalid semantic version: ${version}`);
  const match = SEMVER_PATTERN.exec(version);
  if (!match) fail("INVALID_SEMVER", `Invalid semantic version: ${version}`);
  const prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some((identifier) => /^\d+$/u.test(identifier) && /^0\d+/u.test(identifier)))
    fail("INVALID_SEMVER", `Invalid semantic version: ${version}`);
  return {
    core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])],
    prerelease,
  };
}

export function compareSemanticVersions(leftVersion, rightVersion) {
  const left = parseSemanticVersion(leftVersion);
  const right = parseSemanticVersion(rightVersion);
  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index] > right.core[index]) return 1;
    if (left.core[index] < right.core[index]) return -1;
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^\d+$/u.test(leftIdentifier);
    const rightNumeric = /^\d+$/u.test(rightIdentifier);
    if (leftNumeric && rightNumeric)
      return BigInt(leftIdentifier) > BigInt(rightIdentifier) ? 1 : -1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier > rightIdentifier ? 1 : -1;
  }
  return 0;
}

function assertString(value, description) {
  if (typeof value !== "string" || value.length === 0)
    fail("INVALID_RELEASE_DATA", `${description} must be a non-empty string`);
  return value;
}

function sha512(buffer, encoding) {
  return createHash("sha512").update(buffer).digest(encoding);
}

function sha512Integrity(buffer) {
  return `sha512-${sha512(buffer, "base64")}`;
}

function normalizeRegistry(registry) {
  return registry.replace(/\/+$/u, "");
}

function packageUrlName(name) {
  return encodeURIComponent(name);
}

function packagePurl(name, version) {
  const encodedName = name.startsWith("@") ? `%40${name.slice(1)}` : name;
  return `pkg:npm/${encodedName}@${version}`;
}

function parseTarString(buffer, offset, length) {
  const end = buffer.indexOf(0, offset);
  const boundedEnd = end === -1 || end > offset + length ? offset + length : end;
  return buffer.subarray(offset, boundedEnd).toString("utf8").trim();
}

function parseTarNumber(buffer, offset, length, description) {
  const field = buffer.subarray(offset, offset + length);
  if ((field[0] ?? 0) & 0x80) {
    const bytes = Buffer.from(field);
    bytes[0] &= 0x7f;
    let value = 0;
    for (const byte of bytes) value = value * 256 + byte;
    return value;
  }
  const text = field.toString("ascii").replace(/\0.*$/u, "").trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/u.test(text)) fail("INVALID_TARBALL", `Invalid ${description}: ${text}`);
  return Number.parseInt(text, 8);
}

function parsePax(data) {
  const attributes = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) fail("INVALID_TARBALL", "Invalid PAX record length");
    const recordLength = Number.parseInt(data.subarray(offset, space).toString("ascii"), 10);
    if (
      !Number.isSafeInteger(recordLength) ||
      recordLength <= 0 ||
      offset + recordLength > data.length
    )
      fail("INVALID_TARBALL", "Invalid PAX record boundary");
    const record = data.subarray(space + 1, offset + recordLength - 1).toString("utf8");
    const separator = record.indexOf("=");
    if (separator !== -1) attributes[record.slice(0, separator)] = record.slice(separator + 1);
    offset += recordLength;
  }
  return attributes;
}

function validateArchivePath(path) {
  if (!path.startsWith("package/"))
    fail("INVALID_TARBALL", `Package archive entry must start with package/: ${path}`);
  const packagePath = path.slice("package/".length);
  if (
    packagePath.length === 0 ||
    isAbsolute(packagePath) ||
    packagePath.split("/").some((segment) => segment === "..")
  )
    fail("INVALID_TARBALL", `Unsafe package archive entry: ${path}`);
  return packagePath;
}

/** Inspect an npm .tgz without extracting it to the filesystem. */
export function inspectPackageArchive(archive) {
  let tar;
  try {
    tar = gunzipSync(archive);
  } catch (error) {
    fail("INVALID_TARBALL", "Package archive is not valid gzip data", { cause: error });
  }

  const files = [];
  const contents = new Map();
  const seen = new Set();
  let globalPax = {};
  let localPax = {};
  let longName;
  let offset = 0;

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const name = parseTarString(header, 0, 100);
    const prefix = parseTarString(header, 345, 155);
    const headerPath = prefix ? `${prefix}/${name}` : name;
    const mode = parseTarNumber(header, 100, 8, "tar mode") & 0o777;
    const size = parseTarNumber(header, 124, 12, "tar size");
    const type = String.fromCharCode(header[156] ?? 0);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) fail("INVALID_TARBALL", `Truncated tar entry: ${headerPath}`);
    const data = tar.subarray(dataStart, dataEnd);
    offset = dataStart + Math.ceil(size / 512) * 512;

    if (type === "g") {
      Object.assign(globalPax, parsePax(data));
      continue;
    }
    if (type === "x") {
      localPax = parsePax(data);
      continue;
    }
    if (type === "L") {
      longName = data.toString("utf8").replace(/\0.*$/u, "");
      continue;
    }

    const effectivePath = localPax.path ?? globalPax.path ?? longName ?? headerPath;
    localPax = {};
    longName = undefined;

    if (type === "5") continue;
    if (type !== "0" && type !== "\0")
      fail("INVALID_TARBALL", `Unsupported non-file tar entry ${effectivePath} (type ${type})`);

    const packagePath = validateArchivePath(effectivePath);
    if (seen.has(packagePath))
      fail("INVALID_TARBALL", `Duplicate package archive entry: ${packagePath}`);
    seen.add(packagePath);
    contents.set(packagePath, Buffer.from(data));
    files.push({
      path: packagePath,
      mode,
      size,
      sha512: sha512(data, "hex"),
    });
  }

  files.sort((left, right) => left.path.localeCompare(right.path));
  const packageJson = contents.get("package.json");
  if (!packageJson)
    fail("INVALID_TARBALL", "Package archive does not contain package/package.json");

  let manifest;
  try {
    manifest = JSON.parse(packageJson.toString("utf8"));
  } catch (error) {
    fail("INVALID_TARBALL", "Package archive contains invalid package.json", { cause: error });
  }

  // npm may rewrite package.json key order while preserving its meaning. Canonicalize that one
  // file so candidate/registry comparison remains semantic; every other file stays byte-exact.
  const canonicalManifest = Buffer.from(JSON.stringify(canonicalizeJson(manifest)));
  const manifestFile = files.find((file) => file.path === "package.json");
  manifestFile.size = canonicalManifest.length;
  manifestFile.sha512 = sha512(canonicalManifest, "hex");

  return {
    archiveIntegrity: sha512Integrity(archive),
    archiveSha512: sha512(archive, "hex"),
    contentDigest: sha512(Buffer.from(JSON.stringify(files)), "hex"),
    files,
    manifest,
  };
}

function dependencyMap(manifest, section) {
  const value = manifest[section];
  if (value === undefined) return {};
  if (!isRecord(value))
    fail("INVALID_PACKAGE_MANIFEST", `${manifest.name} ${section} must be an object`);
  return value;
}

export function validatePackedManifest(sourceManifest, packedManifest, publicNames, version) {
  if (!isRecord(packedManifest))
    fail("INVALID_PACKAGE_MANIFEST", "Packed manifest must be an object");
  if (
    packedManifest.name !== sourceManifest.name ||
    packedManifest.version !== sourceManifest.version
  )
    fail(
      "PACKAGE_IDENTITY_MISMATCH",
      `Packed manifest ${String(packedManifest.name)}@${String(packedManifest.version)} does not match ${sourceManifest.name}@${sourceManifest.version}`,
    );

  for (const section of INTERNAL_DEPENDENCY_SECTIONS) {
    const sourceDependencies = dependencyMap(sourceManifest, section);
    const packedDependencies = dependencyMap(packedManifest, section);
    for (const name of publicNames) {
      const sourceRange = sourceDependencies[name];
      const packedRange = packedDependencies[name];
      if (sourceRange === undefined && packedRange === undefined) continue;
      if (sourceRange === undefined || packedRange !== version)
        fail(
          "INTERNAL_DEPENDENCY_MISMATCH",
          `${sourceManifest.name} ${section}.${name} must pack as exact version ${version}, received ${String(packedRange)}`,
        );
    }
    for (const [name, range] of Object.entries(packedDependencies)) {
      if (typeof range === "string" && range.startsWith("workspace:"))
        fail(
          "WORKSPACE_RANGE_PUBLISHED",
          `${sourceManifest.name} ${section}.${name} still contains ${range}`,
        );
    }
  }
}

function validateReleaseTag(tag) {
  if (!RELEASE_TAGS.includes(tag))
    fail("INVALID_DIST_TAG", `Expected --tag to be one of: ${RELEASE_TAGS.join(", ")}`);
}

function validateCommit(commit) {
  if (!/^[a-f\d]{40}$/u.test(commit))
    fail("INVALID_COMMIT", `Expected a full 40-character Git commit, received ${commit}`);
}

export async function createPackedRelease({
  repositoryRoot = process.cwd(),
  outputDirectory,
  tag,
  commit,
  runCommand = execFileSync,
}) {
  validateReleaseTag(tag);
  validateCommit(commit);
  const destination = resolve(outputDirectory);
  await mkdir(destination, { recursive: true });
  const definitions = await readPublicPackageDefinitions(repositoryRoot);
  const version = assertAlignedPublicVersions(definitions);
  const publicNames = new Set(definitions.map(({ manifest }) => manifest.name));
  const packages = [];

  for (const { directory, manifest: sourceManifest } of definitions) {
    runCommand("vp", ["-C", directory, "pm", "pack", "--pack-destination", destination], {
      cwd: repositoryRoot,
      stdio: "inherit",
    });
    const archive = packageArchiveName(sourceManifest.name, sourceManifest.version);
    const archivePath = join(destination, archive);
    const inspection = inspectPackageArchive(readFileSync(archivePath));
    validatePackedManifest(sourceManifest, inspection.manifest, publicNames, version);
    packages.push({
      name: sourceManifest.name,
      version: sourceManifest.version,
      directory,
      archive,
      expectedTag: packageReleaseTag(sourceManifest.name, sourceManifest.version),
      archiveIntegrity: inspection.archiveIntegrity,
      archiveSha512: inspection.archiveSha512,
      contentDigest: inspection.contentDigest,
      files: inspection.files,
      manifest: inspection.manifest,
    });
  }

  const manifest = {
    schemaVersion: RELEASE_MANIFEST_SCHEMA,
    version,
    tag,
    commit,
    packages,
  };
  const manifestPath = join(destination, "release-manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`);
  await writeFile(
    join(destination, "release-tags.txt"),
    `${packages.map(({ expectedTag }) => expectedTag).join("\n")}\n`,
  );
  return { manifest, manifestPath, destination };
}

function validateManifestPackage(candidate, manifestDirectory, expectedDefinition, release) {
  if (!isRecord(candidate))
    fail("INVALID_RELEASE_MANIFEST", "Release package entry must be an object");
  if (
    candidate.name !== expectedDefinition.name ||
    candidate.directory !== expectedDefinition.directory ||
    candidate.version !== release.version ||
    candidate.expectedTag !== packageReleaseTag(candidate.name, candidate.version) ||
    candidate.archive !== packageArchiveName(candidate.name, candidate.version)
  )
    fail("INVALID_RELEASE_MANIFEST", `Unexpected release entry for ${expectedDefinition.name}`);
  const archivePath = resolve(manifestDirectory, candidate.archive);
  const relativeArchive = relative(manifestDirectory, archivePath);
  if (relativeArchive.startsWith("..") || isAbsolute(relativeArchive))
    fail("INVALID_RELEASE_MANIFEST", `Archive escapes release directory: ${candidate.archive}`);
  return { ...candidate, archivePath };
}

export async function readReleaseManifest(manifestPath) {
  const absolutePath = resolve(manifestPath);
  let release;
  try {
    release = JSON.parse(await readFile(absolutePath, "utf8"));
  } catch (error) {
    fail("INVALID_RELEASE_MANIFEST", `Could not read release manifest ${absolutePath}`, {
      cause: error,
    });
  }
  if (!isRecord(release) || release.schemaVersion !== RELEASE_MANIFEST_SCHEMA)
    fail("INVALID_RELEASE_MANIFEST", "Unsupported release manifest schema");
  assertString(release.version, "Release version");
  assertString(release.tag, "Release dist-tag");
  validateReleaseTag(release.tag);
  assertString(release.commit, "Release commit");
  validateCommit(release.commit);
  if (!Array.isArray(release.packages) || release.packages.length !== PUBLIC_PACKAGES.length)
    fail(
      "INVALID_RELEASE_MANIFEST",
      `Release manifest must contain ${PUBLIC_PACKAGES.length} packages`,
    );
  const manifestDirectory = dirname(absolutePath);
  const packages = release.packages.map((candidate, index) =>
    validateManifestPackage(candidate, manifestDirectory, PUBLIC_PACKAGES[index], release),
  );
  return { ...release, packages, manifestPath: absolutePath, manifestDirectory };
}

export async function verifyPackedRelease(release) {
  const names = new Set(release.packages.map(({ name }) => name));
  if (names.size !== PUBLIC_PACKAGES.length)
    fail("INVALID_RELEASE_MANIFEST", "Release manifest contains duplicate package names");
  await Promise.all(
    release.packages.map(async (candidate) => {
      const inspection = inspectPackageArchive(await readFile(candidate.archivePath));
      if (
        inspection.archiveIntegrity !== candidate.archiveIntegrity ||
        inspection.archiveSha512 !== candidate.archiveSha512 ||
        inspection.contentDigest !== candidate.contentDigest
      )
        fail(
          "PACKED_ARTIFACT_CHANGED",
          `${candidate.name}@${candidate.version} changed after packing`,
        );
      validatePackedManifest(candidate.manifest, inspection.manifest, names, release.version);
    }),
  );
}

async function fetchResponse(fetchImplementation, url, description, timeoutMs) {
  let response;
  try {
    response = await fetchImplementation(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    fail("REGISTRY_REQUEST_FAILED", `Could not fetch ${description}: ${String(error)}`, {
      cause: error,
    });
  }
  return response;
}

async function readResponseBody(response, method, description) {
  try {
    return await response[method]();
  } catch (error) {
    return fail("REGISTRY_REQUEST_FAILED", `Could not read ${description}: ${String(error)}`, {
      cause: error,
    });
  }
}

export function createRegistryClient({
  registry = DEFAULT_REGISTRY,
  fetchImplementation = globalThis.fetch,
  timeoutMs = DEFAULT_REGISTRY_TIMEOUT_MS,
} = {}) {
  const base = normalizeRegistry(registry);
  if (typeof fetchImplementation !== "function")
    fail("REGISTRY_REQUEST_FAILED", "A fetch implementation is required");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    fail("REGISTRY_REQUEST_FAILED", "Registry timeout must be a positive integer");

  return {
    async metadata(name, version) {
      const response = await fetchResponse(
        fetchImplementation,
        `${base}/${packageUrlName(name)}/${encodeURIComponent(version)}`,
        `${name}@${version} metadata`,
        timeoutMs,
      );
      if (response.status === 404) return undefined;
      if (!response.ok)
        fail(
          "REGISTRY_REQUEST_FAILED",
          `Registry returned ${response.status} for ${name}@${version} metadata`,
        );
      return readResponseBody(response, "json", `${name}@${version} metadata`);
    },
    async versions(name) {
      const response = await fetchResponse(
        fetchImplementation,
        `${base}/${packageUrlName(name)}`,
        `${name} package metadata`,
        timeoutMs,
      );
      if (response.status === 404) return [];
      if (!response.ok)
        fail(
          "REGISTRY_REQUEST_FAILED",
          `Registry returned ${response.status} for ${name} package metadata`,
        );
      const packument = await readResponseBody(response, "json", `${name} package metadata`);
      if (!isRecord(packument) || !isRecord(packument.versions))
        fail("REGISTRY_IDENTITY_MISMATCH", `${name} package metadata has no versions`);
      return Object.keys(packument.versions);
    },
    async distTags(name) {
      const response = await fetchResponse(
        fetchImplementation,
        `${base}/-/package/${packageUrlName(name)}/dist-tags`,
        `${name} dist-tags`,
        timeoutMs,
      );
      if (!response.ok)
        fail(
          "REGISTRY_REQUEST_FAILED",
          `Registry returned ${response.status} for ${name} dist-tags`,
        );
      return readResponseBody(response, "json", `${name} dist-tags`);
    },
    async archive(url) {
      const response = await fetchResponse(fetchImplementation, url, `${url} tarball`, timeoutMs);
      if (!response.ok)
        fail("REGISTRY_REQUEST_FAILED", `Registry returned ${response.status} for ${url}`);
      return Buffer.from(await readResponseBody(response, "arrayBuffer", `${url} tarball`));
    },
    async attestations(url) {
      const response = await fetchResponse(
        fetchImplementation,
        url,
        `${url} attestations`,
        timeoutMs,
      );
      if (response.status === 404) fail("PROVENANCE_MISSING", `No provenance exists at ${url}`);
      if (!response.ok)
        fail("REGISTRY_REQUEST_FAILED", `Registry returned ${response.status} for ${url}`);
      return readResponseBody(response, "json", `${url} attestations`);
    },
  };
}

function internalDependencies(manifest, publicNames) {
  const result = new Map();
  for (const section of INTERNAL_DEPENDENCY_SECTIONS) {
    const dependencies = dependencyMap(manifest, section);
    for (const [name, range] of Object.entries(dependencies)) {
      if (publicNames.has(name)) result.set(`${section}.${name}`, range);
    }
  }
  return result;
}

function dependencyMapsMatch(expected, received) {
  return (
    expected.size === received.size &&
    [...expected].every(([name, range]) => received.get(name) === range)
  );
}

function assertNoPublishedVersionRegression(candidate, publishedVersions) {
  if (!Array.isArray(publishedVersions))
    fail("REGISTRY_IDENTITY_MISMATCH", `${candidate.name} versions must be an array`);
  for (const publishedVersion of publishedVersions) {
    const comparison = compareSemanticVersions(candidate.version, publishedVersion);
    if (comparison < 0)
      fail(
        "VERSION_REGRESSION",
        `Refusing to publish ${candidate.name}@${candidate.version}: registry already contains newer ${publishedVersion}`,
      );
    if (comparison === 0)
      fail(
        "REGISTRY_STATE_INCONSISTENT",
        `${candidate.name}@${candidate.version} appears in package metadata but its version endpoint is not visible`,
      );
  }
}

function decodeSlsaStatement(attestations) {
  if (!isRecord(attestations) || !Array.isArray(attestations.attestations))
    fail("PROVENANCE_MISSING", "Registry attestation response is malformed");
  const provenance = attestations.attestations.find(
    (attestation) => attestation?.predicateType === "https://slsa.dev/provenance/v1",
  );
  const payload = provenance?.bundle?.dsseEnvelope?.payload;
  if (typeof payload !== "string") fail("PROVENANCE_MISSING", "SLSA provenance payload is missing");
  try {
    return JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
  } catch (error) {
    return fail("PROVENANCE_INVALID", "SLSA provenance payload is not valid JSON", {
      cause: error,
    });
  }
}

export function verifyProvenanceStatement({
  statement,
  name,
  version,
  archiveSha512,
  commit,
  repository = DEFAULT_REPOSITORY,
  workflowPath = DEFAULT_WORKFLOW_PATH,
  ref = DEFAULT_RELEASE_REF,
}) {
  if (statement?.["_type"] !== "https://in-toto.io/Statement/v1")
    fail("PROVENANCE_INVALID", `${name}@${version} has an unexpected statement type`);
  if (statement.predicateType !== "https://slsa.dev/provenance/v1")
    fail("PROVENANCE_INVALID", `${name}@${version} has an unexpected predicate type`);
  const subject = Array.isArray(statement.subject)
    ? statement.subject.find((entry) => entry?.name === packagePurl(name, version))
    : undefined;
  if (subject?.digest?.sha512 !== archiveSha512)
    fail("PROVENANCE_INVALID", `${name}@${version} provenance subject digest does not match`);

  const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow;
  if (
    workflow?.repository !== repository ||
    workflow?.ref !== ref ||
    String(workflow?.path ?? "").replace(/^\//u, "") !== workflowPath
  )
    fail(
      "PROVENANCE_INVALID",
      `${name}@${version} provenance must identify ${repository}/${workflowPath}@${ref}`,
    );

  const dependencies = statement.predicate?.buildDefinition?.resolvedDependencies;
  const source = Array.isArray(dependencies)
    ? dependencies.find(
        (dependency) =>
          typeof dependency?.uri === "string" &&
          dependency.uri.startsWith(`git+${repository}@`) &&
          dependency.digest?.gitCommit === commit,
      )
    : undefined;
  if (!source)
    fail(
      "PROVENANCE_INVALID",
      `${name}@${version} provenance does not resolve to commit ${commit}`,
    );
}

export function verifyPublishedPackage({
  candidate,
  metadata,
  distTags,
  archive,
  attestations,
  release,
  repository = DEFAULT_REPOSITORY,
  workflowPath = DEFAULT_WORKFLOW_PATH,
  ref = DEFAULT_RELEASE_REF,
}) {
  if (
    !isRecord(metadata) ||
    metadata.name !== candidate.name ||
    metadata.version !== candidate.version
  )
    fail(
      "REGISTRY_IDENTITY_MISMATCH",
      `${candidate.name}@${candidate.version} metadata is inconsistent`,
    );
  if (!isRecord(metadata.dist))
    fail(
      "REGISTRY_IDENTITY_MISMATCH",
      `${candidate.name}@${candidate.version} has no dist metadata`,
    );

  const registryInspection = inspectPackageArchive(archive);
  if (metadata.dist.integrity !== registryInspection.archiveIntegrity)
    fail(
      "REGISTRY_INTEGRITY_MISMATCH",
      `${candidate.name}@${candidate.version} dist.integrity is invalid`,
    );
  if (registryInspection.contentDigest !== candidate.contentDigest)
    fail(
      "REGISTRY_ARTIFACT_MISMATCH",
      `${candidate.name}@${candidate.version} registry contents differ from the packed candidate`,
    );

  const publicNames = new Set(release.packages.map(({ name }) => name));
  const expectedDependencies = internalDependencies(candidate.manifest, publicNames);
  const publishedDependencies = internalDependencies(metadata, publicNames);
  if (!dependencyMapsMatch(expectedDependencies, publishedDependencies))
    fail(
      "INTERNAL_DEPENDENCY_MISMATCH",
      `${candidate.name}@${candidate.version} registry internal dependencies do not match the candidate`,
    );

  if (!isRecord(distTags) || distTags[release.tag] !== release.version)
    fail(
      "DIST_TAG_MISMATCH",
      `${candidate.name}@${candidate.version} is not selected by dist-tag ${release.tag}; promote it manually only after verification`,
    );

  if (metadata.dist.attestations?.provenance?.predicateType !== "https://slsa.dev/provenance/v1")
    fail(
      "PROVENANCE_MISSING",
      `${candidate.name}@${candidate.version} metadata has no SLSA provenance`,
    );
  verifyProvenanceStatement({
    statement: decodeSlsaStatement(attestations),
    name: candidate.name,
    version: candidate.version,
    archiveSha512: registryInspection.archiveSha512,
    commit: release.commit,
    repository,
    workflowPath,
    ref,
  });
  return registryInspection;
}

export async function loadPublishedPackage(candidate, registryClient) {
  const metadata = await registryClient.metadata(candidate.name, candidate.version);
  if (!metadata) {
    const publishedVersions = await registryClient.versions(candidate.name);
    assertNoPublishedVersionRegression(candidate, publishedVersions);
    return undefined;
  }
  if (!isRecord(metadata.dist))
    fail(
      "REGISTRY_IDENTITY_MISMATCH",
      `${candidate.name}@${candidate.version} has no dist metadata`,
    );
  const tarball = assertString(
    metadata.dist.tarball,
    `${candidate.name}@${candidate.version} tarball`,
  );
  const attestationUrl = metadata.dist.attestations?.url;
  if (typeof attestationUrl !== "string" || attestationUrl.length === 0)
    fail(
      "PROVENANCE_MISSING",
      `${candidate.name}@${candidate.version} metadata has no attestation URL`,
    );
  const [distTags, archive, attestations] = await Promise.all([
    registryClient.distTags(candidate.name),
    registryClient.archive(tarball),
    registryClient.attestations(attestationUrl),
  ]);
  return { metadata, distTags, archive, attestations };
}

export async function planPublication({
  release,
  registryClient,
  repository = DEFAULT_REPOSITORY,
  workflowPath = DEFAULT_WORKFLOW_PATH,
  ref = DEFAULT_RELEASE_REF,
}) {
  const states = await Promise.all(
    release.packages.map(async (candidate) => {
      const published = await loadPublishedPackage(candidate, registryClient);
      if (!published) return { candidate, status: "missing" };
      verifyPublishedPackage({
        candidate,
        ...published,
        release,
        repository,
        workflowPath,
        ref,
      });
      return { candidate, status: "verified" };
    }),
  );
  return {
    states,
    missing: states.filter(({ status }) => status === "missing").map(({ candidate }) => candidate),
    verified: states
      .filter(({ status }) => status === "verified")
      .map(({ candidate }) => candidate),
  };
}

export async function publishRelease({ release, registryClient, publish, ...expectations }) {
  const plan = await planPublication({ release, registryClient, ...expectations });
  // Internal dependencies must become visible before their dependants are published.
  // eslint-disable-next-line no-await-in-loop
  for (const candidate of plan.missing) await publish(candidate, release.tag);
  return plan;
}

export async function verifyPublishedRelease({
  release,
  registryClient,
  attempts = 18,
  delayMs = 10_000,
  sleep = (duration) => new Promise((resolveSleep) => setTimeout(resolveSleep, duration)),
  ...expectations
}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      // Registry visibility is checked as a bounded sequence of coherent snapshots.
      // eslint-disable-next-line no-await-in-loop
      const plan = await planPublication({ release, registryClient, ...expectations });
      if (plan.missing.length > 0)
        fail(
          "REGISTRY_NOT_FOUND",
          `Registry is missing ${plan.missing.map(({ name, version }) => `${name}@${version}`).join(", ")}`,
        );
      return plan;
    } catch (error) {
      lastError = error;
      if (
        attempt === attempts ||
        !(error instanceof ReleaseIntegrityError) ||
        !TRANSIENT_POST_PUBLISH_CODES.has(error.code)
      )
        throw error;
      // eslint-disable-next-line no-await-in-loop
      await sleep(delayMs);
    }
  }
  throw lastError;
}

function defaultGit(args, options = {}) {
  return execFileSync("git", args, { encoding: "utf8", ...options }).trim();
}

export function verifyLocalReleaseTags(release, runGit = defaultGit) {
  for (const { expectedTag } of release.packages) {
    const ref = `refs/tags/${expectedTag}`;
    const type = runGit(["cat-file", "-t", ref]);
    if (type !== "tag") fail("RELEASE_TAG_INVALID", `${expectedTag} must be an annotated tag`);
    const commit = runGit(["rev-parse", `${ref}^{}`]);
    if (commit !== release.commit)
      fail("RELEASE_TAG_INVALID", `${expectedTag} peels to ${commit}, expected ${release.commit}`);
  }
}

export function verifyRemoteReleaseTags(release, remote = "origin", runGit = defaultGit) {
  const patterns = release.packages.flatMap(({ expectedTag }) => [
    `refs/tags/${expectedTag}`,
    `refs/tags/${expectedTag}^{}`,
  ]);
  const output = runGit(["ls-remote", "--tags", remote, ...patterns]);
  const refs = new Map(
    output
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [object, ref] = line.split(/\s+/u);
        return [ref, object];
      }),
  );
  for (const { expectedTag } of release.packages) {
    const ref = `refs/tags/${expectedTag}`;
    if (!refs.has(ref)) fail("RELEASE_TAG_MISSING", `Remote ${remote} is missing ${expectedTag}`);
    if (refs.get(`${ref}^{}`) !== release.commit)
      fail(
        "RELEASE_TAG_INVALID",
        `Remote ${expectedTag} must be annotated and peel to ${release.commit}`,
      );
  }
}

export function assertReleaseEnvironment(release, environment = process.env, runGit = defaultGit) {
  if (environment.GITHUB_ACTIONS !== "true")
    fail("RELEASE_ENVIRONMENT_INVALID", "Publishing is allowed only from GitHub Actions");
  if (environment.GITHUB_REF !== DEFAULT_RELEASE_REF)
    fail(
      "RELEASE_ENVIRONMENT_INVALID",
      `Publishing requires ${DEFAULT_RELEASE_REF}, received ${String(environment.GITHUB_REF)}`,
    );
  if (environment.GITHUB_SHA !== release.commit)
    fail(
      "RELEASE_ENVIRONMENT_INVALID",
      `GITHUB_SHA ${String(environment.GITHUB_SHA)} does not match release commit ${release.commit}`,
    );
  const head = runGit(["rev-parse", "HEAD"]);
  if (head !== release.commit)
    fail(
      "RELEASE_ENVIRONMENT_INVALID",
      `HEAD ${head} does not match release commit ${release.commit}`,
    );
}
