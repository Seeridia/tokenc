import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { css } from "@tokenc/backend-css";
import {
  compileDocuments,
  createCompilerSession,
  parseResolverDocument,
  resolverSourceFiles,
  type CompilationContext,
  type ContextDefinition,
  type ResolverDocument,
  type TokenSourceInput,
} from "@tokenc/core";

import { changeIntelligenceBenchmarkCases } from "./change-intelligence.js";
import type {
  BenchmarkCaseDefinition,
  BenchmarkExpectation,
  BenchmarkFixtureGroup,
  BenchmarkFixtureKind,
  BenchmarkFixtureMetadata,
  BenchmarkInvocation,
  BenchmarkRunResult,
} from "./types.js";

export interface BenchmarkFixtureFile {
  /** Stable path relative to the fixture root. Absolute paths are deliberately rejected. */
  readonly path: string;
  readonly content: string;
}

interface FixtureDescriptorOptions {
  readonly kind: BenchmarkFixtureKind;
  readonly version: string;
  readonly description: string;
  readonly files: readonly BenchmarkFixtureFile[];
  readonly parameters?: Readonly<Record<string, boolean | number | string>>;
  readonly package?: BenchmarkFixtureMetadata["package"];
}

interface ColdCaseOptions {
  readonly id: string;
  readonly name: string;
  readonly group: BenchmarkFixtureGroup;
  readonly fixture: BenchmarkFixtureMetadata | (() => BenchmarkFixtureMetadata);
  readonly expected: BenchmarkExpectation;
  readonly outputTarget?: "css" | "none";
  readonly createRun:
    | (() => () => Promise<BenchmarkRunResult>)
    | (() => Promise<() => Promise<BenchmarkRunResult>>);
}

function logicalPath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (
    normalized.startsWith("/") ||
    /^[a-zA-Z]:\//u.test(normalized) ||
    normalized.split("/").includes("..") ||
    normalized.length === 0
  )
    throw new TypeError(`Fixture path must be a non-empty relative path: ${path}`);
  return normalized;
}

/** Hash fixture identity independently of source order and machine-specific absolute paths. */
export function fixtureSha256(files: readonly BenchmarkFixtureFile[]): `sha256:${string}` {
  const canonical = files
    .map((file) => ({ path: logicalPath(file.path), content: file.content }))
    .toSorted((left, right) => left.path.localeCompare(right.path));
  for (let index = 1; index < canonical.length; index += 1)
    if (canonical[index - 1]?.path === canonical[index]?.path)
      throw new TypeError(`Fixture contains duplicate path: ${canonical[index]?.path}`);
  const hash = createHash("sha256");
  hash.update("tokenc-benchmark-fixture-v1\0");
  for (const file of canonical) {
    const pathBytes = Buffer.from(file.path);
    const contentBytes = Buffer.from(file.content);
    hash.update(`${pathBytes.byteLength}:`);
    hash.update(pathBytes);
    hash.update(`${contentBytes.byteLength}:`);
    hash.update(contentBytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

export function fixtureDescriptor(options: FixtureDescriptorOptions): BenchmarkFixtureMetadata {
  return {
    kind: options.kind,
    version: options.version,
    sha256: fixtureSha256(options.files),
    files: options.files.length,
    bytes: options.files.reduce((bytes, file) => bytes + Buffer.byteLength(file.content), 0),
    description: options.description,
    ...(options.parameters ? { parameters: options.parameters } : {}),
    ...(options.package ? { package: options.package } : {}),
  };
}

function singleUse(run: () => Promise<BenchmarkRunResult>): BenchmarkInvocation {
  let used = false;
  return {
    async run() {
      if (used) throw new Error("Benchmark invocation has already run");
      used = true;
      return run();
    },
  };
}

function coldCase(options: ColdCaseOptions): BenchmarkCaseDefinition {
  let cachedFixture: BenchmarkFixtureMetadata | undefined;
  return {
    id: options.id,
    name: options.name,
    group: options.group,
    get fixture() {
      cachedFixture ??= typeof options.fixture === "function" ? options.fixture() : options.fixture;
      return cachedFixture;
    },
    operation: {
      kind: "cold-compile",
      cacheState: "compiler-cold-runtime-warm",
      outputTarget: options.outputTarget ?? "none",
      ioIncluded: false,
    },
    expected: options.expected,
    async createInvocation() {
      return singleUse(await options.createRun());
    },
  };
}

function source(path: string, content: string): TokenSourceInput {
  return { file: `/benchmark/${path}`, content };
}

function sourceFiles(sources: readonly TokenSourceInput[]): readonly BenchmarkFixtureFile[] {
  return sources.map((entry) => ({
    path: entry.file.replace(/^\/benchmark\//u, ""),
    content: entry.content,
  }));
}

function independentTokens(count: number, name = `wide-${count}`): TokenSourceInput {
  return source(
    `${name}.tokens.json`,
    JSON.stringify(
      Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          `token${index}`,
          { $type: "number", $value: index },
        ]),
      ),
    ),
  );
}

function aliasChain(count: number): TokenSourceInput {
  return source(
    `deep-${count}.tokens.json`,
    JSON.stringify(
      Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          `alias${index}`,
          { $type: "number", $value: index === 0 ? 0 : `{alias${index - 1}}` },
        ]),
      ),
    ),
  );
}

