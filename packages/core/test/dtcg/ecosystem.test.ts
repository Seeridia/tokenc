import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import {
  compileDocuments,
  parseResolverDocument,
  resolverSourceFiles,
  type CompilationContext,
  type ResolverDocument,
} from "../../src/index.js";

interface EcosystemBaseline {
  readonly tokens: number;
  readonly diagnostics: Readonly<
    Record<
      string,
      {
        readonly count: number;
        readonly category: "unsupported-input" | "nonstandard-extension" | "implementation-gap";
      }
    >
  >;
}

const unsupported = (count: number) => ({ count, category: "unsupported-input" as const });
const extension = (count: number) => ({ count, category: "nonstandard-extension" as const });
const gap = (count: number) => ({ count, category: "implementation-gap" as const });

/**
 * dtcg-examples is a versioned community interoperability corpus maintained by the Terrazzo
 * project. It is not an official DTCG conformance suite. Exact token and categorized diagnostic
 * counts make both regressions and accidental disappearance/downgrading of checks visible. An
 * intentional compatibility improvement must update this reviewable baseline.
 */
const BASELINE: Readonly<Record<string, EcosystemBaseline>> = {
  "adobe-spectrum.resolver.json": {
    tokens: 1414,
    diagnostics: {
      DTCG_INVALID_COLOR: unsupported(8),
      TOKEN_CANNOT_INFER_TYPE: gap(111),
      TOKEN_INVALID_TYPE: extension(154),
      TOKEN_INVALID_VALUE: unsupported(3),
      TOKEN_MISSING_TYPE: gap(43),
      TOKEN_UNKNOWN_REFERENCE: gap(12),
    },
  },
  "apple-hig.resolver.json": {
    tokens: 1,
    diagnostics: {
      TOKEN_MISSING_TYPE: gap(17),
      TOKEN_UNKNOWN_REFERENCE: gap(11),
    },
  },
  "figma-sds.resolver.json": {
    tokens: 279,
    diagnostics: { DTCG_INVALID_COMPOSITE_VALUE: unsupported(19) },
  },
  "github-primer.resolver.json": {
    tokens: 1401,
    diagnostics: {
      DTCG_INVALID_COMPOSITE_VALUE: unsupported(14),
      DTCG_INVALID_TOKEN_STRUCTURE: extension(36),
      TOKEN_INVALID_TYPE: extension(3),
      TOKEN_INVALID_VALUE: unsupported(2),
      TOKEN_MISSING_TYPE: gap(3),
      TOKEN_UNKNOWN_REFERENCE: gap(74),
    },
  },
  "ibm-carbon.resolver.json": {
    tokens: 288,
    diagnostics: {
      DTCG_INVALID_COLOR: unsupported(6),
      DTCG_INVALID_COMPOSITE_VALUE: unsupported(58),
      TOKEN_INVALID_VALUE: unsupported(4),
    },
  },
  "microsoft-fluent.resolver.json": {
    tokens: 147,
    diagnostics: {
      DTCG_INVALID_COLOR: unsupported(19),
      DTCG_INVALID_COMPOSITE_VALUE: unsupported(13),
    },
  },
  "shopify-polaris.resolver.json": {
    tokens: 67,
    diagnostics: {},
  },
};

const examplesRoot = dirname(fileURLToPath(import.meta.resolve("dtcg-examples/package.json")));

function defaultInput(document: ResolverDocument): CompilationContext {
  const input: Record<string, string> = {};
  for (const [name, modifier] of document.modifiers) {
    const selected = modifier.default ?? Object.keys(modifier.contexts)[0];
    if (selected) input[name] = selected;
  }
  return input;
}

describe("dtcg-examples ecosystem compatibility", () => {
  it("does not regress the categorized 1.1.3 compatibility baseline", async () => {
    const resolverFiles = (await readdir(examplesRoot))
      .filter((file) => file.endsWith(".resolver.json"))
      .toSorted();
    expect(resolverFiles).toEqual(Object.keys(BASELINE).toSorted());

    await Promise.all(
      resolverFiles.map(async (resolverFile) => {
        const baseline = BASELINE[resolverFile];
        expect(baseline).toBeDefined();
        if (!baseline) return;

        const source = join(examplesRoot, resolverFile);
        const parsed = parseResolverDocument(await readFile(source, "utf8"), source);
        expect(
          parsed.document,
          `${resolverFile} should be a valid Resolver document`,
        ).toBeDefined();
        if (!parsed.document) return;

        const sources = await Promise.all(
          resolverSourceFiles(parsed.document).map(async (file) => ({
            file,
            content: await readFile(file, "utf8"),
          })),
        );
        const result = await compileDocuments(sources, {
          resolver: parsed.document,
          resolverInput: defaultInput(parsed.document),
          resolverDiagnostics: parsed.diagnostics,
        });
        const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
        const counts = new Map<string, number>();
        for (const diagnostic of errors)
          counts.set(diagnostic.code, (counts.get(diagnostic.code) ?? 0) + 1);

        expect(result.graph.size, `${resolverFile} token count changed`).toBe(baseline.tokens);
        expect(
          Object.fromEntries(counts),
          `${resolverFile} categorized diagnostic baseline changed`,
        ).toEqual(
          Object.fromEntries(
            Object.entries(baseline.diagnostics).map(([code, diagnostic]) => [
              code,
              diagnostic.count,
            ]),
          ),
        );
      }),
    );
  });
});
