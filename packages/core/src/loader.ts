import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import fg from "fast-glob";

import type { SourceLocation } from "./model.js";

export interface TokenSourceInput {
  readonly file: string;
  readonly content: string;
  /** Origin when content is an inline slice of another source document. */
  readonly origin?: SourceLocation;
}

export interface DocumentRequest {
  readonly specifier: string;
  readonly from?: string;
}

export interface LoadedDocument {
  readonly identity: string;
  readonly content: string;
  readonly origin?: SourceLocation;
  /** Optional host version used only as a loading optimization hint. */
  readonly version?: string;
}

export interface DocumentLoader {
  load(request: DocumentRequest, signal?: AbortSignal): Promise<LoadedDocument>;
}

/** Filesystem loader for CLI and Node.js hosts. */
export class FileSystemDocumentLoader implements DocumentLoader {
  readonly #cwd: string;

  constructor(cwd = process.cwd()) {
    this.#cwd = cwd;
  }

  async load(request: DocumentRequest, signal?: AbortSignal): Promise<LoadedDocument> {
    const base = request.from ? dirname(request.from) : this.#cwd;
    const identity = resolve(base, request.specifier);
    const content = await readFile(identity, { encoding: "utf8", signal });
    return Object.freeze({ identity, content });
  }
}

/** Load token sources. Parsing remains a separate, IO-free compiler stage. */
export async function loadTokenFiles(
  patterns: readonly string[],
  cwd = process.cwd(),
  signal?: AbortSignal,
): Promise<readonly TokenSourceInput[]> {
  signal?.throwIfAborted();
  const files = await fg([...patterns], { cwd, absolute: true, onlyFiles: true, unique: true });
  files.sort();
  signal?.throwIfAborted();
  return Promise.all(
    files.map(async (file) => ({
      file: resolve(file),
      content: await readFile(file, { encoding: "utf8", signal }),
    })),
  );
}
