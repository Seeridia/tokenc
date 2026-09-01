export interface LifecycleClient {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export type LifecycleState = "stopped" | "starting" | "running" | "stopping";

/** Serialize restarts so command/config/trust events cannot leave two server processes running. */
export class ClientLifecycle<Client extends LifecycleClient> {
  #client: Client | undefined;
  #state: LifecycleState = "stopped";
  #transition: Promise<void> = Promise.resolve();

  get client(): Client | undefined {
    return this.#client;
  }

  get state(): LifecycleState {
    return this.#state;
  }

  restart(create: () => Client): Promise<void> {
    const transition = this.#transition
      .catch(() => undefined)
      .then(async () => {
        await this.#stopCurrent();
        const client = create();
        this.#client = client;
        this.#state = "starting";
        try {
          await client.start();
          if (this.#client === client) this.#state = "running";
        } catch (error) {
          if (this.#client === client) {
            this.#client = undefined;
            this.#state = "stopped";
          }
          await client.stop().catch(() => undefined);
          throw error;
        }
        return undefined;
      });
    this.#transition = transition;
    return transition;
  }

  stop(): Promise<void> {
    const transition = this.#transition.catch(() => undefined).then(() => this.#stopCurrent());
    this.#transition = transition;
    return transition;
  }

  async #stopCurrent(): Promise<void> {
    const client = this.#client;
    if (!client) {
      this.#state = "stopped";
      return;
    }
    this.#state = "stopping";
    this.#client = undefined;
    try {
      await client.stop();
    } finally {
      this.#state = "stopped";
    }
  }
}
