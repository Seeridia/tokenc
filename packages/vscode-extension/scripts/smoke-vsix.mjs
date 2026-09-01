import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
  runTests,
} from "@vscode/test-electron";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const vsix = resolve(
  process.env.TOKENC_VSIX_OUTPUT ?? join(repositoryRoot, "artifacts/tokenc-vscode.vsix"),
);
const version = process.env.TOKENC_VSCODE_VERSION ?? "1.134.0";
const temporaryRoot = await mkdtemp(join(tmpdir(), "tokenc-vsix-smoke-"));
const extensionsDirectory = join(temporaryRoot, "extensions");
const userDataDirectory = join(temporaryRoot, "user-data");

try {
  const executable = process.env.TOKENC_VSCODE_EXECUTABLE
    ? resolve(process.env.TOKENC_VSCODE_EXECUTABLE)
    : await downloadAndUnzipVSCode({ version, cachePath: join(repositoryRoot, ".vscode-test") });
  const [cli, ...cliArguments] = resolveCliArgsFromVSCodeExecutablePath(executable, {
    reuseMachineInstall: true,
  });
  const installed = spawnSync(
    cli,
    [
      ...cliArguments,
      "--install-extension",
      vsix,
      "--extensions-dir",
      extensionsDirectory,
      "--user-data-dir",
      userDataDirectory,
      "--force",
    ],
    { encoding: "utf8", stdio: "inherit" },
  );
  if (installed.error) throw installed.error;
  if (installed.status !== 0)
    throw new Error(`VSIX installation exited with status ${String(installed.status)}`);

  await runTests({
    vscodeExecutablePath: executable,
    extensionDevelopmentPath: join(packageRoot, "test/harness"),
    extensionTestsPath: join(packageRoot, "dist/smoke.cjs"),
    launchArgs: [
      join(packageRoot, "test/fixture"),
      "--extensions-dir",
      extensionsDirectory,
      "--user-data-dir",
      userDataDirectory,
    ],
    reuseMachineInstall: true,
  });
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