function fanOut(count: number): readonly TokenSourceInput[] {
  return [
    source("fan-out-base.tokens.json", '{"base":{"$type":"number","$value":1}}'),
    source(
      `fan-out-${count}.tokens.json`,
      JSON.stringify(
        Object.fromEntries(
          Array.from({ length: count }, (_, index) => [
            `consumer${index}`,
            { $type: "number", $value: "{base}" },
          ]),
        ),
      ),
    ),
  ];
}

function sparseContexts(count: number): TokenSourceInput {
  return source(
    `sparse-context-${count}.tokens.json`,
    JSON.stringify(
      Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          `themed${index}`,
          {
            $type: "number",
            $value: index,
            $extensions: { "org.token-compiler.contexts": { "theme=dark": index + 1 } },
          },
        ]),
      ),
    ),
  );
}

function projectionFixture(dimensions: number): {
  readonly source: TokenSourceInput;
  readonly contexts: ContextDefinition;
} {
  const names = Array.from({ length: dimensions }, (_, index) => `dimension-${index}`);
  const contexts = Object.fromEntries(
    names.map((name) => [name, { default: "off", values: ["off", "on"] }]),
  );
  const selector = names.map((name) => `${name}=on`).join("&");
  return {
    source: source(
      `context-projection-${dimensions}.tokens.json`,
      JSON.stringify({
        a: {
          $type: "number",
          $value: 1,
          $extensions: { "org.token-compiler.contexts": { [selector]: "{b}" } },
        },
        b: { $type: "number", $value: "{a}" },
      }),
    ),
    contexts,
  };
}

function overrideHeavy(count: number): {
  readonly source: TokenSourceInput;
  readonly contexts: ContextDefinition;
} {
  const selectors = [
    "theme=dark",
    "theme=contrast",
    "density=compact",
    "brand=enterprise",
    "motion=reduced",
    "theme=dark&density=compact",
    "theme=contrast&brand=enterprise",
    "brand=enterprise&motion=reduced",
  ];
  return {
    source: source(
      `override-heavy-${count}.tokens.json`,
      JSON.stringify(
        Object.fromEntries(
          Array.from({ length: count }, (_, index) => [
            `token${index}`,
            {
              $type: "number",
              $value: index,
              $extensions: {
                "org.token-compiler.contexts": Object.fromEntries(
                  selectors.map((selector, selectorIndex) => [selector, index + selectorIndex + 1]),
                ),
              },
            },
          ]),
        ),
      ),
    ),
    contexts: {
      theme: { default: "light", values: ["light", "dark", "contrast"] },
      density: { default: "comfortable", values: ["comfortable", "compact"] },
      brand: { default: "default", values: ["default", "enterprise"] },
      motion: { default: "full", values: ["full", "reduced"] },
    },
  };
}

