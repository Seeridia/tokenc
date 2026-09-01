import { describe, expect, it } from "vite-plus/test";

import explainTraceSchema from "../schema/explain-trace-v1.schema.json" with { type: "json" };
import { compileDocuments } from "../src/compiler.js";
import { contextPredicateFromSelector, createContextDomain } from "../src/predicate.js";
import { parseTokenId } from "../src/token-id.js";
import { assertSchemaConformance } from "./support/schema-conformance.js";

const contexts = { theme: { default: "light", values: ["light", "dark"] } } as const;
const source = {
  file: "query.json",
  content: JSON.stringify({
    x: { $type: "number", $value: 1 },
    a: {
      $type: "number",
      $value: 2,
      $extensions: { "org.token-compiler.contexts": { "theme=dark": "{x}" } },
    },
    b: {
      $type: "number",
      $value: 3,
      $extensions: { "org.token-compiler.contexts": { "theme=light": "{a}" } },
    },
  }),
};

describe("CompilationQuery", () => {
  it("queries source-located conditional dependencies and usages", async () => {
    const result = await compileDocuments([source], { contexts });
    if (result.status !== "valid") throw new Error("Expected a valid snapshot");
    const query = result.query;
    const a = parseTokenId("a");
    const x = parseTokenId("x");

    expect(query.context()).toEqual({ theme: "light" });
    expect(query.context({ theme: "dark" })).toEqual({ theme: "dark" });
    expect(Object.isFrozen(query.context())).toBe(true);

    expect(query.dependencies(a)).toMatchObject([
      {
        schemaVersion: "1",
        from: "a",
        to: "x",
        kind: "alias",
        source: { file: "query.json" },
        condition: { clauses: [{ theme: ["dark"] }] },
      },
    ]);
    expect(query.dependencies(a, { context: { theme: "light" } })).toEqual([]);
    expect(query.dependencies(a, { context: { theme: "dark" } })).toHaveLength(1);
    expect(query.usages(x, { context: { theme: "dark" } })[0]).toMatchObject({
      from: "a",
      to: "x",
    });

    const dark = contextPredicateFromSelector(createContextDomain(contexts), { theme: "dark" });
    if (!dark.ok) throw new Error(dark.error.message);
    expect(query.dependencies(a, { predicate: dark.value })).toHaveLength(1);
  });

  it("does not propagate impact through mutually exclusive Context regions", async () => {
    const result = await compileDocuments([source], { contexts });
    if (result.status !== "valid") throw new Error("Expected a valid snapshot");
    const query = result.query;
    const impact = query.impact([parseTokenId("x")]);

    expect(impact.changed.map((entry) => entry.token)).toEqual(["x"]);
    expect(impact.directlyAffected.map((entry) => entry.token)).toEqual(["a"]);
    expect(impact.indirectlyAffected).toEqual([]);
    expect(query.impact([parseTokenId("x")], { context: { theme: "light" } })).toMatchObject({
      directlyAffected: [],
      indirectlyAffected: [],
    });
  });

  it("returns byte-identical, versioned explain traces", async () => {
    const result = await compileDocuments([source], { contexts });
    if (result.status !== "valid") throw new Error("Expected a valid snapshot");
    const query = result.query;
    const id = parseTokenId("a");
    const first = query.explain(id, { theme: "dark" });
    const second = query.explain(id, { theme: "dark" });

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first).toMatchObject({
      schemaVersion: "1",
      token: "a",
      context: { theme: "dark" },
      finalValue: 1,
      steps: [
        {
          token: "a",
          candidate: "a#override:0",
          selection: "override",
          dependencies: [{ target: "x", candidate: "a#override:0", kind: "alias" }],
        },
        { token: "x", candidate: "x#base", selection: "base", dependencies: [] },
      ],
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first?.steps)).toBe(true);
    expect(() => assertSchemaConformance(first, explainTraceSchema)).not.toThrow();
  });

  it("orders graph and completion results deterministically", async () => {
    const result = await compileDocuments([source], { contexts });
    if (result.status !== "valid") throw new Error("Expected a valid snapshot");
    const query = result.query;
    expect(query.completions()).toEqual(["a", "b", "x"]);
    expect(query.graph().map((edge) => `${edge.from}:${edge.to}:${edge.condition.key}`)).toEqual([
      'a:x:[{"theme":["dark"]}]',
      'b:a:[{"theme":["light"]}]',
    ]);
    expect(JSON.stringify(query.graph())).toBe(JSON.stringify(query.graph()));
  });
});
