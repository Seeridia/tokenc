import { assertAlignedPublicVersions, readPublicPackageDefinitions } from "./public-packages.mjs";

const packageDefinitions = await readPublicPackageDefinitions();
const version = assertAlignedPublicVersions(packageDefinitions);

process.stdout.write(`Public package versions are aligned at ${version}\n`);