function representativeProject(): {
  readonly sources: readonly TokenSourceInput[];
  readonly contexts: ContextDefinition;
} {
  const primitives = Object.fromEntries(
    Array.from({ length: 600 }, (_, index) => [
      `primitive${index}`,
      { $type: "number", $value: index },
    ]),
  );
  const semantics = Object.fromEntries(
    Array.from({ length: 600 }, (_, index) => [
      `semantic${index}`,
      {
        $type: "number",
        $value: `{primitive.primitive${index}}`,
        ...(index % 5 === 0
          ? {
              $extensions: {
                "org.token-compiler.contexts": { "theme=dark": index + 1_000 },
              },
            }
          : {}),
      },
    ]),
  );
  const components = Object.fromEntries(
    Array.from({ length: 800 }, (_, index) => [
      `component${index}`,
      { $type: "number", $value: `{semantic.semantic${index % 600}}` },
    ]),
  );
  return {
    sources: [
      source("representative/primitive.tokens.json", JSON.stringify({ primitive: primitives })),
      source("representative/semantic.tokens.json", JSON.stringify({ semantic: semantics })),
      source("representative/component.tokens.json", JSON.stringify({ component: components })),
    ],
    contexts: { theme: { default: "light", values: ["light", "dark"] } },
  };
}

function defaultResolverInput(document: ResolverDocument): CompilationContext {
  const input: Record<string, string> = {};
  for (const [name, modifier] of document.modifiers) {
    const selected = modifier.default ?? Object.keys(modifier.contexts)[0];
    if (selected) input[name] = selected;
  }
  return input;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function packageIdentity(content: string): NonNullable<BenchmarkFixtureMetadata["package"]> {
  const parsed: unknown = JSON.parse(content);
  if (
    !isRecord(parsed) ||
    typeof parsed.name !== "string" ||
    typeof parsed.version !== "string" ||
    typeof parsed.license !== "string"
  )
    throw new TypeError("dtcg-examples package metadata is invalid");
  return { name: parsed.name, version: parsed.version, license: parsed.license };
}

const smallContent = readFileSync(
  new URL("../packages/core/test/fixtures/basic/tokens.json", import.meta.url),
  "utf8",
);
const smallSource = source("small-conformance.tokens.json", smallContent);
const smallFiles = sourceFiles([smallSource]);

const wideCases = [1_000, 10_000].map((count): BenchmarkCaseDefinition => {
  return coldCase({
    id: `synthetic/wide/cold/${count}`,
    name: `${count.toLocaleString("en-US")}-token wide cold compile`,
    group: "wide",
    fixture: () => {
      const input = independentTokens(count);
      return fixtureDescriptor({
        kind: "synthetic",
        version: "1",
        description: `${count} independent number tokens`,
        files: sourceFiles([input]),
        parameters: { tokens: count },
      });
    },
    expected: { success: true, tokens: count, references: 0, outputFiles: 0 },
    createRun: () => {
      const input = independentTokens(count);
      return async () => ({ snapshot: await compileDocuments([input]) });
    },
  });
});

const sparseDefinition: ContextDefinition = {
  theme: { default: "light", values: ["light", "dark"] },
};

const projectionCases = [8, 10, 12, 14, 15].map((dimensions): BenchmarkCaseDefinition => {
  return coldCase({
    id: `synthetic/context-projection/cold/${dimensions}`,
    name: `${dimensions}-dimension conditional-cycle projection`,
    group: "multidimensional-context",
    fixture: () => {
      const fixture = projectionFixture(dimensions);
      return fixtureDescriptor({
        kind: "synthetic",
        version: "2",
        description: `Two-token symbolically analyzed conditional cycle spanning ${dimensions} binary dimensions`,
        files: sourceFiles([fixture.source]),
        parameters: {
          dimensions,
          estimatedProjections: 2 ** dimensions,
          symbolicPredicate: true,
        },
      });
    },
    expected: {
      success: false,
      tokens: 2,
      references: 2,
      contextCycles: {
        candidateRegions: 1,
        relevantDimensions: dimensions,
        estimatedProjections: 0,
        estimateSaturated: false,
        enumeratedProjections: 0,
        earlyExits: 0,
        limitHits: 0,
      },
      diagnostics: { TOKEN_CIRCULAR_REFERENCE: 1 },
    },
    createRun: () => {
      const fixture = projectionFixture(dimensions);
      return async () => ({
        snapshot: await compileDocuments([fixture.source], { contexts: fixture.contexts }),
      });
    },
  });
});

const primitive = (value: number): TokenSourceInput =>
  source(
    "incremental/primitive.tokens.json",
    JSON.stringify({ base: { $type: "number", $value: value } }),
  );
const incrementalSemantic = source(
  "incremental/semantic.tokens.json",
  JSON.stringify({
    semantic: { $type: "number", $value: "{base}" },
    ...Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [
        `component${index}`,
        { $type: "number", $value: "{semantic}" },
      ]),
    ),
  }),
);
function incrementalSources(): readonly TokenSourceInput[] {
  return [
    independentTokens(10_000, "incremental/independent-10000"),
    primitive(1),
    incrementalSemantic,
  ];
}

