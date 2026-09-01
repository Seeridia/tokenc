import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export const PUBLIC_PACKAGES = Object.freeze(
  [
    { directory: "packages/core", name: "@tokenc/core" },
    { directory: "packages/backend-css", name: "@tokenc/backend-css" },
    { directory: "packages/backend-tailwind", name: "@tokenc/backend-tailwind" },
    { directory: "packages/backend-typescript", name: "@tokenc/backend-typescript" },
    { directory: "packages/cli", name: "@tokenc/cli" },
    { directory: "packages/language-server", name: "@tokenc/language-server" },
  ].map((definition) => Object.freeze(definition)),
);

export function packageArchiveName(name, version) {
  return `${name.replace(/^@/u, "").replace("/", "-")}-${version}.tgz`;
}

export function packageReleaseTag(name, version) {
  return `${name}@${version}`;
}

export async function readPublicPackageDefinitions(repositoryRoot = process.cwd()) {
  return Promise.all(
    PUBLIC_PACKAGES.map(async ({ directory, name: expectedName }) => {
      const manifestPath = join(repositoryRoot, directory, "package.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      if (
        typeof manifest !== "object" ||
        manifest === null ||
        !("name" in manifest) ||
        !("version" in manifest) ||
        typeof manifest.name !== "string" ||
        typeof manifest.version !== "string"
      )
        throw new TypeError(`Invalid package manifest: ${manifestPath}`);
      if (manifest.name !== expectedName)
        throw new Error(
          `Unexpected package name in ${directory}/package.json: expected ${expectedName}, received ${manifest.name}`,
        );
      return { directory, manifest };
    }),
  );
}

export function assertAlignedPublicVersions(packageDefinitions) {
  const versions = new Set(packageDefinitions.map(({ manifest }) => manifest.version));
  if (versions.size !== 1) {
    const details = packageDefinitions
      .map(({ manifest }) => `${manifest.name}@${manifest.version}`)
      .join(", ");
    throw new Error(`Public package versions must remain aligned: ${details}`);
  }
  const version = packageDefinitions[0]?.manifest.version;
  if (!version) throw new Error("No public packages are configured");
  return version;
}

export async function readPendingChangesets(repositoryRoot = process.cwd()) {
  const entries = await readdir(join(repositoryRoot, ".changeset"), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md")
    .map((entry) => entry.name)
    .toSorted();
}
