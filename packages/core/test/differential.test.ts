import { describe, expect, it } from "vite-plus/test";

import { ALL_TOKEN_TYPES, type BackendPlan, type TokenBackend } from "../src/backend.js";
import { assertCompilationDifferential, type DifferentialOracleStep } from "../src/differential.js";
import { parseResolverDocument } from "../src/dtcg/resolver-document.js";

const capabilities = {
  tokenTypes: ALL_TOKEN_TYPES,
  referenceStrategies: new Set(["resolve" as const]),
  contextMode: "none" as const,
  colorSpaces: "preserve" as const,
  composite: "native" as const,
};

function backend(suffix: string): TokenBackend {
  return {
    id: `text-${suffix}`,
    capabilities,
    prepare: (ir) => ({
      backendId: `text-${suffix}`,
      diagnostics: [],
      symbols: [],
      artifacts: [
        {
          id: "main",
          path: `dist/${suffix}.txt`,
          mediaType: "text/plain",
          tokenIds: ir.tokens.map((token) => token.id),
          payload: ir.tokens
            .map((token) => `${token.id}:${JSON.stringify(token.value)}`)
            .join("\n"),
        },
      ],
      data: null,
    }),
    emit: (plan: BackendPlan) =>
      plan.artifacts.map((artifact) => ({
        id: artifact.id,
        path: artifact.path,
        content: String(artifact.payload),
      })),
  };
}

function tokenDocument(value: number): string {
  return JSON.stringify({
    base: { $type: "number", $value: value },
    alias: { $type: "number", $value: "{base}" },
  });
}

function inlineResolver(value: number) {
  const parsed = parseResolverDocument(
    JSON.stringify({
      version: "2025.10",
      sets: {
        selected: {
          sources: [{ selected: { $type: "number", $value: value } }],
        },
      },
      resolutionOrder: [{ $ref: "#/sets/selected" }],
    }),
    "/tokens/project.resolver.json",
  );
  if (!parsed.document) throw new Error("Expected a valid Resolver document");
  return parsed.document;
}

function contextualResolver(light: number, dark: number) {
  const parsed = parseResolverDocument(
    JSON.stringify({
      version: "2025.10",
      sets: {
        light: { sources: [{ selected: { $type: "number", $value: light } }] },
        dark: { sources: [{ selected: { $type: "number", $value: dark } }] },
      },
      modifiers: {
        theme: {
          default: "light",
          contexts: {
            light: [{ $ref: "#/sets/light" }],
            dark: [{ $ref: "#/sets/dark" }],
          },
        },
      },
      resolutionOrder: [{ $ref: "#/modifiers/theme" }],
    }),
    "/tokens/contextual.resolver.json",
  );
  if (!parsed.document) throw new Error("Expected a valid contextual Resolver document");
  return parsed.document;
}

function independentDocument(index: number, value: number): string {
  return JSON.stringify({
    [`token${index}`]: { $type: "number", $value: value },
    [`alias${index}`]: { $type: "number", $value: `{token${index}}` },
  });
}

function propertyMutationSteps(seed: number, length: number): readonly DifferentialOracleStep[] {
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
  const documentCount = 6;
  const active = new Set(Array.from({ length: documentCount }, (_, index) => index));
  const steps: DifferentialOracleStep[] = [];

  for (let index = 0; index < length; index += 1) {
    const documentIndex = next() % documentCount;
    const identity = `/tokens/property-${documentIndex}.json`;
    const value = next() % 10_000;
    switch ((next() + index) % 6) {
      case 0: {
        const kind = active.has(documentIndex) ? "update" : "add";
        active.add(documentIndex);
        steps.push({
          transaction: {
            documents: [
              {
                kind,
                document: {
                  identity,
                  content: independentDocument(documentIndex, value),
                },
              },
            ],
          },
        });
        break;
      }
      case 1: {
        const kind = active.has(documentIndex) ? "update" : "add";
        active.add(documentIndex);
        steps.push({
          transaction: {
            documents: [{ kind, document: { identity, content: "{" } }],
          },
        });
        break;
      }
      case 2:
        if (active.has(documentIndex)) {
          active.delete(documentIndex);
          steps.push({ transaction: { documents: [{ kind: "remove", identity }] } });
        } else {
          active.add(documentIndex);
          steps.push({
            transaction: {
              documents: [
                {
                  kind: "add",
                  document: {
                    identity,
                    content: independentDocument(documentIndex, value),
                  },
                },
              ],
            },
          });
        }
        break;
      case 3:
        steps.push({
          transaction: { resolverInput: { theme: next() % 2 === 0 ? "light" : "dark" } },
        });
        break;
      case 4:
        steps.push({
          transaction: {
            config: {
              resolver: contextualResolver(value, value + 1),
              resolverInput: { theme: next() % 2 === 0 ? "light" : "dark" },
              backends: [backend(`property-${seed}-${index}`)],
            },
          },
        });
        break;
      default: {
        const kind = active.has(documentIndex) ? "update" : "add";
        active.add(documentIndex);
        steps.push({
          transaction: {
            documents: [
              {
                kind,
                document: {
                  identity,
                  content: independentDocument(documentIndex, value + 1),
                },
              },
            ],
            resolverInput: { theme: next() % 2 === 0 ? "light" : "dark" },
          },
        });
      }
    }
  }

  return steps;
}