const syntheticCases: readonly BenchmarkCaseDefinition[] = [
  coldCase({
    id: "repository/small/cold/basic",
    name: "Small conformance cold compile",
    group: "small",
    fixture: fixtureDescriptor({
      kind: "repository",
      version: "1",
      description: "Small checked-in DTCG fixture covering common primitive token types",
      files: smallFiles,
      parameters: { source: "packages/core/test/fixtures/basic/tokens.json" },
    }),
    expected: { success: true, tokens: 5, references: 0, outputFiles: 0 },
    createRun: () => async () => ({ snapshot: await compileDocuments([smallSource]) }),
  }),
  ...wideCases,
  coldCase({
    id: "synthetic/deep/cold/10000",
    name: "10,000-token deep alias cold compile",
    group: "deep",
    fixture: () => {
      const input = aliasChain(10_000);
      return fixtureDescriptor({
        kind: "synthetic",
        version: "1",
        description: "A linear alias chain used for graph depth and stack-safety measurement",
        files: sourceFiles([input]),
        parameters: { tokens: 10_000 },
      });
    },
    expected: { success: true, tokens: 10_000, references: 9_999, outputFiles: 0 },
    createRun: () => {
      const input = aliasChain(10_000);
      return async () => ({ snapshot: await compileDocuments([input]) });
    },
  }),
  coldCase({
    id: "synthetic/fan-out/cold/2000",
    name: "2,000-way fan-out cold compile",
    group: "fan-out",
    fixture: () => {
      const inputs = fanOut(2_000);
      return fixtureDescriptor({
        kind: "synthetic",
        version: "1",
        description: "One primitive referenced by 2,000 direct dependents",
        files: sourceFiles(inputs),
        parameters: { dependents: 2_000 },
      });
    },
    expected: { success: true, tokens: 2_001, references: 2_000, outputFiles: 0 },
    createRun: () => {
      const inputs = fanOut(2_000);
      return async () => ({ snapshot: await compileDocuments(inputs) });
    },
  }),
  coldCase({
    id: "synthetic/sparse-context/cold/1000",
    name: "1,000-token sparse Context cold compile",
    group: "sparse-context",
    fixture: () => {
      const input = sparseContexts(1_000);
      return fixtureDescriptor({
        kind: "synthetic",
        version: "1",
        description: "Number tokens with one sparse dark-theme override each",
        files: sourceFiles([input]),
        parameters: { tokens: 1_000, dimensions: 1, overridesPerToken: 1 },
      });
    },
    expected: { success: true, tokens: 1_000, references: 0, contexts: 2, outputFiles: 0 },
    createRun: () => {
      const input = sparseContexts(1_000);
      return async () => ({
        snapshot: await compileDocuments([input], { contexts: sparseDefinition }),
      });
    },
  }),
  ...projectionCases,
  coldCase({
    id: "synthetic/override-heavy/cold/1000x8",
    name: "1,000-token override-heavy cold compile",
    group: "override-heavy",
    fixture: () => {
      const fixture = overrideHeavy(1_000);
      return fixtureDescriptor({
        kind: "synthetic",
        version: "1",
        description: "1,000 number tokens with eight overlapping Context overrides each",
        files: sourceFiles([fixture.source]),
        parameters: { tokens: 1_000, overridesPerToken: 8, dimensions: 4 },
      });
    },
    expected: { success: true, tokens: 1_000, references: 0, outputFiles: 0 },
    createRun: () => {
      const fixture = overrideHeavy(1_000);
      return async () => ({
        snapshot: await compileDocuments([fixture.source], { contexts: fixture.contexts }),
      });
    },
  }),
  {
    id: "synthetic/incremental/point-edit/10000+12",
    name: "10,000-token session with a 12-token point edit",
    group: "incremental",
    get fixture() {
      const initial = incrementalSources();
      return fixtureDescriptor({
        kind: "synthetic",
        version: "1",
        description: "10,000 unrelated tokens plus one primitive and eleven transitive dependents",
        files: [
          ...sourceFiles(initial),
          { path: "incremental/primitive.updated.tokens.json", content: primitive(2).content },
        ],
        parameters: { unrelatedTokens: 10_000, affectedTokens: 12 },
      });
    },
    operation: {
      kind: "incremental-update",
      cacheState: "initialized-session",
      outputTarget: "none",
      ioIncluded: false,
    },
    expected: {
      success: true,
      tokens: 10_012,
      references: 11,
      affectedTokens: 12,
      recomputedTokens: 12,
      outputFiles: 0,
    },
    async createInvocation() {
      const initial = incrementalSources();
      const session = createCompilerSession();
      await session.apply({
        documents: initial.map((input) => ({
          kind: "add",
          document: { identity: input.file, content: input.content },
        })),
      });
      return singleUse(async () => {
        const snapshot = await session.apply({
          documents: [
            {
              kind: "update",
              document: {
                identity: primitive(2).file,
                content: primitive(2).content,
              },
            },
          ],
        });
        return {
          snapshot,
          ...(session.metrics ? { session: session.metrics } : {}),
        };
      });
    },
  },
  coldCase({
    id: "synthetic/representative/cold/css",
    name: "Synthetic representative project with CSS emit",
    group: "representative",
    fixture: () => {
      const fixture = representativeProject();
      return fixtureDescriptor({
        kind: "synthetic",
        version: "1",
        description:
          "Publishable generated project with primitive, semantic, component, and Context layers; not a real customer corpus",
        files: sourceFiles(fixture.sources),
        parameters: { tokens: 2_000, dimensions: 1, output: "css" },
      });
    },
    expected: {
      success: true,
      tokens: 2_000,
      references: 1_400,
      contexts: 2,
      outputFiles: 1,
    },
    outputTarget: "css",
    createRun: () => {
      const fixture = representativeProject();
      return async () => {
        const snapshot = await compileDocuments(fixture.sources, {
          contexts: fixture.contexts,
        });
        const backend =
          snapshot.status === "valid"
            ? await snapshot.emit([css({ output: "tokens.css", references: "preserve" })])
            : undefined;
        return { snapshot, ...(backend ? { backend } : {}) };
      };
    },
  }),
];

