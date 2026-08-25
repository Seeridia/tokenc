import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

const PUBLIC_PACKAGE_NAMES = Object.freeze([
  "@tokenc/core",
  "@tokenc/cli",
  "@tokenc/backend-css",
  "@tokenc/backend-tailwind",
  "@tokenc/backend-typescript",
]);

const EXPECTED_OUTPUTS = Object.freeze([
  Object.freeze({
    path: "dist/tokens.css",
    content: ":root {\n  --spacing-4: 16px;\n}\n",
  }),
  Object.freeze({
    path: "dist/tailwind.css",
    content:
      ":root {\n  --token-spacing-4: 16px;\n}\n\n@theme {\n  --spacing-4: var(--token-spacing-4);\n}\n",
  }),
  Object.freeze({
    path: "dist/tokens.ts",
    content: 'export const spacing4 = "16px";\n',
  }),
]);

const TOKEN_DOCUMENT = Object.freeze({
  spacing: Object.freeze({
    4: Object.freeze({
      $type: "dimension",
      $value: Object.freeze({ value: 16, unit: "px" }),
    }),
  }),
});

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function packageName(candidate) {
  if (typeof candidate === "string") return candidate;
  if (!isRecord(candidate)) return undefined;
  if (typeof candidate.name === "string") return candidate.name;
  return isRecord(candidate.manifest) && typeof candidate.manifest.name === "string"
    ? candidate.manifest.name
    : undefined;
}

function packageVersion(candidate) {
  if (!isRecord(candidate)) return undefined;
  if (typeof candidate.version === "string") return candidate.version;
  return isRecord(candidate.manifest) && typeof candidate.manifest.version === "string"
    ? candidate.manifest.version
    : undefined;
}

function packedPackageSpec(candidate, invocationDirectory) {
  const value =
    typeof candidate === "string"
      ? candidate
      : isRecord(candidate)
        ? [
            candidate.archivePath,
            candidate.path,
            candidate.archive,
            candidate.tarball,
            candidate.spec,
          ].find((entry) => typeof entry === "string" && entry.length > 0)
        : undefined;
  if (typeof value !== "string" || value.length === 0)
    throw new TypeError("Every packed package must provide a tarball path");
  if (isAbsolute(value) || value.startsWith("file:") || /^[a-z][a-z\d+.-]*:\/\//iu.test(value))
    return value;
  return resolve(invocationDirectory, value);
}

function normalizeInstallPlan(source, packages, version) {
  if (source !== "packed" && source !== "registry")
    throw new TypeError('source must be either "packed" or "registry"');
  if (!Array.isArray(packages) || packages.length !== PUBLIC_PACKAGE_NAMES.length)
    throw new TypeError(`packages must contain exactly ${PUBLIC_PACKAGE_NAMES.length} entries`);
  if (version !== undefined && (typeof version !== "string" || version.length === 0))
    throw new TypeError("version must be a non-empty string when provided");

  const invocationDirectory = process.cwd();
  const namedEntries = [];
  const specs = packages.map((candidate) => {
    const name =
      source === "packed" && typeof candidate === "string" ? undefined : packageName(candidate);
    const declaredVersion = packageVersion(candidate);
    if (name !== undefined) namedEntries.push(name);
    if (name !== undefined && !PUBLIC_PACKAGE_NAMES.includes(name))
      throw new Error(`Unexpected public package: ${name}`);
    if (version !== undefined && declaredVersion !== undefined && declaredVersion !== version)
      throw new Error(`${name ?? "Package"} declares ${declaredVersion}, expected ${version}`);

    if (source === "packed") return packedPackageSpec(candidate, invocationDirectory);
    if (name === undefined || !PUBLIC_PACKAGE_NAMES.includes(name))
      throw new TypeError("Every registry package must provide a public package name");
    return `${name}@${version ?? declaredVersion ?? "latest"}`;
  });

  if (new Set(namedEntries).size !== namedEntries.length)
    throw new Error("packages contains duplicate public package names");
  if (source === "registry" && PUBLIC_PACKAGE_NAMES.some((name) => !namedEntries.includes(name)))
    throw new Error("packages must contain all five public package names");
  return specs;
}

function defaultCommandRunner(command, args, options) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", rejectCommand);
    child.once("close", (status, signal) => {
      resolveCommand({ stdout, stderr, status: status ?? (signal ? 1 : 0) });
    });
  });
}

