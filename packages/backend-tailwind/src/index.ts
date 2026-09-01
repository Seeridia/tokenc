import { serializeCssTokenValue, type CssValueSerialization } from "@tokenc/backend-css";
import {
  ALL_TOKEN_TYPES,
  BackendContractError,
  contextKey,
  defaultContext,
  DiagnosticBag,
  parseContextKey,
  selectTokenCandidate,
  SymbolAllocator,
  type AllocatedSymbol,
  type BackendPlan,
  type CompilationIR,
  type CompilationContext,
  type Diagnostic,
  type SymbolRequest,
  type TokenBackend,
  type TokenId,
  type TokenNode,
} from "@tokenc/core";

export interface TailwindBackendOptions {
  readonly output?: string;
  readonly references?: "preserve" | "resolve";
  readonly selectors?: Readonly<Record<string, string>>;
  readonly rename?: Readonly<Record<string, string>>;
}

interface ConfiguredContext {
  readonly context: CompilationContext;
  readonly selector: string;
}

function canonicalName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/gu, "-").toLowerCase();
}

function runtimeName(id: TokenId, suffix = "."): string {
  const name = `--token-${canonicalName(String(id))}`;
  return suffix === "." ? name : `${name}-${suffix}`;
}

function themeName(token: TokenNode): string | undefined {
  const segments = String(token.id).split(".");
  const relativeName = (namespace: string): string => {
    const relative = segments[0] === namespace ? segments.slice(1) : segments;
    return canonicalName(relative.length > 0 ? relative.join("-") : "default");
  };
  if (token.type === "color") return `--color-${relativeName("color")}`;
  if (token.type === "dimension") {
    if (segments[0] === "radius" || segments.includes("radius"))
      return `--radius-${relativeName("radius")}`;
    return `--spacing-${relativeName("spacing")}`;
  }
  if (token.type === "fontWeight") return `--font-weight-${relativeName("fontWeight")}`;
  if (token.type === "shadow") return `--shadow-${relativeName("shadow")}`;
  return undefined;
}

function parseConfiguredContext(key: string): CompilationContext | undefined {
  if (!key.trim()) return {};
  try {
    return parseContextKey(key);
  } catch {
    return undefined;
  }
}

function configuredContexts(
  compilation: CompilationIR,
  selectors: Readonly<Record<string, string>> = {},
): { readonly entries: readonly ConfiguredContext[]; readonly diagnostics: readonly Diagnostic[] } {
  const defaults = defaultContext(compilation.contexts);
  const entries: ConfiguredContext[] = [];
  const diagnostics = new DiagnosticBag();
  const seen = new Set<string>();
  const selectorOwners = new Map<string, string>();
  for (const [key, selector] of Object.entries(selectors)) {
    const partial = parseConfiguredContext(key);
    if (!partial) {
      diagnostics.push({
        code: "BACKEND_INVALID_CONTEXT_SELECTOR",
        severity: "error",
        message: `Backend \`tailwind\` context key \`${key}\` must contain unique \`name=value\` clauses`,
      });
      continue;
    }
    if (!selector.trim()) {
      diagnostics.push({
        code: "BACKEND_INVALID_CONTEXT_SELECTOR",
        severity: "error",
        message: `Backend \`tailwind\` selector for context key \`${key}\` must not be empty`,
      });
      continue;
    }
    let valid = true;
    for (const [name, value] of Object.entries(partial)) {
      const dimension = Object.hasOwn(compilation.contexts, name)
        ? compilation.contexts[name]
        : undefined;
      if (!dimension) {
        diagnostics.push({
          code: "BACKEND_INVALID_CONTEXT_SELECTOR",
          severity: "error",
          message: `Backend \`tailwind\` context key \`${key}\` uses unknown dimension \`${name}\``,
        });
        valid = false;
      } else if (!dimension.values.includes(value)) {
        diagnostics.push({
          code: "BACKEND_INVALID_CONTEXT_SELECTOR",
          severity: "error",
          message: `Backend \`tailwind\` context key \`${key}\` uses unknown value \`${value}\` for \`${name}\``,
          related: dimension.values.map((candidate) => ({
            message: `Valid value: \`${candidate}\``,
          })),
        });
        valid = false;
      }
    }
    if (!valid) continue;
    const context = { ...defaults, ...partial };
    const normalized = contextKey(context);
    if (seen.has(normalized)) {
      diagnostics.push({
        code: "BACKEND_INVALID_CONTEXT_SELECTOR",
        severity: "error",
        message: `Backend \`tailwind\` configures context \`${normalized}\` more than once`,
      });
      continue;
    }
    const normalizedSelector = selector.trim();
    const previousKey = selectorOwners.get(normalizedSelector);
    if (previousKey !== undefined) {
      diagnostics.push({
        code: "BACKEND_INVALID_CONTEXT_SELECTOR",
        severity: "error",
        message: `Backend \`tailwind\` maps context keys \`${previousKey}\` and \`${key}\` to the same selector \`${normalizedSelector}\``,
      });
      continue;
    }
    seen.add(normalized);
    selectorOwners.set(normalizedSelector, key);
    entries.push({ context, selector });
  }
  return { entries, diagnostics };
}

