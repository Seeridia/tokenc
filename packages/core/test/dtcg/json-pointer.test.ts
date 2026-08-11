import { describe, expect, it } from "vite-plus/test";

import { parseJsonPointer, resolveJsonPointer } from "../../src/dtcg/json-pointer.js";

function pointer(reference: string) {
  const parsed = parseJsonPointer(reference);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.reference.pointer;
}

describe("RFC 6901 JSON Pointer", () => {
  it.each([
    ["#", []],
    ["#/foo", ["foo"]],
    ["#/foo/bar", ["foo", "bar"]],
    ["#/a~1b/~0key", ["a/b", "~key"]],
  ])("parses %s", (reference, expected) => {
    const parsed = parseJsonPointer(reference);
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.reference.pointer.tokens).toEqual(expected);
  });

  it("separates an external document URI from its fragment", () => {
    const parsed = parseJsonPointer("other.json#/foo");
    expect(parsed).toMatchObject({
      ok: true,
      reference: { documentUri: "other.json", pointer: { tokens: ["foo"] } },
    });
  });

  it("resolves roots, objects, escaped keys, and arrays", () => {
    const root = { foo: [{ "a/b": { "~key": 42 } }] };
    expect(resolveJsonPointer(root, pointer("#"))).toEqual({ ok: true, value: root });
    expect(resolveJsonPointer(root, pointer("#/foo/0/a~1b/~0key"))).toEqual({
      ok: true,
      value: 42,
    });
  });

  it.each(["#/bad~2escape", "#not-a-pointer", "pointer"])(
    "rejects invalid syntax in %s",
    (reference) => expect(parseJsonPointer(reference)).toMatchObject({ ok: false }),
  );

  it("distinguishes missing properties and invalid array indexes", () => {
    expect(resolveJsonPointer({ foo: [] }, pointer("#/bar"))).toMatchObject({
      ok: false,
      error: { code: "property-not-found" },
    });
    expect(resolveJsonPointer({ foo: [] }, pointer("#/foo/01"))).toMatchObject({
      ok: false,
      error: { code: "invalid-array-index" },
    });
    expect(resolveJsonPointer({ foo: [] }, pointer("#/foo/0"))).toMatchObject({
      ok: false,
      error: { code: "invalid-array-index" },
    });
  });
});
