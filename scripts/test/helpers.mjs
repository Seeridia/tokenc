import { gzipSync } from "node:zlib";

import { inspectPackageArchive } from "../release-integrity.mjs";

export const COMMIT = "0123456789abcdef0123456789abcdef01234567";
export const VERSION = "1.2.3";

function writeTarString(header, offset, length, value) {
  header.write(value, offset, Math.min(length, Buffer.byteLength(value)), "utf8");
}

function writeTarNumber(header, offset, length, value) {
  header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");
}

function tarEntry(path, contents, mode = 0o644) {
  const data = Buffer.from(contents);
  const header = Buffer.alloc(512);
  writeTarString(header, 0, 100, path);
  writeTarNumber(header, 100, 8, mode);
  writeTarNumber(header, 108, 8, 0);
  writeTarNumber(header, 116, 8, 0);
  writeTarNumber(header, 124, 12, data.length);
  writeTarNumber(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeTarString(header, 257, 6, "ustar");
  writeTarString(header, 263, 2, "00");
  writeTarNumber(
    header,
    148,
    8,
    [...header].reduce((sum, byte) => sum + byte, 0),
  );
  return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

export function packageArchive(manifest, marker = "candidate") {
  return gzipSync(
    Buffer.concat([
      tarEntry("package/package.json", `${JSON.stringify(manifest)}\n`),
      tarEntry("package/index.js", `export default ${JSON.stringify(marker)};\n`),
      Buffer.alloc(1024),
    ]),
    { mtime: 0 },
  );
}

export function releaseFixture({ packageCount = 2, tag = "latest" } = {}) {
  const definitions = [
    { name: "@tokenc/core", directory: "packages/core" },
    { name: "@tokenc/backend-css", directory: "packages/backend-css" },
    { name: "@tokenc/backend-tailwind", directory: "packages/backend-tailwind" },
  ].slice(0, packageCount);
  const packages = definitions.map(({ name, directory }) => {
    const manifest = {
      name,
      version: VERSION,
      ...(name === "@tokenc/backend-css" ? { dependencies: { "@tokenc/core": VERSION } } : {}),
      ...(name === "@tokenc/backend-tailwind"
        ? {
            dependencies: {
              "@tokenc/core": VERSION,
              "@tokenc/backend-css": VERSION,
            },
          }
        : {}),
    };
    const archive = packageArchive(manifest);
    const inspection = inspectPackageArchive(archive);
    return {
      name,
      version: VERSION,
      directory,
      archive: `${name.slice(1).replace("/", "-")}-${VERSION}.tgz`,
      archivePath: `/release/${name.slice(1).replace("/", "-")}-${VERSION}.tgz`,
      expectedTag: `${name}@${VERSION}`,
      archiveIntegrity: inspection.archiveIntegrity,
      archiveSha512: inspection.archiveSha512,
      contentDigest: inspection.contentDigest,
      files: inspection.files,
      manifest,
      archiveBuffer: archive,
    };
  });
  return { schemaVersion: 1, version: VERSION, tag, commit: COMMIT, packages };
}

export function publishedFixture(candidate, release, overrides = {}) {
  const archive = overrides.archive ?? candidate.archiveBuffer;
  const inspection = inspectPackageArchive(archive);
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    predicateType: "https://slsa.dev/provenance/v1",
    subject: [
      {
        name: `pkg:npm/%40${candidate.name.slice(1)}@${candidate.version}`,
        digest: { sha512: inspection.archiveSha512 },
      },
    ],
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            repository: "https://github.com/Seeridia/tokenc",
            ref: "refs/heads/main",
            path: ".github/workflows/publish.yml",
          },
        },
        resolvedDependencies: [
          {
            uri: `git+https://github.com/Seeridia/tokenc@${release.commit}`,
            digest: { gitCommit: overrides.provenanceCommit ?? release.commit },
          },
        ],
      },
    },
  };
  const tarball = `https://registry.example/${candidate.name}/-/${candidate.archive}`;
  const attestationUrl = `${tarball}.attestations`;
  return {
    metadata: {
      ...candidate.manifest,
      ...overrides.metadata,
      dist: {
        integrity: inspection.archiveIntegrity,
        tarball,
        attestations: {
          url: attestationUrl,
          provenance: { predicateType: "https://slsa.dev/provenance/v1" },
        },
      },
    },
    distTags: overrides.distTags ?? { [release.tag]: release.version },
    archive,
    attestations: {
      attestations: [
        {
          predicateType: "https://slsa.dev/provenance/v1",
          bundle: {
            dsseEnvelope: {
              payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
            },
          },
        },
      ],
    },
  };
}

export function registryFixture(
  release,
  publishedNames = release.packages.map(({ name }) => name),
) {
  const records = new Map(
    release.packages
      .filter(({ name }) => publishedNames.includes(name))
      .map((candidate) => [candidate.name, publishedFixture(candidate, release)]),
  );
  return {
    records,
    client: {
      async metadata(name) {
        return records.get(name)?.metadata;
      },
      async versions(name) {
        return records.has(name) ? [VERSION] : [];
      },
      async distTags(name) {
        return records.get(name)?.distTags;
      },
      async archive(url) {
        return [...records.values()].find(({ metadata }) => metadata.dist.tarball === url)?.archive;
      },
      async attestations(url) {
        return [...records.values()].find(({ metadata }) => metadata.dist.attestations.url === url)
          ?.attestations;
      },
    },
  };
}