function hasExplicitContexts(selectors: TailwindBackendOptions["selectors"]): boolean {
  return Object.keys(selectors ?? {}).length > 0;
}

function sameContext(left: CompilationContext, right: CompilationContext): boolean {
  return contextKey(left) === contextKey(right);
}

function cssString(value: string): string {
  let escaped = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (character === "\\") escaped += "\\\\";
    else if (character === '"') escaped += '\\"';
    else if (codePoint <= 0x1f || codePoint === 0x7f) escaped += `\\${codePoint.toString(16)} `;
    else escaped += character;
  }
  return escaped;
}

function automaticSelector(context: CompilationContext): string {
  return `[data-context="${cssString(contextKey(context))}"]`;
}

function validationContexts(
  compilation: CompilationIR,
  configured: readonly ConfiguredContext[],
  explicit: boolean,
): readonly CompilationContext[] {
  const defaults = defaultContext(compilation.contexts);
  const contexts = explicit
    ? [defaults, ...configured.map((entry) => entry.context)]
    : compilation.availableContexts;
  return [...new Map(contexts.map((context) => [contextKey(context), context])).values()];
}

function matches(selector: CompilationContext, context: CompilationContext): boolean {
  return Object.entries(selector).every(([name, value]) => context[name] === value);
}

function contextCoverageDiagnostics(compilation: CompilationIR): readonly Diagnostic[] {
  const predicates = new Map<
    string,
    {
      readonly selector: CompilationContext;
      readonly token: TokenNode;
      readonly source: TokenNode["source"];
    }
  >();
  for (const token of compilation.sourceTokens) {
    for (const override of token.overrides) {
      const key = contextKey(override.selector);
      if (!predicates.has(key))
        predicates.set(key, { selector: override.selector, token, source: override.source });
    }
  }
  const diagnostics = new DiagnosticBag();
  const varyingDimensions = Object.entries(compilation.contexts).flatMap(([name, dimension]) => {
    const values = [...new Set([dimension.default, ...dimension.values])];
    return values.length > 1 ? [{ name, values }] : [];
  });
  const reported = new Set<string>();
  for (const predicate of predicates.values()) {
    const predicateKey = contextKey(predicate.selector);
    if (!varyingDimensions.some((dimension) => Object.hasOwn(predicate.selector, dimension.name)))
      continue;
    const missing = varyingDimensions.filter(
      (dimension) => !Object.hasOwn(predicate.selector, dimension.name),
    );
    if (missing.length === 0) continue;
    const expected = missing.reduce((count, dimension) => count * dimension.values.length, 1);
    const covered = new Set(
      compilation.availableContexts
        .filter((context) => matches(predicate.selector, context))
        .map((context) =>
          contextKey(
            Object.fromEntries(
              missing.map((dimension) => [dimension.name, context[dimension.name] ?? ""]),
            ),
          ),
        ),
    ).size;
    if (covered >= expected) continue;
    reported.add(predicateKey);
    diagnostics.push({
      code: "BACKEND_CONTEXT_COVERAGE",
      severity: "error",
      message: `Backend \`tailwind\` cannot safely emit automatic selectors for context predicate \`${predicateKey}\`: it omits varying dimension${missing.length === 1 ? "" : "s"} ${missing.map((dimension) => `\`${dimension.name}\``).join(", ")} and covers ${covered} of ${expected} combinations`,
      source: predicate.source,
      related: [
        {
          message:
            "Configure `tailwind({ selectors: { ... } })` with every complete context that should be emitted.",
        },
      ],
    });
  }
  const totalContexts = varyingDimensions.reduce(
    (count, dimension) => Math.min(Number.MAX_SAFE_INTEGER, count * dimension.values.length),
    1,
  );
  if (compilation.availableContexts.length < totalContexts) {
    const defaults = defaultContext(compilation.contexts);
    const resolutionOrder = Object.keys(compilation.contexts);
    for (const token of compilation.sourceTokens) {
      const selected = selectTokenCandidate(token, defaults, resolutionOrder);
      if (
        !selected.selector ||
        !varyingDimensions.some((dimension) =>
          Object.hasOwn(selected.selector ?? {}, dimension.name),
        )
      )
        continue;
      const predicateKey = contextKey(selected.selector);
      if (reported.has(predicateKey)) continue;
      reported.add(predicateKey);
      diagnostics.push({
        code: "BACKEND_CONTEXT_COVERAGE",
        severity: "error",
        message: `Backend \`tailwind\` cannot safely use default-context override \`${predicateKey}\` as a global base while only ${compilation.availableContexts.length} of ${totalContexts} contexts are declared`,
        source: selected.source,
        related: [
          {
            message:
              "Configure `tailwind({ selectors: { ... } })` with every complete context that should be emitted.",
          },
        ],
      });
    }
  }
  return diagnostics;
}

