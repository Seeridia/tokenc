import { isValidTokenSegment } from "./dtcg/format.js";
import type { TokenId } from "./model.js";

/** Parse and validate a canonical dot-separated token ID. */
export function parseTokenId(input: string): TokenId {
  if (!input || input.split(".").some((part) => !isValidTokenSegment(part))) {
    throw new TypeError(`Invalid token ID: ${input}`);
  }
  // Branded strings have no runtime constructor; this is the single assertion after validation.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return input as TokenId;
}

/** Format a token ID for display or serialization. */
export function formatTokenId(id: TokenId): string {
  return id;
}

/** Return the parent ID, or undefined for a top-level token. */
export function parentTokenId(id: TokenId): TokenId | undefined {
  const boundary = id.lastIndexOf(".");
  return boundary === -1 ? undefined : parseTokenId(id.slice(0, boundary));
}

/** Create a canonical ID from path segments. */
export function tokenIdFromSegments(segments: readonly string[]): TokenId {
  return parseTokenId(segments.join("."));
}

/** Split only at API boundaries; graph internals always retain canonical IDs. */
export function tokenIdSegments(id: TokenId): readonly string[] {
  return id.split(".");
}