const DTCG_EXPECTATIONS: Readonly<
  Record<
    string,
    { readonly tokens: number; readonly diagnostics: Readonly<Record<string, number>> }
  >
> = {
  "adobe-spectrum.resolver.json": {
    tokens: 1_414,
    diagnostics: {
      DTCG_INVALID_COLOR: 8,
      TOKEN_CANNOT_INFER_TYPE: 111,
      TOKEN_INVALID_TYPE: 154,
      TOKEN_INVALID_VALUE: 3,
      TOKEN_MISSING_TYPE: 43,
      TOKEN_UNKNOWN_REFERENCE: 12,
    },
  },
  "apple-hig.resolver.json": {
    tokens: 1,
    diagnostics: { TOKEN_MISSING_TYPE: 17, TOKEN_UNKNOWN_REFERENCE: 11 },
  },
  "figma-sds.resolver.json": {
    tokens: 279,
    diagnostics: { DTCG_INVALID_COMPOSITE_VALUE: 19 },
  },
  "github-primer.resolver.json": {
    tokens: 1_401,
    diagnostics: {
      DTCG_INVALID_COMPOSITE_VALUE: 14,
      DTCG_INVALID_TOKEN_STRUCTURE: 36,
      TOKEN_INVALID_TYPE: 3,
      TOKEN_INVALID_VALUE: 2,
      TOKEN_MISSING_TYPE: 3,
      TOKEN_UNKNOWN_REFERENCE: 74,
    },
  },
  "ibm-carbon.resolver.json": {
    tokens: 288,
    diagnostics: {
      DTCG_INVALID_COLOR: 6,
      DTCG_INVALID_COMPOSITE_VALUE: 58,
      TOKEN_INVALID_VALUE: 4,
    },
  },
  "microsoft-fluent.resolver.json": {
    tokens: 147,
    diagnostics: { DTCG_INVALID_COLOR: 19, DTCG_INVALID_COMPOSITE_VALUE: 13 },
  },
  "shopify-polaris.resolver.json": { tokens: 67, diagnostics: {} },
};

