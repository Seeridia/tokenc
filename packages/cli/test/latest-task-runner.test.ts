import { createCompilerSession, parseTokenId } from "@tokenc/core";
import { describe, expect, it, vi } from "vite-plus/test";

import { LatestTaskRunner } from "../src/latest-task-runner.js";

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("LatestTaskRunner", () => {
  it("coalesces queued rapid updates and runs only the latest rebuild", async () => {
    const errors = vi.fn<(error: unknown) => void>();
    const runner = new LatestTaskRunner(errors);
    const blocker = deferred();
    const completed: string[] = [];

    runner.schedule(async () => blocker.promise);
    await Promise.resolve();
    runner.schedule(async () => {
      completed.push("stale");
    });
    runner.schedule(async () => {
      completed.push("latest");
    });
    blocker.resolve();
    await runner.idle();

    expect(completed).toEqual(["latest"]);
    expect(errors).not.toHaveBeenCalled();
  });

  it("aborts an active rebuild and suppresses its stale publication", async () => {
    const errors = vi.fn<(error: unknown) => void>();
    const runner = new LatestTaskRunner(errors);
    const started = deferred();
    const release = deferred();
    const published: string[] = [];

    runner.schedule(async (signal) => {
      started.resolve();
      await release.promise;
      signal.throwIfAborted();
      published.push("stale");
    });
    await started.promise;
    runner.schedule(async () => {
      published.push("latest");
    });
    release.resolve();
    await runner.idle();

    expect(published).toEqual(["latest"]);
    expect(errors).not.toHaveBeenCalled();
  });

  it("reports invalid work and remains available for recovery", async () => {
    const errors = vi.fn<(error: unknown) => void>();
    const runner = new LatestTaskRunner(errors);
    const completed: string[] = [];

    runner.schedule(async () => {
      throw new Error("invalid config");
    });
    await runner.idle();
    runner.schedule(async () => {
      completed.push("recovered");
    });
    await runner.idle();

    expect(errors).toHaveBeenCalledWith(expect.objectContaining({ message: "invalid config" }));
    expect(completed).toEqual(["recovered"]);
  });

  it("drives Session config reload and invalid-input recovery", async () => {
    const errors = vi.fn<(error: unknown) => void>();
    const runner = new LatestTaskRunner(errors);
    const session = createCompilerSession();
    const identity = "dev.json";
    const statuses: string[] = [];

    runner.schedule(async (signal) => {
      const snapshot = await session.apply(
        {
          documents: [
            {
              kind: "add",
              document: { identity, content: '{"value":{"$type":"number","$value":"{missing}"}}' },
            },
          ],
        },
        { signal },
      );
      statuses.push(snapshot.status);
    });
    await runner.idle();

    runner.schedule(async (signal) => {
      const snapshot = await session.apply(
        {
          documents: [
            {
              kind: "update",
              document: { identity, content: '{"value":{"$type":"number","$value":1}}' },
            },
          ],
          config: {
            contexts: { theme: { default: "dark", values: ["light", "dark"] } },
          },
        },
        { signal },
      );
      statuses.push(snapshot.status);
      expect(snapshot.query.context()).toEqual({ theme: "dark" });
      expect(snapshot.query.resolve(parseTokenId("value"))).toMatchObject({ value: 1 });
    });
    await runner.idle();
    await runner.close();
    await session.close();

    expect(statuses).toEqual(["invalid", "valid"]);
    expect(errors).not.toHaveBeenCalled();
  });
});
