import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(packageRoot, "../cli/node_modules/jiti/dist/babel.cjs");
const destination = resolve(packageRoot, "dist/babel.cjs");

await mkdir(dirname(destination), { recursive: true });
await copyFile(source, destination);
