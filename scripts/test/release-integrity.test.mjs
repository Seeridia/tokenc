import { describe, expect, it, vi } from "vite-plus/test";

import {
  compareSemanticVersions,
  createRegistryClient,
  inspectPackageArchive,
  planPublication,
  publishRelease,
  verifyLocalReleaseTags,
  verifyPublishedRelease,
  verifyRemoteReleaseTags,
} from "../release-integrity.mjs";
import {
  COMMIT,
  packageArchive,
  publishedFixture,
  registryFixture,
  releaseFixture,
} from "./helpers.mjs";

describe("semantic version ordering", () => {
  it.each([
    ["1.2.4", "1.2.3", 1],
    ["2.0.0-beta.2", "2.0.0-beta.1", 1],
    ["2.0.0-beta.1", "2.0.0", -1],
    ["1.2.3+build.2", "1.2.3+build.1", 0],
  ])("compares %s with %s", (left, right, expected) => {
    expect(compareSemanticVersions(left, right)).toBe(expected);
  });
});

describe("registry release integrity", () => {
  it("normalizes package.json key order when comparing archive contents", () => {
    const first = packageArchive({
      name: "@tokenc/core",
      version: "1.2.3",
      dependencies: { alpha: "1", beta: "2" },
    });
    const second = packageArchive({
      dependencies: { beta: "2", alpha: "1" },
      version: "1.2.3",
      name: "@tokenc/core",
    });

    expect(inspectPackageArchive(first).archiveSha512).not.toBe(
      inspectPackageArchive(second).archiveSha512,
    );
    expect(inspectPackageArchive(first).contentDigest).toBe(
      inspectPackageArchive(second).contentDigest,
    );
  });

  it("classifies an unpublished release without fetching artifacts", async () => {
    const release = releaseFixture();
    const distTags = vi.fn();
    const versions = vi.fn().mockResolvedValue([]);
    const plan = await planPublication({
      release,
      registryClient: {
        metadata: vi.fn().mockResolvedValue(undefined),
        versions,
        distTags,
      },
    });

    expect(plan.missing).toEqual(release.packages);
    expect(plan.verified).toEqual([]);
    expect(versions).toHaveBeenCalledTimes(release.packages.length);
    expect(distTags).not.toHaveBeenCalled();
  });

  it("rejects publishing an absent version below one already in the registry", async () => {
    const release = releaseFixture({ packageCount: 1 });

    await expect(
      planPublication({
        release,
        registryClient: {
          metadata: vi.fn().mockResolvedValue(undefined),
          versions: vi.fn().mockResolvedValue(["1.3.0"]),
        },
      }),
    ).rejects.toMatchObject({ code: "VERSION_REGRESSION" });
  });

  it("accepts a fully matching published release", async () => {
    const release = releaseFixture();
    const { client } = registryFixture(release);

    const plan = await planPublication({ release, registryClient: client });

    expect(plan.missing).toEqual([]);
    expect(plan.verified.map(({ name }) => name)).toEqual(release.packages.map(({ name }) => name));
  });

  it("rejects registry contents that differ from the packed candidate", async () => {
    const release = releaseFixture({ packageCount: 1 });
    const candidate = release.packages[0];
    const { client, records } = registryFixture(release);
    records.set(
      candidate.name,
      publishedFixture(candidate, release, {
        archive: packageArchive(candidate.manifest, "different artifact"),
      }),
    );

    await expect(planPublication({ release, registryClient: client })).rejects.toMatchObject({
      code: "REGISTRY_ARTIFACT_MISMATCH",
    });
  });

  it("fails closed when the requested dist-tag selects another version", async () => {
    const release = releaseFixture({ packageCount: 1 });
    const candidate = release.packages[0];
    const { client, records } = registryFixture(release);
    records.set(
      candidate.name,
      publishedFixture(candidate, release, { distTags: { latest: "0.9.0" } }),
    );

    await expect(planPublication({ release, registryClient: client })).rejects.toMatchObject({
      code: "DIST_TAG_MISMATCH",
    });
  });

  it("publishes only missing packages during a partial retry", async () => {
    const release = releaseFixture();
    const existing = release.packages[0];
    const missing = release.packages[1];
    const { client } = registryFixture(release, [existing.name]);
    const publish = vi.fn();

    const plan = await publishRelease({ release, registryClient: client, publish });

    expect(plan.verified).toEqual([existing]);
    expect(plan.missing).toEqual([missing]);
    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith(missing, "latest");
  });

  it("does not publish any package when one existing package conflicts", async () => {
    const release = releaseFixture();
    const conflicting = release.packages[0];
    const { client, records } = registryFixture(release, [conflicting.name]);
    records.set(
      conflicting.name,
      publishedFixture(conflicting, release, { distTags: { latest: "0.9.0" } }),
    );
    const publish = vi.fn();

    await expect(
      publishRelease({ release, registryClient: client, publish }),
    ).rejects.toMatchObject({ code: "DIST_TAG_MISMATCH" });
    expect(publish).not.toHaveBeenCalled();
  });

  it("polls through delayed registry visibility", async () => {
    const release = releaseFixture({ packageCount: 1 });
    const { client } = registryFixture(release);
    const metadata = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockImplementation((...arguments_) => client.metadata(...arguments_));
    const sleep = vi.fn();

    const plan = await verifyPublishedRelease({
      release,
      registryClient: { ...client, metadata },
      attempts: 2,
      delayMs: 25,
      sleep,
    });

    expect(plan.verified).toEqual(release.packages);
    expect(metadata).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(25);
  });

  it("polls when package metadata appears before its provenance URL", async () => {
    const release = releaseFixture({ packageCount: 1 });
    const { client, records } = registryFixture(release);
    const published = records.get(release.packages[0].name);
    const metadataWithoutAttestations = structuredClone(published.metadata);
    delete metadataWithoutAttestations.dist.attestations;
    const metadata = vi
      .fn()
      .mockResolvedValueOnce(metadataWithoutAttestations)
      .mockImplementation((...arguments_) => client.metadata(...arguments_));
    const sleep = vi.fn();

    await expect(
      verifyPublishedRelease({
        release,
        registryClient: { ...client, metadata },
        attempts: 2,
        delayMs: 25,
        sleep,
      }),
    ).resolves.toBeDefined();
    expect(metadata).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(25);
  });

  it("does not treat a registry network failure as an unpublished version", async () => {
    const release = releaseFixture({ packageCount: 1 });
    const client = createRegistryClient({
      registry: "https://registry.example",
      fetchImplementation: vi.fn().mockRejectedValue(new Error("connection reset")),
    });

    await expect(planPublication({ release, registryClient: client })).rejects.toMatchObject({
      code: "REGISTRY_REQUEST_FAILED",
    });
  });

  it("maps a registry response body failure to a retryable request error", async () => {
    const release = releaseFixture({ packageCount: 1 });
    const client = createRegistryClient({
      registry: "https://registry.example",
      fetchImplementation: vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: vi.fn().mockRejectedValue(new Error("response interrupted")),
      }),
    });

    await expect(planPublication({ release, registryClient: client })).rejects.toMatchObject({
      code: "REGISTRY_REQUEST_FAILED",
    });
  });

  it("rejects provenance that resolves to another commit", async () => {
    const release = releaseFixture({ packageCount: 1 });
    const candidate = release.packages[0];
    const { client, records } = registryFixture(release);
    records.set(
      candidate.name,
      publishedFixture(candidate, release, {
        provenanceCommit: "fedcba9876543210fedcba9876543210fedcba98",
      }),
    );

    await expect(planPublication({ release, registryClient: client })).rejects.toMatchObject({
      code: "PROVENANCE_INVALID",
    });
  });

  it("rejects published internal dependencies that do not match the candidate", async () => {
    const release = releaseFixture();
    const candidate = release.packages[1];
    const { client, records } = registryFixture(release);
    records.set(
      candidate.name,
      publishedFixture(candidate, release, {
        metadata: { dependencies: { "@tokenc/core": "^1.2.3" } },
      }),
    );

    await expect(planPublication({ release, registryClient: client })).rejects.toMatchObject({
      code: "INTERNAL_DEPENDENCY_MISMATCH",
    });
  });

  it("accepts equivalent internal dependencies in a different key order", async () => {
    const release = releaseFixture({ packageCount: 3 });
    const candidate = release.packages[2];
    const { client, records } = registryFixture(release);
    records.set(
      candidate.name,
      publishedFixture(candidate, release, {
        metadata: {
          dependencies: {
            "@tokenc/backend-css": candidate.version,
            "@tokenc/core": candidate.version,
          },
        },
      }),
    );

    await expect(planPublication({ release, registryClient: client })).resolves.toBeDefined();
  });
});