describe("full-vs-session differential oracle", () => {
  it("matches the deterministic M1-08a mutation corpus", async () => {
    const result = await assertCompilationDifferential({
      documents: [
        { identity: "/tokens/main.json", content: tokenDocument(1) },
        {
          identity: "/tokens/independent.json",
          content: '{"independent":{"$type":"number","$value":0}}',
        },
      ],
      steps: [
        {
          transaction: {
            documents: [
              {
                kind: "update",
                document: { identity: "/tokens/main.json", content: tokenDocument(2) },
              },
            ],
          },
        },
        {
          transaction: {
            documents: [
              {
                kind: "add",
                document: {
                  identity: "/tokens/extra.json",
                  content: '{"extra":{"$type":"number","$value":3}}',
                },
              },
            ],
          },
        },
        {
          transaction: { documents: [{ kind: "remove", identity: "/tokens/extra.json" }] },
        },
        {
          transaction: {
            documents: [
              { kind: "update", document: { identity: "/tokens/main.json", content: "{" } },
            ],
          },
        },
        {
          transaction: {
            documents: [
              {
                kind: "update",
                document: { identity: "/tokens/main.json", content: tokenDocument(4) },
              },
            ],
          },
        },
        {
          transaction: {
            config: {
              contexts: { theme: { default: "light", values: ["light", "dark"] } },
            },
          },
        },
        { transaction: { config: { resolver: inlineResolver(5) } } },
        {
          transaction: { config: { resolver: inlineResolver(6), backends: [backend("first")] } },
        },
        {
          transaction: { config: { resolver: inlineResolver(6), backends: [backend("second")] } },
        },
      ],
    });

    expect(result.matches).toBe(true);
    expect(result.steps).toHaveLength(9);
    expect(result.steps.every((step) => step.matches)).toBe(true);
  });

  it("matches a larger deterministic add/update/remove/invalid/config corpus", async () => {
    const documents = Array.from({ length: 12 }, (_, index) => ({
      identity: `/tokens/part-${index}.json`,
      content: independentDocument(index, index),
    }));
    const steps = Array.from({ length: 48 }, (_, index) => {
      const documentIndex = index % documents.length;
      const identity = `/tokens/part-${documentIndex}.json`;
      if (index % 16 === 5)
        return { transaction: { documents: [{ kind: "remove" as const, identity }] } };
      if (index % 16 === 6)
        return {
          transaction: {
            documents: [
              {
                kind: "add" as const,
                document: {
                  identity,
                  content: independentDocument(documentIndex, index + 100),
                },
              },
            ],
          },
        };
      if (index % 16 === 9)
        return {
          transaction: {
            documents: [{ kind: "update" as const, document: { identity, content: "{" } }],
          },
        };
      const config =
        index % 12 === 0
          ? {
              contexts: {
                theme: { default: "light", values: ["light", "dark"] },
                density: { default: "comfortable", values: ["comfortable", "compact"] },
              },
              backends: [backend(`config-${index}`)],
            }
          : undefined;
      return {
        transaction: {
          documents: [
            {
              kind: "update" as const,
              document: {
                identity,
                content: independentDocument(documentIndex, index + 100),
              },
            },
          ],
          ...(config ? { config } : {}),
        },
      };
    });

    const result = await assertCompilationDifferential({ documents, steps });

    expect(result.matches).toBe(true);
    expect(result.steps).toHaveLength(48);
  });

  it.each([1, 42, 0xc0ffee, 0xdeadbeef])(
    "matches seeded property mutation sequence %i",
    async (seed) => {
      const documents = [
        ...Array.from({ length: 6 }, (_, index) => ({
          identity: `/tokens/property-${index}.json`,
          content: independentDocument(index, index),
        })),
        {
          identity: "/tokens/property-consumer.json",
          content: '{"selectedAlias":{"$type":"number","$value":"{selected}"}}',
        },
      ];
      const steps = propertyMutationSteps(seed, 32);
      const result = await assertCompilationDifferential({
        documents,
        config: {
          resolver: contextualResolver(1, 2),
          resolverInput: { theme: "light" },
          backends: [backend(`property-initial-${seed}`)],
        },
        steps,
      });

      expect(result.matches).toBe(true);
      expect(result.steps).toHaveLength(steps.length);
      expect(result.steps.every((step) => step.matches)).toBe(true);
    },
    15_000,
  );

  it("enumerates Resolver-defined Contexts across document and input mutations", async () => {
    const result = await assertCompilationDifferential({
      documents: [
        {
          identity: "/tokens/consumer.json",
          content: '{"alias":{"$type":"number","$value":"{selected}"}}',
        },
      ],
      config: {
        resolver: contextualResolver(1, 2),
        resolverInput: { theme: "light" },
        backends: [backend("resolver")],
      },
      steps: [
        { transaction: { resolverInput: { theme: "dark" } } },
        {
          transaction: {
            config: {
              resolver: contextualResolver(3, 4),
              resolverInput: { theme: "dark" },
              backends: [backend("resolver-next")],
            },
          },
        },
        { transaction: { resolverInput: { theme: "light" } } },
      ],
    });

    expect(result.matches).toBe(true);
    expect(result.steps).toHaveLength(3);
  });

  it("fails closed before unbounded Context enumeration", async () => {
    const contexts = Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => [
        `dimension${index}`,
        { default: "off", values: ["off", "on"] },
      ]),
    );

    await expect(
      assertCompilationDifferential({
        documents: [{ identity: "/tokens/value.json", content: tokenDocument(1) }],
        config: { contexts },
        steps: [{ transaction: {} }],
        contextLimit: 256,
      }),
    ).rejects.toThrow("Differential Context enumeration exceeds limit 256");
  });
});
