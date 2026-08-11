/** A parsed RFC 6901 JSON Pointer, independent of document loading. */
export interface JsonPointer {
  readonly source: string;
  readonly tokens: readonly string[];
}

export interface JsonReference {
  readonly source: string;
  readonly documentUri: string;
  readonly pointer: JsonPointer;
}

export type JsonPointerParseErrorCode =
  | "invalid-syntax"
  | "invalid-percent-encoding"
  | "invalid-escape";

export interface JsonPointerParseError {
  readonly code: JsonPointerParseErrorCode;
  readonly message: string;
  readonly reference: string;
  readonly token?: string;
}

export type JsonPointerParseResult =
  | { readonly ok: true; readonly reference: JsonReference }
  | { readonly ok: false; readonly error: JsonPointerParseError };

export type JsonPointerResolutionErrorCode = "property-not-found" | "invalid-array-index";

export interface JsonPointerResolutionError {
  readonly code: JsonPointerResolutionErrorCode;
  readonly message: string;
  readonly token: string;
  readonly index: number;
  readonly traversed: readonly string[];
}

export type JsonPointerResolutionResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: JsonPointerResolutionError };

function decodeToken(
  token: string,
  reference: string,
):
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly error: JsonPointerParseError } {
  if (/~(?:[^01]|$)/u.test(token))
    return {
      ok: false,
      error: {
        code: "invalid-escape",
        message: `Invalid JSON Pointer escape in token \`${token}\``,
        reference,
        token,
      },
    };
  return { ok: true, value: token.replaceAll("~1", "/").replaceAll("~0", "~") };
}

/** Parse a URI reference into a document URI and an RFC 6901 fragment pointer. */
export function parseJsonPointer(reference: string): JsonPointerParseResult {
  const hash = reference.indexOf("#");
  const documentUri = hash === -1 ? "" : reference.slice(0, hash);
  const encodedPointer = hash === -1 ? reference : reference.slice(hash + 1);
  if (hash === -1 && encodedPointer !== "" && !encodedPointer.startsWith("/"))
    return {
      ok: false,
      error: {
        code: "invalid-syntax",
        message: "A JSON Pointer must be empty or begin with `/`",
        reference,
      },
    };
  let pointer: string;
  try {
    pointer = decodeURIComponent(encodedPointer);
  } catch {
    return {
      ok: false,
      error: {
        code: "invalid-percent-encoding",
        message: "Invalid percent encoding in JSON Pointer",
        reference,
      },
    };
  }
  if (pointer !== "" && !pointer.startsWith("/"))
    return {
      ok: false,
      error: {
        code: "invalid-syntax",
        message: "A JSON Pointer fragment must be empty or begin with `/`",
        reference,
      },
    };
  const tokens: string[] = [];
  for (const encodedToken of pointer === "" ? [] : pointer.slice(1).split("/")) {
    const decoded = decodeToken(encodedToken, reference);
    if (!decoded.ok) return decoded;
    tokens.push(decoded.value);
  }
  return {
    ok: true,
    reference: {
      source: reference,
      documentUri,
      pointer: { source: hash === -1 ? pointer : `#${encodedPointer}`, tokens },
    },
  };
}

/** Resolve a parsed pointer against an already-loaded JavaScript/JSON value. */
export function resolveJsonPointer(
  root: unknown,
  pointer: JsonPointer,
): JsonPointerResolutionResult {
  let current = root;
  const traversed: string[] = [];
  for (const [index, token] of pointer.tokens.entries()) {
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(token))
        return {
          ok: false,
          error: {
            code: "invalid-array-index",
            message: `\`${token}\` is not a valid JSON Pointer array index`,
            token,
            index,
            traversed,
          },
        };
      const arrayIndex = Number(token);
      if (!Number.isSafeInteger(arrayIndex) || arrayIndex >= current.length)
        return {
          ok: false,
          error: {
            code: "invalid-array-index",
            message: `Array index ${token} is outside the target array`,
            token,
            index,
            traversed,
          },
        };
      current = current[arrayIndex];
    } else if (
      current !== null &&
      typeof current === "object" &&
      Object.prototype.hasOwnProperty.call(current, token)
    ) {
      current = Reflect.get(current, token);
    } else {
      return {
        ok: false,
        error: {
          code: "property-not-found",
          message: `JSON Pointer property \`${token}\` does not exist`,
          token,
          index,
          traversed,
        },
      };
    }
    traversed.push(token);
  }
  return { ok: true, value: current };
}

/** Escape one object key for use as an RFC 6901 reference token. */
export function encodeJsonPointerToken(token: string): string {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
}
