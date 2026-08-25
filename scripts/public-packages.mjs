import { readdir, readFile } from "node:fs/promises";

const publicPackages = [
  { directory: "packages/core", name: "@tokenc/core" },
  { directory: "packages/backend-css", name: "@tokenc/backend-css" },
  { directory: "packages/backend-tailwind", name: "@tokenc/backend-tailwind" },
  { directory: "packages/backend-typescript", name: "@tokenc/backend-typescript" },
  { directory: "packages/cli", name: "@tokenc/cli" },
];

export async function readPublicPackageDefinitions() {
  return Promise.all(
    publicPackages.map(async ({ directory, name: expectedName }) => {
      const manifest = JSON.parse(await readFile(`${directory}/package.json`, "utf8"));
      if (
        typeof manifest !== "object" ||
        manifest === null ||
        !("name" in manifest) ||
        !("version" in manifest) ||
        typeof manifest.name !== "string" ||
        typeof manifest.version !== "string"
      )
        throw new TypeError(`Invalid package manifest: ${directory}/package.json`);
      if (manifest.name !== expectedName)
        throw new Error(
          `Unexpected package name in ${directory}/package.json: expected ${expectedName}, received ${manifest.name}`,
        );
      return { directory, manifest: { name: manifest.name, version: manifest.version } };
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

export async function readPendingChangesets() {
  const entries = await readdir(".changeset", { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md")
    .map((entry) => entry.name)
    .toSorted();
}
