import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const output = resolve(
  process.env.TOKENC_VSIX_OUTPUT ?? join(repositoryRoot, "artifacts/tokenc-vscode.vsix"),
);
const fixedTime = new Date("1980-01-01T00:00:00.000Z");

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: packageRoot,
    encoding: "utf8",
    stdio: options.input ? ["pipe", "inherit", "inherit"] : "inherit",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} exited with status ${String(result.status)}`);
}

async function filesBelow(root, directory = root) {
  const entries = await readdir(directory);
  const files = await Promise.all(
    entries.toSorted().map(async (entry) => {
      const path = join(directory, entry);
      return (await stat(path)).isDirectory() ? filesBelow(root, path) : [relative(root, path)];
    }),
  );
  return files.flat();
}

async function normalizeArchive(raw, destination, temporaryRoot) {
  const expanded = join(
    temporaryRoot,
    `expanded-${createHash("sha256").update(raw).digest("hex").slice(0, 8)}`,
  );
  await mkdir(expanded, { recursive: true });
  run("unzip", ["-q", raw, "-d", expanded]);
  const files = await filesBelow(expanded);
  await Promise.all(files.map((file) => utimes(join(expanded, file), fixedTime, fixedTime)));
  await rm(destination, { force: true });
  run("zip", ["-X", "-q", destination, "-@"], {
    cwd: expanded,
    input: `${files.join("\n")}\n`,
  });
}

async function build(destination, temporaryRoot, suffix) {
  const raw = join(temporaryRoot, `raw-${suffix}.vsix`);
  run("vp", ["exec", "vsce", "package", "--no-dependencies", "--out", raw]);
  await normalizeArchive(raw, destination, temporaryRoot);
}

async function digest(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

await mkdir(dirname(output), { recursive: true });
const temporaryRoot = await mkdtemp(join(tmpdir(), "tokenc-vsix-package-"));
try {
  const comparison = join(temporaryRoot, "comparison.vsix");
  await build(output, temporaryRoot, "primary");
  await build(comparison, temporaryRoot, "comparison");
  const [actual, expected] = await Promise.all([digest(output), digest(comparison)]);
  if (actual !== expected) throw new Error(`VSIX is not deterministic: ${actual} != ${expected}`);
  process.stdout.write(`Created ${output}\nsha256 ${actual}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
