import {
  CONTEXT_EXTENSION,
  createCompilerSession,
  type CompilationSnapshot,
  type ContextDefinition,
  type DocumentLoader,
  type DocumentRequest,
  type LoadedDocument,
} from "@tokenc/core";

export type ExtensionSupportV1 = "tokenc-interpreted" | "preserved-unsupported";

export interface ExtensionClassificationV1 {
  readonly namespace: string;
  readonly pointer: string;
  readonly support: ExtensionSupportV1;
}

export interface ExtensionClassificationIssueV1 {
  readonly code: "invalid-json" | "invalid-extension-container";
  readonly pointer: string;
  readonly message: string;
}

export interface TerrazzoExtensionReportV1 {
  readonly schemaVersion: "1";
  readonly status: "compatible" | "unsupported" | "invalid";
  readonly extensions: readonly ExtensionClassificationV1[];
  readonly issues: readonly ExtensionClassificationIssueV1[];
}

export interface TerrazzoBundleInput {
  readonly content: string;
  readonly identity?: string;
  readonly version?: string;
}

export interface TerrazzoAdapterOptions {
  readonly contexts?: ContextDefinition;
}

export interface TerrazzoAdapterResultV1 {
  readonly schemaVersion: "1";
  readonly source: string;
  readonly loaderRequests: readonly string[];
  readonly extensions: TerrazzoExtensionReportV1;
  readonly snapshot: CompilationSnapshot;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function extensionPointer(parent: string, namespace?: string): string {
  const base = `${parent}/${pointerSegment("$extensions")}`;
  return namespace === undefined ? base : `${base}/${pointerSegment(namespace)}`;
}

/** Classify extension namespaces without interpreting or transforming their values. */
export function classifyTerrazzoBundleExtensions(content: string): TerrazzoExtensionReportV1 {
  let root: unknown;
  try {
    root = JSON.parse(content);
  } catch {
    return Object.freeze({
      schemaVersion: "1",
      status: "invalid",
      extensions: Object.freeze([]),
      issues: Object.freeze([
        Object.freeze({
          code: "invalid-json" as const,
          pointer: "",
          message: "The bundled DTCG document is not valid JSON",
        }),
      ]),
    });
  }

  const extensions: ExtensionClassificationV1[] = [];
  const issues: ExtensionClassificationIssueV1[] = [];
  const visit = (value: unknown, pointer: string): void => {
    if (Array.isArray(value)) {
      for (const [index, child] of value.entries()) visit(child, `${pointer}/${index}`);
      return;
    }
    if (!isRecord(value)) return;
    if (Object.hasOwn(value, "$extensions")) {
      const container = value.$extensions;
      if (!isRecord(container))
        issues.push(
          Object.freeze({
            code: "invalid-extension-container",
            pointer: extensionPointer(pointer),
            message: "DTCG `$extensions` must be an object",
          }),
        );
      else
        for (const namespace of Object.keys(container).toSorted())
          extensions.push(
            Object.freeze({
              namespace,
              pointer: extensionPointer(pointer, namespace),
              support:
                namespace === CONTEXT_EXTENSION ? "tokenc-interpreted" : "preserved-unsupported",
            }),
          );
    }
    for (const [key, child] of Object.entries(value).toSorted(([left], [right]) =>
      left.localeCompare(right),
    )) {
      if (key !== "$extensions") visit(child, `${pointer}/${pointerSegment(key)}`);
    }
  };
  visit(root, "");

  return Object.freeze({
    schemaVersion: "1",
    status:
      issues.length > 0
        ? "invalid"
        : extensions.some((entry) => entry.support === "preserved-unsupported")
          ? "unsupported"
          : "compatible",
    extensions: Object.freeze(extensions),
    issues: Object.freeze(issues),
  });
}

/** Single-document in-memory Loader: hosts own acquisition; Core receives no network capability. */
export class BundledDtcgDocumentLoader implements DocumentLoader {
  readonly #document: LoadedDocument;
  readonly #requests: string[] = [];

  constructor(input: TerrazzoBundleInput) {
    this.#document = Object.freeze({
      identity: input.identity ?? "/virtual/terrazzo/bundled.tokens.json",
      content: input.content,
      ...(input.version === undefined ? {} : { version: input.version }),
    });
  }

  get requests(): readonly string[] {
    return Object.freeze([...this.#requests]);
  }

  async load(request: DocumentRequest, signal?: AbortSignal): Promise<LoadedDocument> {
    signal?.throwIfAborted();
    this.#requests.push(request.specifier);
    if (request.from !== undefined || request.specifier !== this.#document.identity)
      throw new Error(`Bundle adapter cannot load external document: ${request.specifier}`);
    return this.#document;
  }
}

/** Compile one already-bundled DTCG document through only public Loader and Session APIs. */
export async function compileTerrazzoBundle(
  input: TerrazzoBundleInput,
  options: TerrazzoAdapterOptions = {},
): Promise<TerrazzoAdapterResultV1> {
  const loader = new BundledDtcgDocumentLoader(input);
  const source = input.identity ?? "/virtual/terrazzo/bundled.tokens.json";
  const session = createCompilerSession({
    loader,
    config: options.contexts ? { contexts: options.contexts } : {},
  });
  try {
    const snapshot = await session.apply({
      documents: [{ kind: "add", request: { specifier: source } }],
    });
    return Object.freeze({
      schemaVersion: "1",
      source,
      loaderRequests: loader.requests,
      extensions: classifyTerrazzoBundleExtensions(input.content),
      snapshot,
    });
  } finally {
    await session.close();
  }
}
