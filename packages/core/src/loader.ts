import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import fg from "fast-glob";

import type { SourceLocation } from "./model.js";

export interface TokenSourceInput {
  readonly file: string;
  readonly content: string;
  /** Origin when content is an inline slice of another source document. */
  readonly origin?: SourceLocation;
}

/** Load token sources. Parsing remains a separate, IO-free compiler stage. */
export async function loadTokenFiles(
  patterns: readonly string[],
  cwd = process.cwd(),
): Promise<readonly TokenSourceInput[]> {
  const files = await fg([...patterns], { cwd, absolute: true, onlyFiles: true, unique: true });
  files.sort();
  return Promise.all(
    files.map(async (file) => ({ file: resolve(file), content: await readFile(file, "utf8") })),
  );
}
