import { describe, expect, it } from "vite-plus/test";

import { ClientLifecycle, type LifecycleClient } from "../src/lifecycle.js";

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

describe("VS Code language-client lifecycle", () => {
  it("serializes restarts and stops the replaced client", async () => {
    const events: string[] = [];
    const firstStart = deferred();
    const firstStarted = deferred();
    const lifecycle = new ClientLifecycle<LifecycleClient>();
    const first = lifecycle.restart(() => ({
      start: async () => {
        events.push("first:start");
        firstStarted.resolve();
        await firstStart.promise;
      },
      stop: async () => {
        events.push("first:stop");
      },
    }));
    const second = lifecycle.restart(() => ({
      start: async () => {
        events.push("second:start");
      },
      stop: async () => {
        events.push("second:stop");
      },
    }));

    await firstStarted.promise;
    expect(events).toEqual(["first:start"]);
    firstStart.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:stop", "second:start"]);
    expect(lifecycle.state).toBe("running");
    await lifecycle.stop();
    expect(events.at(-1)).toBe("second:stop");
    expect(lifecycle.state).toBe("stopped");
  });

  it("cleans up a client whose start fails", async () => {
    const events: string[] = [];
    const lifecycle = new ClientLifecycle<LifecycleClient>();
    await expect(
      lifecycle.restart(() => ({
        start: async () => {
          throw new Error("start failed");
        },
        stop: async () => {
          events.push("stop");
        },
      })),
    ).rejects.toThrow("start failed");
    expect(events).toEqual(["stop"]);
    expect(lifecycle.client).toBeUndefined();
    expect(lifecycle.state).toBe("stopped");
  });
});
