#!/usr/bin/env node
import { runCli } from "./index.js";

const exitCode = await runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  stdout: (message) => process.stdout.write(message),
  stderr: (message) => process.stderr.write(message),
});
process.exitCode = exitCode;