describe("release tags", () => {
  const release = releaseFixture({ packageCount: 1 });
  const tag = release.packages[0].expectedTag;
  const ref = `refs/tags/${tag}`;

  it("accepts a local annotated tag on the release commit", () => {
    const runGit = vi.fn((arguments_) => (arguments_[0] === "cat-file" ? "tag" : COMMIT));
    expect(() => verifyLocalReleaseTags(release, runGit)).not.toThrow();
  });

  it("rejects a local lightweight tag", () => {
    const runGit = vi.fn(() => "commit");
    expect(() => verifyLocalReleaseTags(release, runGit)).toThrowError(
      expect.objectContaining({ code: "RELEASE_TAG_INVALID" }),
    );
  });

  it("rejects a missing local tag", () => {
    const runGit = vi.fn(() => {
      throw new Error("fatal: Not a valid object name");
    });
    expect(() => verifyLocalReleaseTags(release, runGit)).toThrow("Not a valid object name");
  });

  it("rejects a local tag on another commit", () => {
    const runGit = vi.fn((arguments_) =>
      arguments_[0] === "cat-file" ? "tag" : "fedcba9876543210fedcba9876543210fedcba98",
    );
    expect(() => verifyLocalReleaseTags(release, runGit)).toThrowError(
      expect.objectContaining({ code: "RELEASE_TAG_INVALID" }),
    );
  });

  it("accepts a remote annotated tag on the release commit", () => {
    const output = `tag-object\t${ref}\n${COMMIT}\t${ref}^{}\n`;
    expect(() => verifyRemoteReleaseTags(release, "origin", () => output)).not.toThrow();
  });

  it("rejects a remote lightweight tag", () => {
    const output = `${COMMIT}\t${ref}\n`;
    expect(() => verifyRemoteReleaseTags(release, "origin", () => output)).toThrowError(
      expect.objectContaining({ code: "RELEASE_TAG_INVALID" }),
    );
  });

  it("rejects a missing remote tag", () => {
    expect(() => verifyRemoteReleaseTags(release, "origin", () => "")).toThrowError(
      expect.objectContaining({ code: "RELEASE_TAG_MISSING" }),
    );
  });

  it("rejects a remote tag on another commit", () => {
    const otherCommit = "fedcba9876543210fedcba9876543210fedcba98";
    const output = `tag-object\t${ref}\n${otherCommit}\t${ref}^{}\n`;
    expect(() => verifyRemoteReleaseTags(release, "origin", () => output)).toThrowError(
      expect.objectContaining({ code: "RELEASE_TAG_INVALID" }),
    );
  });
});
