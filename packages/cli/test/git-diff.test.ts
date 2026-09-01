import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { assertSchemaConformance } from "../../core/test/support/schema-conformance.js";
import reportSchema from "../schema/report-v1.schema.json" with { type: "json" };
import { runCli } from "../src/index.js";

const execute = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(cwd: string, ...args: readonly string[]): Promise<string> {
  const result = await execute("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return result.stdout;
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
}

function token(name: string, value: number): string {
  return JSON.stringify({ [name]: { $type: "number", $value: value } }, undefined, 2);
}

async function repository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tokenc-git-diff-"));
  temporaryDirectories.push(directory);
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "tokenc test");
  await git(directory, "config", "user.email", "tokenc@example.invalid");
  await write(
    join(directory, "tokenc.config.ts"),
    'export default { source: ["tokens/**/*.json"] };\n',
  );
  await write(join(directory, "tokens", "value.json"), token("value", 1));
  await write(join(directory, "tokens", "removed.json"), token("removed", 9));
  await git(directory, "add", ".");
  await git(directory, "commit", "-m", "base");
  return directory;
}

function invoke(cwd: string, args: readonly string[]) {
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

async function repositoryState(cwd: string) {
  const paths = (await git(cwd, "ls-files", "-z", "--cached", "--others", "--exclude-standard"))
    .split("\0")
    .filter(Boolean)
    .toSorted();
  const contents = await Promise.all(
    paths.map(async (path) => {
      try {
        return [path, await readFile(join(cwd, path), "utf8")] as const;
      } catch {
        return [path, null] as const;
      }
    }),
  );
  return {
    branch: (await git(cwd, "symbolic-ref", "HEAD")).trim(),
    head: (await git(cwd, "rev-parse", "HEAD")).trim(),
    status: await git(cwd, "status", "--porcelain=v2", "-z"),
    index: await git(cwd, "diff", "--cached", "--binary"),
    worktree: await git(cwd, "diff", "--binary"),
    contents,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("tokenc diff Git provider", () => {
  it("preserves branch, index, worktree, staged, unstaged, added, and deleted state", async () => {
    const cwd = await repository();
    await write(join(cwd, "tokens", "value.json"), token("value", 2));
    await write(join(cwd, "tokens", "staged.json"), token("staged", 3));
    await git(cwd, "add", "tokens/staged.json");
    await write(join(cwd, "tokens", "untracked.json"), token("untracked", 4));
    await unlink(join(cwd, "tokens", "removed.json"));
    const before = await repositoryState(cwd);

    const result = await invoke(cwd, ["diff", "--base", "HEAD", "--format=json"]);

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(() => assertSchemaConformance(JSON.parse(result.stdout), reportSchema)).not.toThrow();
    expect(
      JSON.parse(result.stdout).data.comparison.changes.map(
        (change: { token: string; kind: string }) => [change.token, change.kind],
      ),
    ).toEqual([
      ["removed", "removed"],
      ["staged", "added"],
      ["untracked", "added"],
      ["value", "direct-value"],
    ]);
    const text = await invoke(cwd, ["diff", "--base", "HEAD"]);
    expect(text).toMatchObject({ code: 0, stderr: "" });
    expect(text.stdout).toContain(
      "tokenc diff report v1\nVerdict: pass\nBase: HEAD\nHead: worktree",
    );
    expect(text.stdout).toContain("value: direct-value");
    expect(await repositoryState(cwd)).toEqual(before);
  });

  it("requires explicit trust when the executable config changed", async () => {
    const cwd = await repository();
    await write(
      join(cwd, "tokenc.config.ts"),
      '// current trusted config\nexport default { source: ["tokens/**/*.json"] };\n',
    );

    const implicit = await invoke(cwd, ["diff", "--base", "HEAD", "--format=json"]);
    expect(implicit.code).toBe(2);
    expect(JSON.parse(implicit.stdout)).toMatchObject({
      verdict: "incomplete",
      data: {
        comparison: {
          status: "incomplete",
          coverage: { compared: [], omitted: [{ reason: "configuration-unavailable" }] },
        },
      },
      diagnostics: [{ diagnostic: { code: "dev.tokenc.cli/GIT_CONFIG_CHANGED" } }],
    });

    const explicit = await invoke(cwd, [
      "diff",
      "--base",
      "HEAD",
      "--config",
      "tokenc.config.ts",
      "--format=json",
    ]);
    expect(explicit.code).toBe(0);
    expect(JSON.parse(explicit.stdout)).toMatchObject({
      verdict: "pass",
      data: { comparison: { status: "complete", changes: [] } },
    });
  });

  it("fails deterministically for missing and shallow revisions", async () => {
    const cwd = await repository();
    const missing = await invoke(cwd, ["diff", "--base", "does-not-exist"]);
    expect(missing).toMatchObject({
      code: 2,
      stdout: "",
      stderr: "GIT_REVISION_NOT_FOUND: Git revision not found: does-not-exist\n",
    });

    await write(join(cwd, "tokens", "value.json"), token("value", 2));
    await git(cwd, "add", ".");
    await git(cwd, "commit", "-m", "head");
    const shallow = await mkdtemp(join(tmpdir(), "tokenc-git-shallow-"));
    temporaryDirectories.push(shallow);
    await execute("git", ["clone", "--depth=1", `file://${cwd}`, shallow]);
    const unavailable = await invoke(shallow, ["diff", "--base", "HEAD~1"]);
    expect(unavailable).toMatchObject({
      code: 2,
      stdout: "",
      stderr: "GIT_REVISION_NOT_FOUND: Git revision not found: HEAD~1\n",
    });
  });

  it("handles renamed sources and invalid Snapshots deterministically", async () => {
    const cwd = await repository();
    await rename(join(cwd, "tokens", "value.json"), join(cwd, "tokens", "renamed.json"));
    await git(cwd, "add", "-A");
    const renamed = await invoke(cwd, ["diff", "--base", "HEAD", "--format=json"]);
    expect(renamed.code).toBe(0);
    expect(JSON.parse(renamed.stdout)).toMatchObject({
      verdict: "pass",
      data: { comparison: { status: "complete", changes: [] } },
    });

    await write(join(cwd, "tokens", "renamed.json"), "{");
    const invalid = await invoke(cwd, ["diff", "--base", "HEAD", "--format=json"]);
    expect(invalid.code).toBe(2);
    expect(JSON.parse(invalid.stdout)).toMatchObject({
      verdict: "incomplete",
      data: {
        comparison: {
          status: "incomplete",
          head: { status: "invalid" },
          coverage: { compared: [], omitted: [{ reason: "invalid-head" }] },
        },
      },
      diagnostics: [{ side: "head", diagnostic: { code: "TOKEN_INVALID_JSON" } }],
    });
  });

  it("fails deterministically when a selected Resolver source was deleted", async () => {
    const cwd = await repository();
    await write(
      join(cwd, "tokenc.config.ts"),
      'export default { source: ["tokens/**/*.json"], resolver: { source: "tokens.resolver.json", input: { theme: "light" } } };\n',
    );
    await write(
      join(cwd, "tokens.resolver.json"),
      JSON.stringify({
        version: "2025.10",
        sets: { base: { sources: [{ $ref: "tokens/value.json" }] } },
        modifiers: {},
        resolutionOrder: [{ $ref: "#/sets/base" }],
      }),
    );
    await git(cwd, "add", ".");
    await git(cwd, "commit", "-m", "resolver");
    await unlink(join(cwd, "tokens.resolver.json"));

    const result = await invoke(cwd, ["diff", "--base", "HEAD", "--config", "tokenc.config.ts"]);
    expect(result).toMatchObject({
      code: 2,
      stdout: "",
      stderr: "GIT_DOCUMENT_NOT_FOUND: Document not found in worktree: tokens.resolver.json\n",
    });
  });

  it("emits byte-identical JSON from identical trees in different checkout paths", async () => {
    const source = await repository();
    await write(join(source, "tokens", "value.json"), token("value", 2));
    await git(source, "add", ".");
    await git(source, "commit", "-m", "head");
    const first = await mkdtemp(join(tmpdir(), "tokenc-git-clone-a-"));
    const second = await mkdtemp(join(tmpdir(), "tokenc-git-clone-b-"));
    temporaryDirectories.push(first, second);
    await Promise.all([
      execute("git", ["clone", `file://${source}`, first]),
      execute("git", ["clone", `file://${source}`, second]),
    ]);

    const [left, right] = await Promise.all([
      invoke(first, ["diff", "--base", "HEAD~1", "--head", "HEAD", "--format=json"]),
      invoke(second, ["diff", "--base", "HEAD~1", "--head", "HEAD", "--format=json"]),
    ]);
    expect(left.code).toBe(0);
    expect(right.code).toBe(0);
    expect(left.stdout).toBe(right.stdout);
  });

  it("evaluates a policy with stable text/JSON findings and deterministic exit codes", async () => {
    const cwd = await repository();
    await unlink(join(cwd, "tokens", "removed.json"));
    await write(join(cwd, "tokenc.policy.json"), JSON.stringify({ schemaVersion: "1" }));

    const failing = await invoke(cwd, [
      "diff",
      "--base",
      "HEAD",
      "--policy",
      "tokenc.policy.json",
      "--format=json",
    ]);
    expect(failing).toMatchObject({ code: 1, stderr: "" });
    const evaluation = JSON.parse(failing.stdout);
    expect(evaluation).toMatchObject({
      schemaVersion: "1",
      verdict: "fail",
      diagnostics: [
        {
          origin: "policy",
          ruleId: "token-removal",
          allowed: false,
          diagnostic: { code: "POLICY_TOKEN_REMOVAL", severity: "error" },
        },
      ],
    });
    const findingChangeId = String(evaluation.diagnostics[0].changeId);
    const findingId = String(evaluation.diagnostics[0].findingId);

    const text = await invoke(cwd, ["diff", "--base", "HEAD", "--policy", "tokenc.policy.json"]);
    expect(text.code).toBe(1);
    expect(text.stdout).toContain(findingChangeId);
    expect(text.stdout).toContain(`[error] POLICY_TOKEN_REMOVAL ${findingId}`);

    await write(
      join(cwd, "tokenc.policy.json"),
      JSON.stringify({
        schemaVersion: "1",
        allow: [{ changeId: findingChangeId, reason: "intentional removal" }],
      }),
    );
    const allowed = await invoke(cwd, [
      "diff",
      "--base",
      "HEAD",
      "--policy",
      "tokenc.policy.json",
      "--format=json",
    ]);
    expect(allowed.code).toBe(0);
    expect(JSON.parse(allowed.stdout)).toMatchObject({
      verdict: "pass",
      diagnostics: [{ findingId, allowed: true }],
    });
    const sarifResult = await invoke(cwd, [
      "diff",
      "--base",
      "HEAD",
      "--policy",
      "tokenc.policy.json",
      "--format=sarif",
    ]);
    expect(sarifResult.code).toBe(0);
    expect(JSON.parse(sarifResult.stdout)).toMatchObject({
      version: "2.1.0",
      runs: [
        {
          results: [
            {
              ruleId: "POLICY_TOKEN_REMOVAL",
              partialFingerprints: { "tokenc/v1": findingId },
              suppressions: [{ kind: "external", justification: "intentional removal" }],
            },
          ],
        },
      ],
    });

    await write(
      join(cwd, "tokenc.policy.json"),
      JSON.stringify({
        schemaVersion: "1",
        rules: { "token-removal": { severity: "warning" } },
      }),
    );
    const warning = await invoke(cwd, [
      "diff",
      "--base",
      "HEAD",
      "--policy",
      "tokenc.policy.json",
      "--format=json",
    ]);
    expect(warning.code).toBe(0);
    expect(JSON.parse(warning.stdout)).toMatchObject({
      verdict: "pass",
      diagnostics: [{ findingId, diagnostic: { severity: "warning" } }],
    });
  });

  it("fails closed for invalid, stale, and unreadable policies", async () => {
    const cwd = await repository();
    await write(
      join(cwd, "tokenc.policy.json"),
      JSON.stringify({
        schemaVersion: "1",
        rules: { unknown: { severity: "error" } },
        allow: [{ changeId: "stale", reason: "obsolete" }],
      }),
    );
    const invalid = await invoke(cwd, [
      "diff",
      "--base",
      "HEAD",
      "--policy",
      "tokenc.policy.json",
      "--format=json",
    ]);
    expect(invalid.code).toBe(2);
    expect(JSON.parse(invalid.stdout)).toMatchObject({ verdict: "incomplete" });
    expect(
      JSON.parse(invalid.stdout).diagnostics.map(
        (entry: { diagnostic: { code: string } }) => entry.diagnostic.code,
      ),
    ).toEqual(["POLICY_UNKNOWN_RULE", "POLICY_STALE_ALLOW"]);

    await write(join(cwd, "tokenc.policy.json"), "{");
    const malformed = await invoke(cwd, [
      "diff",
      "--base",
      "HEAD",
      "--policy",
      "tokenc.policy.json",
    ]);
    expect(malformed.code).toBe(2);
    expect(malformed.stdout).toBe("");
    expect(malformed.stderr).toContain("Cannot load breaking-change policy tokenc.policy.json");
  });
});
