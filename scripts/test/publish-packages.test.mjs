import { describe, expect, it, vi } from "vite-plus/test";

import { runPublishPackages } from "../publish-packages.mjs";
import { publishRelease } from "../release-integrity.mjs";
import { COMMIT, publishedFixture, registryFixture, releaseFixture } from "./helpers.mjs";

function commandRunner() {
  return vi.fn((command, arguments_) => {
    if (command === "git" && arguments_[0] === "rev-parse") return `${COMMIT}\n`;
    return undefined;
  });
}

function dependencies(release, overrides = {}) {
  return {
    repositoryRoot: process.cwd(),
    environment: {},
    runCommand: commandRunner(),
    writeOutput: vi.fn(),
    loadRelease: vi.fn().mockResolvedValue(release),
    verifyRelease: vi.fn(),
    assertEnvironment: vi.fn(),
    listPendingChangesets: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe("publish-packages", () => {
  it("requires an explicit release manifest for a real publication", async () => {
    await expect(runPublishPackages(["--tag", "latest"])).rejects.toThrow(
      "Publishing requires --manifest",
    );
  });

  it("blocks a real publication while a changeset is pending", async () => {
    const release = releaseFixture();
    const injected = dependencies(release, {
      listPendingChangesets: vi.fn().mockResolvedValue(["pending-release.md"]),
    });

    await expect(
      runPublishPackages(["--manifest", "release-manifest.json"], injected),
    ).rejects.toThrow(".changeset/pending-release.md");
    expect(injected.assertEnvironment).not.toHaveBeenCalled();
  });

  it("refuses all npm publish side effects when an existing artifact conflicts", async () => {
    const release = releaseFixture();
    const existing = release.packages[0];
    const { client, records } = registryFixture(release, [existing.name]);
    records.set(
      existing.name,
      publishedFixture(existing, release, { distTags: { latest: "0.9.0" } }),
    );
    const injected = dependencies(release, {
      registryClientFactory: vi.fn(() => client),
      publish: publishRelease,
    });

    await expect(
      runPublishPackages(["--manifest", "release-manifest.json"], injected),
    ).rejects.toMatchObject({ code: "DIST_TAG_MISMATCH" });
    expect(injected.runCommand.mock.calls.filter(([command]) => command === "npm")).toEqual([]);
  });

  it("refuses all npm publish side effects when the candidate version would regress", async () => {
    const release = releaseFixture();
    const injected = dependencies(release, {
      registryClientFactory: vi.fn(() => ({
        metadata: vi.fn().mockResolvedValue(undefined),
        versions: vi.fn().mockResolvedValue(["2.0.0"]),
      })),
      publish: publishRelease,
    });

    await expect(
      runPublishPackages(["--manifest", "release-manifest.json"], injected),
    ).rejects.toMatchObject({ code: "VERSION_REGRESSION" });
    expect(injected.runCommand.mock.calls.filter(([command]) => command === "npm")).toEqual([]);
  });

  it("publishes only the missing archive after verifying the full registry state", async () => {
    const release = releaseFixture();
    const existing = release.packages[0];
    const missing = release.packages[1];
    const { client } = registryFixture(release, [existing.name]);
    const injected = dependencies(release, {
      registryClientFactory: vi.fn(() => client),
      publish: publishRelease,
    });

    const result = await runPublishPackages(
      ["--manifest", "release-manifest.json", "--registry", "https://registry.example"],
      injected,
    );

    expect(result.plan.missing).toEqual([missing]);
    const publishCalls = injected.runCommand.mock.calls.filter(([command]) => command === "npm");
    expect(publishCalls).toHaveLength(1);
    expect(publishCalls[0][1]).toEqual([
      "publish",
      missing.archivePath,
      "--access",
      "public",
      "--tag",
      "latest",
      "--registry",
      "https://registry.example",
      "--provenance",
    ]);
  });

  it("keeps dry-run local and executes npm publish with --dry-run for every archive", async () => {
    const release = releaseFixture({ tag: "next" });
    const injected = dependencies(release, {
      packRelease: vi.fn().mockResolvedValue({ manifestPath: "/tmp/release-manifest.json" }),
    });

    const result = await runPublishPackages(["--dry-run", "--tag", "next"], injected);

    expect(result.dryRun).toBe(true);
    expect(injected.assertEnvironment).not.toHaveBeenCalled();
    const publishCalls = injected.runCommand.mock.calls.filter(([command]) => command === "npm");
    expect(publishCalls).toHaveLength(release.packages.length);
    for (const [, arguments_] of publishCalls) expect(arguments_).toContain("--dry-run");
  });
});
