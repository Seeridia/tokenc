export type LatestWork = (signal: AbortSignal, revision: number) => Promise<void>;

/** Serial latest-wins work queue. Superseded work is aborted and cannot publish its revision. */
export class LatestWorkScheduler {
  readonly #onError: (error: unknown) => void;
  #tail: Promise<void> = Promise.resolve();
  #active: AbortController | undefined;
  #requestedRevision = 0;
  #publishedRevision = 0;
  #closed = false;

  constructor(onError: (error: unknown) => void) {
    this.#onError = onError;
  }

  get requestedRevision(): number {
    return this.#requestedRevision;
  }

  get publishedRevision(): number {
    return this.#publishedRevision;
  }

  schedule(work: LatestWork): number {
    if (this.#closed) return this.#requestedRevision;
    const revision = (this.#requestedRevision += 1);
    this.#active?.abort(new DOMException("Superseded by newer workspace input", "AbortError"));
    const controller = new AbortController();
    this.#active = controller;
    this.#tail = this.#tail
      .catch(() => undefined)
      .then(async () => {
        if (controller.signal.aborted || revision !== this.#requestedRevision) return undefined;
        await work(controller.signal, revision);
        if (!controller.signal.aborted && revision === this.#requestedRevision)
          this.#publishedRevision = revision;
        return undefined;
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) this.#onError(error);
      })
      .finally(() => {
        if (this.#active === controller) this.#active = undefined;
      });
    return revision;
  }

  async idle(): Promise<void> {
    await this.#tail;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#active?.abort(new DOMException("Workspace scheduler closed", "AbortError"));
    await this.#tail;
  }
}