async function runCommand(commandRunner, command, args, options) {
  const result = await commandRunner(command, args, options);
  if (!isRecord(result)) throw new TypeError("commandRunner must return a command result object");
  const status = [result.status, result.exitCode, result.code].find(
    (candidate) => typeof candidate === "number",
  );
  const stdout = result.stdout === undefined ? "" : String(result.stdout);
  const stderr = result.stderr === undefined ? "" : String(result.stderr);
  if ((status ?? 0) !== 0) {
    const detail = stderr.trim() || stdout.trim();
    throw new Error(
      `Command failed (${status}): ${command} ${args.join(" ")}${detail ? `\n${detail}` : ""}`,
    );
  }
  return { stdout, stderr };
}

function packageDirectory(projectDirectory, name) {
  return join(projectDirectory, "node_modules", ...name.split("/"));
}

async function verifyInstalledPackages(projectDirectory, version) {
  const nodeModulesDirectory = join(projectDirectory, "node_modules");
  const canonicalNodeModules = await realpath(nodeModulesDirectory);
  const projectManifest = JSON.parse(
    await readFile(join(projectDirectory, "package.json"), "utf8"),
  );
  const directDependencies = isRecord(projectManifest.dependencies)
    ? projectManifest.dependencies
    : {};

  return Promise.all(
    PUBLIC_PACKAGE_NAMES.map(async (name) => {
      assert.ok(
        Object.hasOwn(directDependencies, name),
        `${name} was not installed as a direct dependency`,
      );
      const directory = packageDirectory(projectDirectory, name);
      const stats = await lstat(directory);
      assert.ok(stats.isDirectory(), `${name} is not installed as a directory`);
      assert.equal(stats.isSymbolicLink(), false, `${name} must not be a symbolic link`);

      const canonicalPackage = await realpath(directory);
      const packageRelativePath = relative(canonicalNodeModules, canonicalPackage);
      assert.ok(
        packageRelativePath.length > 0 &&
          !packageRelativePath.startsWith("..") &&
          !isAbsolute(packageRelativePath),
        `${name} resolves outside the consumer node_modules directory`,
      );

      const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      assert.equal(manifest.name, name, `${name} installed with an unexpected package identity`);
      if (version !== undefined)
        assert.equal(manifest.version, version, `${name} installed with an unexpected version`);
      return { name, version: manifest.version };
    }),
  );
}

function apiSmokeSource() {
  return `import assert from "node:assert/strict";
import { compileDocuments } from "@tokenc/core";
import { css } from "@tokenc/backend-css";
import { tailwind } from "@tokenc/backend-tailwind";
import { typescript } from "@tokenc/backend-typescript";

const content = ${JSON.stringify(JSON.stringify(TOKEN_DOCUMENT))};
const expected = ${JSON.stringify(EXPECTED_OUTPUTS)};
const result = await compileDocuments(
  [{ file: "tokens.json", content }],
  {
    outputs: [
      css({ output: "dist/tokens.css" }),
      tailwind({ output: "dist/tailwind.css" }),
      typescript({ output: "dist/tokens.ts", mode: "flat", references: "symbol" }),
    ],
  },
);
assert.equal(result.success, true, JSON.stringify(result.diagnostics));
assert.deepEqual(result.outputs, expected);
`;
}

function cliConfigSource() {
  return `import { css } from "@tokenc/backend-css";
import { tailwind } from "@tokenc/backend-tailwind";
import { typescript } from "@tokenc/backend-typescript";
import { defineConfig } from "@tokenc/core";

export default defineConfig({
  source: ["tokens/tokens.json"],
  outputs: [
    css({ output: "dist/tokens.css" }),
    tailwind({ output: "dist/tailwind.css" }),
    typescript({ output: "dist/tokens.ts", mode: "flat", references: "symbol" }),
  ],
});
`;
}

async function verifyCliOutputs(projectDirectory) {
  await Promise.all(
    EXPECTED_OUTPUTS.map(async (expected) => {
      const content = await readFile(join(projectDirectory, expected.path), "utf8");
      assert.equal(
        content,
        expected.content,
        `${expected.path} did not match the expected artifact`,
      );
    }),
  );
}

