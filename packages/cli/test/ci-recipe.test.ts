import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { runCli } from "../src/index.js";

const execute = promisify(execFile);
const fixtures = fileURLToPath(new URL("fixtures/ci-repository", import.meta.url));
const repositoryRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const temporaryDirectories: string[] = [];

interface Invocation {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function git(cwd: string, ...args: readonly string[]): Promise<void> {
  await execute("git", ["-C", cwd, ...args]);
}

async function repository(scenario: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tokenc-ci-recipe-"));
  temporaryDirectories.push(directory);
  await cp(join(fixtures, "base"), directory, { recursive: true });
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "tokenc CI fixture");
  await git(directory, "config", "user.email", "tokenc@example.invalid");
  await git(directory, "add", ".");
  await git(directory, "commit", "-m", "baseline");
  await cp(join(fixtures, "scenarios", scenario), directory, {
    recursive: true,
    force: true,
  });
  return directory;
}

function invoke(cwd: string, args: readonly string[]): Promise<Invocation> {
  let stdout = "";
  let stderr = "";
  return runCli(args, {
    cwd,
    stdout: (message) => {
      stdout += message;
    },
    stderr: (message) => {
      stderr += message;
    },
  }).then((code) => ({ code, stdout, stderr }));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function jsonFingerprints(output: string): readonly string[] {
  const report: unknown = JSON.parse(output);
  if (!isRecord(report)) return [];
  const diagnostics = report.diagnostics;
  if (!Array.isArray(diagnostics)) return [];
  return diagnostics
    .flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const diagnostic = entry.diagnostic;
      if (!isRecord(diagnostic)) return [];
      const fingerprint = diagnostic.fingerprint;
      return typeof fingerprint === "string" ? [fingerprint] : [];
    })
    .toSorted();
}

function sarifFingerprints(output: string): readonly string[] {
  const report: unknown = JSON.parse(output);
  if (!isRecord(report)) return [];
  const runs = report.runs;
  if (!Array.isArray(runs)) return [];
  return runs
    .flatMap((run) => {
      if (!isRecord(run)) return [];
      const results = run.results;
      return Array.isArray(results) ? results : [];
    })
    .flatMap((result) => {
      if (!isRecord(result)) return [];
      const fingerprints = result.partialFingerprints;
      if (!isRecord(fingerprints)) return [];
      const fingerprint = fingerprints["tokenc/v1"];
      return typeof fingerprint === "string" ? [fingerprint] : [];
    })
    .toSorted();
}

async function formats(
  cwd: string,
  args: readonly string[],
): Promise<Readonly<Record<"text" | "json" | "sarif", Invocation>>> {
  const [text, json, sarif] = await Promise.all([
    invoke(cwd, [...args, "--format=text"]),
    invoke(cwd, [...args, "--format=json"]),
    invoke(cwd, [...args, "--format=sarif"]),
  ]);
  return { text, json, sarif };
}

function expectFormatParity(result: Awaited<ReturnType<typeof formats>>, code: number): void {
  expect([result.text.code, result.json.code, result.sarif.code]).toEqual([code, code, code]);
  expect(result.text.stderr).toBe("");
  expect(result.json.stderr).toBe("");
  expect(result.sarif.stderr).toBe("");
  const fingerprints = jsonFingerprints(result.json.stdout);
  expect(sarifFingerprints(result.sarif.stdout)).toEqual(fingerprints);
  for (const fingerprint of fingerprints) expect(result.text.stdout).toContain(fingerprint);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("M2-07 CI recipe", () => {
  it.each([
    { scenario: "pass", command: "diff", code: 0 },
    { scenario: "breaking", command: "diff", code: 1 },
    { scenario: "compiler-failure", command: "check", code: 1 },
    { scenario: "incomplete", command: "diff", code: 2 },
  ])("covers $scenario with stable report fingerprints", async ({ scenario, command, code }) => {
    const cwd = await repository(scenario);
    const args =
      command === "diff" ? ["diff", "--base", "HEAD", "--policy", "tokenc.policy.json"] : ["check"];
    const result = await formats(cwd, args);
    expect(result.text.code).toBe(code);
    expectFormatParity(result, code);
  });

  it("pins every action and keeps fork pull requests read-only", async () => {
    const workflow = await readFile(join(repositoryRoot, ".github/workflows/tokenc.yml"), "utf8");
    const uses = [...workflow.matchAll(/^\s*uses: [^@\n]+@([^\s#]+)/gmu)].map((match) => match[1]);

    expect(uses.length).toBeGreaterThan(0);
    expect(uses.every((reference) => /^[a-f\d]{40}$/u.test(reference ?? ""))).toBe(true);
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("security-events: write");
    expect(workflow).toContain("fetch-depth: 0");
    expect(workflow).toContain("retention-days: 14");
    expect(workflow).toContain("vp exec tsx packages/cli/src/bin.ts diff");
    expect(workflow).not.toContain("run tokenc");
    expect(workflow).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
    expect(workflow).not.toContain("pull_request_target");
    expect(workflow).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN/u);
  });
});
