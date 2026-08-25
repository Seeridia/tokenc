import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vite-plus/test";

import { parseBenchmarkArguments } from "../compiler.bench.js";
import { assertFiniteNumbers } from "../statistics.js";

const executeFile = promisify(execFile);
const entry = fileURLToPath(new URL("../compiler.bench.ts", import.meta.url));
const schemaPath = fileURLToPath(new URL("../benchmark-report.v1.schema.json", import.meta.url));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("benchmark runner", () => {
  it("uses meaningful quick and baseline sampling defaults", () => {
    expect(parseBenchmarkArguments([])).toMatchObject({
      profile: "quick",
      warmupRuns: 1,
      sampleRuns: 3,
      memorySampleRuns: 1,
    });
    expect(parseBenchmarkArguments(["--profile", "baseline"])).toMatchObject({
      profile: "baseline",
      warmupRuns: 5,
      sampleRuns: 20,
      memorySampleRuns: 3,
    });
  });

  it("emits a finite machine-readable v1 report for one light case", async () => {
    const { stdout } = await executeFile(
      process.execPath,
      [
        "--import",
        "tsx",
        entry,
        "--profile",
        "quick",
        "--case",
        "repository/small/cold/basic",
        "--warmups",
        "0",
        "--samples",
        "1",
        "--memory-samples",
        "0",
      ],
      { cwd: resolve(fileURLToPath(new URL("../..", import.meta.url))), encoding: "utf8" },
    );
    const parsed: unknown = JSON.parse(stdout);
    expect(isRecord(parsed)).toBe(true);
    if (!isRecord(parsed)) throw new TypeError("Expected report object");
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.environment).toMatchObject({
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    });
    expect(parsed.methodology).toMatchObject({
      profile: "quick",
      warmupRuns: 0,
      sampleRuns: 1,
      memorySampleRuns: 0,
      percentileMethod: "linear-r7",
    });
    expect(parsed.cases).toEqual([
      expect.objectContaining({
        id: "repository/small/cold/basic",
        validation: expect.objectContaining({
          compilationSuccess: true,
          matchesExpected: true,
        }),
        timeSamples: [expect.objectContaining({ index: 1 })],
        memorySamples: [],
        summary: expect.objectContaining({
          wallMs: expect.objectContaining({ count: 1 }),
        }),
      }),
    ]);
    expect(() => assertFiniteNumbers(parsed)).not.toThrow();
  });

  it("ships a strict v1 JSON Schema", async () => {
    const schema: unknown = JSON.parse(await readFile(schemaPath, "utf8"));
    expect(schema).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      properties: expect.objectContaining({ schemaVersion: { const: 1 } }),
    });
  });
});