function verifyAuditSignatures(stdout, installed) {
  let audit;
  try {
    audit = JSON.parse(stdout);
  } catch (error) {
    throw new Error("npm audit signatures did not return valid JSON", { cause: error });
  }
  if (!isRecord(audit) || !Array.isArray(audit.verified))
    throw new Error("npm audit signatures did not return a verified package list");

  for (const candidate of installed) {
    const verified = audit.verified.find(
      (entry) => entry?.name === candidate.name && entry?.version === candidate.version,
    );
    assert.ok(
      verified,
      `${candidate.name}@${candidate.version} is absent from npm audit signatures verified`,
    );
    assert.equal(
      verified.attestations?.provenance?.predicateType,
      "https://slsa.dev/provenance/v1",
      `${candidate.name}@${candidate.version} has no verified SLSA provenance attestation`,
    );
  }
}

/**
 * Exercise the five public packages exactly as an external npm consumer would.
 *
 * @param {{
 *   source: "packed" | "registry",
 *   packages: readonly unknown[],
 *   version?: string,
 *   registry?: string,
 *   commandRunner?: (command: string, args: readonly string[], options: { cwd: string, env: NodeJS.ProcessEnv }) => Promise<object>
 * }} options
 */
export async function runConsumerSmoke({
  source,
  packages,
  version,
  registry,
  commandRunner = defaultCommandRunner,
}) {
  if (typeof commandRunner !== "function") throw new TypeError("commandRunner must be a function");
  if (registry !== undefined && (typeof registry !== "string" || registry.length === 0))
    throw new TypeError("registry must be a non-empty string when provided");
  const installSpecs = normalizeInstallPlan(source, packages, version);
  const projectDirectory = await mkdtemp(join(tmpdir(), "tokenc-consumer-smoke-"));
  const environment = {
    ...process.env,
    npm_config_cache: join(projectDirectory, "npm-cache"),
    npm_config_update_notifier: "false",
    ...(registry ? { npm_config_registry: registry } : {}),
  };
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

  try {
    await writeFile(
      join(projectDirectory, "package.json"),
      `${JSON.stringify({ name: "tokenc-consumer-smoke", private: true, type: "module" }, null, 2)}\n`,
      "utf8",
    );
    await runCommand(
      commandRunner,
      npmCommand,
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...installSpecs],
      { cwd: projectDirectory, env: environment },
    );

    const installed = await verifyInstalledPackages(projectDirectory, version);
    const apiSmokePath = join(projectDirectory, "api-smoke.mjs");
    await writeFile(apiSmokePath, apiSmokeSource(), "utf8");
    await runCommand(commandRunner, process.execPath, [apiSmokePath], {
      cwd: projectDirectory,
      env: environment,
    });

    await writeFile(join(projectDirectory, "tokenc.config.mjs"), cliConfigSource(), "utf8");
    await mkdir(join(projectDirectory, "tokens"), { recursive: true });
    await writeFile(
      join(projectDirectory, "tokens", "tokens.json"),
      `${JSON.stringify(TOKEN_DOCUMENT, null, 2)}\n`,
      "utf8",
    );

    const cliBin = join(projectDirectory, "node_modules", "@tokenc", "cli", "dist", "bin.js");
    const help = await runCommand(commandRunner, process.execPath, [cliBin, "--help"], {
      cwd: projectDirectory,
      env: environment,
    });
    assert.match(help.stdout, /tokenc build/u, "Installed CLI help did not list tokenc build");
    await runCommand(commandRunner, process.execPath, [cliBin, "build"], {
      cwd: projectDirectory,
      env: environment,
    });
    await verifyCliOutputs(projectDirectory);

    if (source === "registry") {
      const audit = await runCommand(
        commandRunner,
        npmCommand,
        ["audit", "signatures", "--json", "--include-attestations"],
        { cwd: projectDirectory, env: environment },
      );
      verifyAuditSignatures(audit.stdout, installed);
    }

    return { source, packages: installed };
  } finally {
    await rm(projectDirectory, { recursive: true, force: true });
  }
}
