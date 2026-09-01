export type LatestTask = (signal: AbortSignal) => Promise<void>;

/** Serializes rebuilds while aborting work superseded by a newer filesystem event. */
export class LatestTaskRunner {
  readonly #onError: (error: unknown) => void;
  #tail: Promise<unknown> = Promise.resolve();
  #active: AbortController | undefined;
  #closed = false;

  constructor(onError: (error: unknown) => void) {
    this.#onError = onError;
  }

  schedule(task: LatestTask): void {
    if (this.#closed) return;
    this.#active?.abort(new DOMException("Superseded by a newer rebuild", "AbortError"));
    const controller = new AbortController();
    this.#active = controller;
    this.#tail = this.#tail
      .catch(() => undefined)
      .then(() => (controller.signal.aborted ? Promise.resolve() : task(controller.signal)))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) this.#onError(error);
        return undefined;
      })
      .finally(() => {
        if (this.#active === controller) this.#active = undefined;
      });
  }

  async idle(): Promise<void> {
    await this.#tail;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#active?.abort(new DOMException("Rebuild runner closed", "AbortError"));
    await this.#tail;
  }
}