function render(
  compilation: CompilationIR,
  id: TokenId,
  context: CompilationContext,
  strategy: "preserve" | "resolve",
  runtimeSymbol: (id: TokenId, suffix: string) => string | undefined,
): CssValueSerialization | undefined {
  const resolved = compilation.resolveToken(id, context);
  if (!resolved) return undefined;
  const serialized = serializeCssTokenValue(resolved.type, resolved.value);
  if (!serialized.ok) return undefined;
  if (strategy === "preserve" && resolved.expression.kind === "reference") {
    const values: Record<string, string> = {};
    for (const suffix of Object.keys(serialized.serialization.values)) {
      const target = runtimeSymbol(resolved.expression.target, suffix);
      if (!target) return undefined;
      values[suffix] = `var(${target})`;
    }
    return { values };
  }
  return serialized.serialization;
}

const CSS_NAMESPACE = {
  name: "css-custom-property",
  caseSensitive: true,
  normalize: "NFC",
  reserved: new Set<string>(),
  pattern: /^--[-_a-zA-Z0-9\u0080-\u{10ffff}]+$/u,
} as const;

function runtimeSymbolId(id: TokenId, suffix: string): string {
  return suffix === "." ? `runtime:${id}` : `runtime:${id}.${suffix}`;
}

function themeSymbolId(id: TokenId): string {
  return `theme:${id}`;
}

interface TailwindValidation {
  readonly diagnostics: readonly Diagnostic[];
  readonly symbols: readonly AllocatedSymbol[];
}

function validateTailwind(
  compilation: CompilationIR,
  selectors: TailwindBackendOptions["selectors"],
  rename: Readonly<Record<string, string>> | undefined,
): TailwindValidation {
  const explicit = hasExplicitContexts(selectors);
  const configured = configuredContexts(compilation, selectors);
  const defaults = defaultContext(compilation.contexts);
  const hasConfiguredDefault = configured.entries.some((entry) =>
    sameContext(entry.context, defaults),
  );
  const baseSelectorAlias = hasConfiguredDefault
    ? undefined
    : configured.entries.find(
        (entry) => !sameContext(entry.context, defaults) && entry.selector.trim() === ":root",
      );
  const diagnostics = new DiagnosticBag();
  diagnostics.push(
    ...configured.diagnostics,
    ...(explicit ? [] : contextCoverageDiagnostics(compilation)),
    ...(baseSelectorAlias
      ? [
          {
            code: "BACKEND_INVALID_CONTEXT_SELECTOR",
            severity: "error" as const,
            message: `Backend \`tailwind\` context selector \`${baseSelectorAlias.selector.trim()}\` duplicates the effective base selector`,
          },
        ]
      : []),
  );
  const requests: SymbolRequest[] = [];
  const seenUnsupported = new Set<TokenId>();
  const seenNames = new Set<string>();
  for (const context of validationContexts(compilation, configured.entries, explicit)) {
    for (const token of compilation.tokens) {
      const source = compilation.getToken(token.id);
      const resolved = compilation.resolveToken(token.id, context);
      if (!source || !resolved) continue;
      const serialized = serializeCssTokenValue(resolved.type, resolved.value);
      if (!serialized.ok) {
        if (seenUnsupported.has(token.id)) continue;
        seenUnsupported.add(token.id);
        const selected = selectTokenCandidate(source, context, Object.keys(compilation.contexts));
        diagnostics.push({
          code: "BACKEND_UNSUPPORTED_VALUE",
          severity: "error",
          message: `Backend \`tailwind\` cannot losslessly serialize \`${token.id}\`: ${serialized.unsupported.reason}`,
          source: selected.source,
          related: [{ message: "Use a supported value shape or an explicit transform policy." }],
        });
        continue;
      }
      for (const suffix of Object.keys(serialized.serialization.values)) {
        const name = runtimeName(token.id, suffix);
        const key = `${token.id}\u0000${suffix}`;
        if (seenNames.has(key)) continue;
        seenNames.add(key);
        const id = runtimeSymbolId(token.id, suffix);
        requests.push({ id, token: source, namespace: CSS_NAMESPACE, name, renameKey: id });
      }
    }
  }
  for (const token of compilation.tokens) {
    const source = compilation.getToken(token.id);
    const name = source ? themeName(source) : undefined;
    if (source && name) {
      const id = themeSymbolId(token.id);
      requests.push({ id, token: source, namespace: CSS_NAMESPACE, name, renameKey: id });
    }
  }
  const allocation = new SymbolAllocator().allocate({
    backendId: "tailwind",
    requests,
    ...(rename ? { renameMap: rename } : {}),
  });
  return {
    diagnostics: [...diagnostics, ...allocation.diagnostics],
    symbols: allocation.symbols,
  };
}