function dtcgCases(): readonly BenchmarkCaseDefinition[] {
  const packagePath = fileURLToPath(import.meta.resolve("dtcg-examples/package.json"));
  const packageRoot = dirname(packagePath);
  const packageInfo = packageIdentity(readFileSync(packagePath, "utf8"));
  return Object.entries(DTCG_EXPECTATIONS).map(([resolverName, expected]) => {
    const load = () => {
      const resolverPath = resolve(packageRoot, resolverName);
      const resolverContent = readFileSync(resolverPath, "utf8");
      const parsed = parseResolverDocument(resolverContent, resolverPath);
      if (!parsed.document) throw new Error(`Invalid pinned Resolver fixture: ${resolverName}`);
      const document = parsed.document;
      const inputs = resolverSourceFiles(document).map((file) => ({
        file,
        content: readFileSync(file, "utf8"),
      }));
      const files: BenchmarkFixtureFile[] = [
        { path: resolverName, content: resolverContent },
        ...inputs.map((input) => ({
          path: relative(packageRoot, input.file).replaceAll("\\", "/"),
          content: input.content,
        })),
      ];
      return { parsed, document, inputs, files };
    };
    const diagnostics = expected.diagnostics;
    return coldCase({
      id: `ecosystem/dtcg-examples/${resolverName.replace(/\.resolver\.json$/u, "")}/default`,
      name: `dtcg-examples ${resolverName} default resolution`,
      group: "dtcg-examples",
      fixture: () => {
        const loaded = load();
        return fixtureDescriptor({
          kind: "ecosystem",
          version: "1",
          description: `Pinned ${resolverName} corpus fixture using its default Resolver input`,
          files: loaded.files,
          parameters: { resolver: resolverName, input: "default" },
          package: packageInfo,
        });
      },
      expected: {
        success: Object.keys(diagnostics).length === 0,
        tokens: expected.tokens,
        diagnostics,
        outputFiles: 0,
      },
      createRun: () => {
        const loaded = load();
        return async () => ({
          snapshot: await compileDocuments(loaded.inputs, {
            resolver: loaded.document,
            resolverInput: defaultResolverInput(loaded.document),
            resolverDiagnostics: loaded.parsed.diagnostics,
          }),
        });
      },
    });
  });
}

export const BENCHMARK_CASES: readonly BenchmarkCaseDefinition[] = [
  ...syntheticCases,
  ...dtcgCases(),
  ...changeIntelligenceBenchmarkCases(fixtureDescriptor),
];

export function benchmarkCase(id: string): BenchmarkCaseDefinition | undefined {
  return BENCHMARK_CASES.find((definition) => definition.id === id);
}