function cssBlock(selector: string, declarations: readonly string[]): string {
  return declarations.length
    ? `${selector} {\n${declarations.map((line) => `  ${line}`).join("\n")}\n}`
    : "";
}

/** Configure the Tailwind v4 CSS-first backend. */
export function tailwind(options: TailwindBackendOptions = {}): TokenBackend {
  const output = options.output ?? "dist/tailwind.css";
  const strategy = options.references ?? "preserve";
  return {
    id: "tailwind",
    capabilities: {
      tokenTypes: ALL_TOKEN_TYPES,
      referenceStrategies: new Set(["preserve", "resolve"]),
      contextMode: "finite-selectors",
      colorSpaces: "preserve",
      composite: "serialized-subset",
    },
    prepare(compilation) {
      const validation = validateTailwind(compilation, options.selectors, options.rename);
      const symbols = new Map(validation.symbols.map((symbol) => [symbol.id, symbol.name]));
      const runtimeSymbol = (id: TokenId, suffix = "."): string | undefined =>
        symbols.get(runtimeSymbolId(id, suffix));
      const defaults = defaultContext(compilation.contexts);
      const explicit = hasExplicitContexts(options.selectors);
      const configured = configuredContexts(compilation, options.selectors).entries;
      const configuredDefault = configured.find((entry) => sameContext(entry.context, defaults));
      const base = new Map<string, string>();
      const rootLines: string[] = [];
      for (const token of compilation.tokens) {
        const rendered = render(compilation, token.id, defaults, strategy, runtimeSymbol);
        if (rendered !== undefined) {
          for (const [suffix, value] of Object.entries(rendered.values)) {
            const name = runtimeSymbol(token.id, suffix);
            if (!name) continue;
            base.set(name, value);
            rootLines.push(`${name}: ${value};`);
          }
        }
      }
      const blocks = [cssBlock(configuredDefault?.selector ?? ":root", rootLines)];
      const contexts = explicit
        ? configured.filter((entry) => entry !== configuredDefault)
        : compilation.availableContexts
            .filter((context) => !sameContext(context, defaults))
            .map((context) => ({ context, selector: automaticSelector(context) }));
      for (const entry of contexts) {
        const lines: string[] = [];
        for (const token of compilation.tokens) {
          const rendered = render(compilation, token.id, entry.context, strategy, runtimeSymbol);
          if (rendered !== undefined) {
            for (const [suffix, value] of Object.entries(rendered.values)) {
              const name = runtimeSymbol(token.id, suffix);
              if (!name) continue;
              if (value !== base.get(name)) lines.push(`${name}: ${value};`);
            }
          }
        }
        const renderedBlock = cssBlock(entry.selector, lines);
        if (renderedBlock) blocks.push(renderedBlock);
      }
      const themeLines = compilation.tokens.flatMap((token) => {
        const name = symbols.get(themeSymbolId(token.id));
        const runtime = runtimeSymbol(token.id);
        const rendered = render(compilation, token.id, defaults, strategy, runtimeSymbol);
        return name && runtime && rendered?.values["."] ? [`${name}: var(${runtime});`] : [];
      });
      blocks.push(`@theme {\n${themeLines.map((line) => `  ${line}`).join("\n")}\n}`);
      const content = `${blocks.filter(Boolean).join("\n\n")}\n`;
      return {
        backendId: "tailwind",
        diagnostics: validation.diagnostics,
        symbols: validation.symbols,
        artifacts: [
          {
            id: "tailwind",
            path: output,
            mediaType: "text/css",
            tokenIds: compilation.tokens.map((token) => token.id),
            payload: content,
          },
        ],
        data: null,
      };
    },
    emit(plan: BackendPlan) {
      return plan.artifacts.map((artifact) => {
        if (typeof artifact.payload !== "string")
          throw new BackendContractError(
            plan.backendId,
            `artifact \`${artifact.id}\` has no Tailwind payload`,
          );
        return { id: artifact.id, path: artifact.path, content: artifact.payload };
      });
    },
  };
}
