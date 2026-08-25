import {
  backendNameCollisionDiagnostics,
  contextKey,
  defaultContext,
  parseContextKey,
  selectTokenCandidate,
  type BackendOutputName,
  type Compilation,
  type CompilationContext,
  type Diagnostic,
  type TokenBackend,
  type TokenExpression,
  type TokenId,
  type TokenNode,
} from "@tokenc/core";

import { serializeCssTokenValue } from "./value.js";

export { cssValue, serializeCssTokenValue } from "./value.js";
export type { CssSerializationResult, CssValueSerialization } from "./value.js";

export interface CssBackendOptions {
  readonly output?: string;
  readonly selector?: string;
  readonly selectors?: Readonly<Record<string, string>>;
  readonly references?: "preserve" | "resolve";
  readonly name?: (token: TokenNode) => string;
}

interface ConfiguredContext {
  readonly context: CompilationContext;
  readonly selector: string;
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
  compilation: Compilation,
  selectors: Readonly<Record<string, string>> = {},
): { readonly entries: readonly ConfiguredContext[]; readonly diagnostics: readonly Diagnostic[] } {
  const defaults = defaultContext(compilation.contexts);
  const entries: ConfiguredContext[] = [];
  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();
  const selectorOwners = new Map<string, string>();
  for (const [key, selector] of Object.entries(selectors)) {
    const partial = parseConfiguredContext(key);
    if (!partial) {
      diagnostics.push({
        code: "BACKEND_INVALID_CONTEXT_SELECTOR",
        severity: "error",
        message: `Backend \`css\` context key \`${key}\` must contain unique \`name=value\` clauses`,
      });
      continue;
    }
    if (!selector.trim()) {
      diagnostics.push({
        code: "BACKEND_INVALID_CONTEXT_SELECTOR",
        severity: "error",
        message: `Backend \`css\` selector for context key \`${key}\` must not be empty`,
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
          message: `Backend \`css\` context key \`${key}\` uses unknown dimension \`${name}\``,
        });
        valid = false;
      } else if (!dimension.values.includes(value)) {
        diagnostics.push({
          code: "BACKEND_INVALID_CONTEXT_SELECTOR",
          severity: "error",
          message: `Backend \`css\` context key \`${key}\` uses unknown value \`${value}\` for \`${name}\``,
          suggestions: dimension.values,
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
        message: `Backend \`css\` configures context \`${normalized}\` more than once`,
      });
      continue;
    }
    const normalizedSelector = selector.trim();
    const previousKey = selectorOwners.get(normalizedSelector);
    if (previousKey !== undefined) {
      diagnostics.push({
        code: "BACKEND_INVALID_CONTEXT_SELECTOR",
        severity: "error",
        message: `Backend \`css\` maps context keys \`${previousKey}\` and \`${key}\` to the same selector \`${normalizedSelector}\``,
      });
      continue;
    }
    seen.add(normalized);
    selectorOwners.set(normalizedSelector, key);
    entries.push({ context, selector });
  }
  return { entries, diagnostics };
}

function hasExplicitContexts(selectors: CssBackendOptions["selectors"]): boolean {
  return Object.keys(selectors ?? {}).length > 0;
}

function validationContexts(
  compilation: Compilation,
  configured: readonly ConfiguredContext[],
  explicit: boolean,
): readonly CompilationContext[] {
  const defaults = defaultContext(compilation.contexts);
  const contexts = explicit
    ? [defaults, ...configured.map((entry) => entry.context)]
    : compilation.availableContexts;
  return [...new Map(contexts.map((context) => [contextKey(context), context])).values()];
}

/** Default canonical ID to custom-property naming policy. */
export function defaultCssName(token: TokenNode): string {
  return `--${String(token.id)
    .replace(/[^a-zA-Z0-9_-]+/gu, "-")
    .replace(/_/gu, "-")
    .toLowerCase()}`;
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

function matches(selector: CompilationContext, context: CompilationContext): boolean {
  return Object.entries(selector).every(([name, value]) => context[name] === value);
}

function contextCoverageDiagnostics(compilation: Compilation): readonly Diagnostic[] {
  const predicates = new Map<
    string,
    {
      readonly selector: CompilationContext;
      readonly token: TokenNode;
      readonly source: TokenNode["source"];
    }
  >();
  for (const token of compilation.graph.tokens) {
    for (const override of token.overrides) {
      const key = contextKey(override.selector);
      if (!predicates.has(key))
        predicates.set(key, { selector: override.selector, token, source: override.source });
    }
  }
  const diagnostics: Diagnostic[] = [];
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
      message: `Backend \`css\` cannot safely emit automatic selectors for context predicate \`${predicateKey}\`: it omits varying dimension${missing.length === 1 ? "" : "s"} ${missing.map((dimension) => `\`${dimension.name}\``).join(", ")} and covers ${covered} of ${expected} combinations`,
      source: predicate.source,
      suggestions: [
        "Configure `css({ selectors: { ... } })` with every complete context that should be emitted.",
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
    for (const token of compilation.graph.tokens) {
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
        message: `Backend \`css\` cannot safely use default-context override \`${predicateKey}\` as a global base while only ${compilation.availableContexts.length} of ${totalContexts} contexts are declared`,
        source: selected.source,
        suggestions: [
          "Configure `css({ selectors: { ... } })` with every complete context that should be emitted.",
        ],
      });
    }
  }
  return diagnostics;
}

function renderExpression(
  compilation: Compilation,
  id: TokenId,
  context: CompilationContext,
  strategy: "preserve" | "resolve",
  naming: (token: TokenNode) => string,
): Readonly<Record<string, string>> | undefined {
  const resolved = compilation.resolveToken(id, context);
  if (!resolved) return undefined;
  const serialized = serializeCssTokenValue(resolved.type, resolved.value);
  if (!serialized.ok) return undefined;
  const expression: TokenExpression = resolved.expression;
  if (strategy === "preserve" && expression.kind === "reference") {
    const target = compilation.getToken(expression.target);
    if (!target) return undefined;
    return Object.fromEntries(
      Object.keys(serialized.serialization.values).map((suffix) => [
        suffix,
        `var(${qualifiedName(naming(target), suffix)})`,
      ]),
    );
  }
  return serialized.serialization.values;
}

function qualifiedName(name: string, suffix: string): string {
  return suffix === "." ? name : `${name}-${suffix}`;
}

function isCssCustomPropertyName(name: string): boolean {
  return /^--[-_a-zA-Z0-9\u0080-\u{10ffff}]+$/u.test(name);
}

function validateCss(
  compilation: Compilation,
  naming: (token: TokenNode) => string,
  selectors: Readonly<Record<string, string>> | undefined,
  selector: string | undefined,
): readonly Diagnostic[] {
  const explicit = hasExplicitContexts(selectors);
  const configured = configuredContexts(compilation, selectors);
  const defaults = defaultContext(compilation.contexts);
  const hasConfiguredDefault = configured.entries.some((entry) =>
    sameContext(entry.context, defaults),
  );
  const hasConfiguredNonDefault = configured.entries.some(
    (entry) => !sameContext(entry.context, defaults),
  );
  const effectiveBaseSelector = (
    configured.entries.find((entry) => sameContext(entry.context, defaults))?.selector ??
    selector ??
    ":root"
  ).trim();
  const baseSelectorAlias = hasConfiguredDefault
    ? undefined
    : configured.entries.find(
        (entry) =>
          !sameContext(entry.context, defaults) && entry.selector.trim() === effectiveBaseSelector,
      );
  const diagnostics: Diagnostic[] = [
    ...configured.diagnostics,
    ...(explicit ? [] : contextCoverageDiagnostics(compilation)),
    ...(selector !== undefined && !selector.trim()
      ? [
          {
            code: "BACKEND_INVALID_CONTEXT_SELECTOR",
            severity: "error" as const,
            message: "Backend `css` base selector must not be empty",
          },
        ]
      : []),
    ...(!explicit &&
    selector !== undefined &&
    selector.trim() !== ":root" &&
    compilation.availableContexts.some(
      (context) => !sameContext(context, defaultContext(compilation.contexts)),
    )
      ? [
          {
            code: "BACKEND_CONTEXT_COVERAGE",
            severity: "error" as const,
            message:
              "Backend `css` cannot prove automatic context selectors override a custom base selector",
            suggestions: [
              "Configure an explicit `selectors` entry for every context, including the default context.",
            ],
          },
        ]
      : []),
    ...(explicit &&
    selector !== undefined &&
    selector.trim() !== ":root" &&
    hasConfiguredNonDefault &&
    !hasConfiguredDefault
      ? [
          {
            code: "BACKEND_CONTEXT_COVERAGE",
            severity: "error" as const,
            message:
              "Backend `css` requires an explicit default-context selector when a custom base selector is combined with non-default contexts",
            suggestions: [
              "Move the custom base selector into the `selectors` entry for the complete default context.",
            ],
          },
        ]
      : []),
    ...(baseSelectorAlias
      ? [
          {
            code: "BACKEND_INVALID_CONTEXT_SELECTOR",
            severity: "error" as const,
            message: `Backend \`css\` context selector \`${baseSelectorAlias.selector.trim()}\` duplicates the effective base selector`,
          },
        ]
      : []),
  ];
  const names: BackendOutputName[] = [];
  const seenUnsupported = new Set<TokenId>();
  const seenNames = new Set<string>();
  const seenInvalidNames = new Set<string>();
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
          message: `Backend \`css\` cannot losslessly serialize \`${token.id}\`: ${serialized.unsupported.reason}`,
          source: selected.source,
          suggestions: [
            "Use a supported value shape or a backend with an explicit transform policy.",
          ],
        });
        continue;
      }
      for (const suffix of Object.keys(serialized.serialization.values)) {
        const name = qualifiedName(naming(source), suffix);
        if (!isCssCustomPropertyName(name)) {
          if (seenInvalidNames.has(name)) continue;
          seenInvalidNames.add(name);
          diagnostics.push({
            code: "BACKEND_INVALID_OUTPUT_NAME",
            severity: "error",
            message: `Backend \`css\` generated invalid custom-property name \`${name}\` for \`${token.id}\``,
            source: source.source,
            suggestions: [
              "Return an unescaped custom-property name beginning with `--` and containing only identifier characters.",
            ],
          });
          continue;
        }
        const key = `${token.id}\u0000${name}`;
        if (seenNames.has(key)) continue;
        seenNames.add(key);
        names.push({ name, token: source, namespace: "css-custom-property" });
      }
    }
  }
  return [...diagnostics, ...backendNameCollisionDiagnostics("css", names)];
}

function block(selector: string, declarations: readonly [string, string][]): string {
  if (declarations.length === 0) return "";
  return `${selector} {\n${declarations.map(([name, value]) => `  ${name}: ${value};`).join("\n")}\n}`;
}

/** Configure the CSS custom-properties backend. */
export function css(options: CssBackendOptions = {}): TokenBackend {
  const output = options.output ?? "dist/tokens.css";
  const naming = options.name ?? defaultCssName;
  const strategy = options.references ?? "preserve";
  return {
    name: "css",
    validate: (compilation) =>
      validateCss(compilation, naming, options.selectors, options.selector),
    emit(compilation) {
      const defaults = defaultContext(compilation.contexts);
      const explicit = hasExplicitContexts(options.selectors);
      const configured = configuredContexts(compilation, options.selectors).entries;
      const configuredDefault = configured.find((entry) => sameContext(entry.context, defaults));
      const baseSelector = configuredDefault?.selector ?? options.selector ?? ":root";
      const baseValues = new Map<string, string>();
      const baseDeclarations: [string, string][] = [];
      for (const token of compilation.tokens) {
        const rendered = renderExpression(compilation, token.id, defaults, strategy, naming);
        const source = compilation.getToken(token.id);
        if (rendered !== undefined && source) {
          for (const [suffix, value] of Object.entries(rendered)) {
            const name = qualifiedName(naming(source), suffix);
            baseValues.set(name, value);
            baseDeclarations.push([name, value]);
          }
        }
      }
      const blocks = [block(baseSelector, baseDeclarations)];
      const contexts = explicit
        ? configured.filter((entry) => entry !== configuredDefault)
        : compilation.availableContexts
            .filter((context) => !sameContext(context, defaults))
            .map((context) => ({ context, selector: automaticSelector(context) }));
      for (const entry of contexts) {
        const declarations: [string, string][] = [];
        for (const token of compilation.tokens) {
          const rendered = renderExpression(compilation, token.id, entry.context, strategy, naming);
          const source = compilation.getToken(token.id);
          if (rendered !== undefined && source) {
            for (const [suffix, value] of Object.entries(rendered)) {
              const name = qualifiedName(naming(source), suffix);
              if (value !== baseValues.get(name)) declarations.push([name, value]);
            }
          }
        }
        const renderedBlock = block(entry.selector, declarations);
        if (renderedBlock) blocks.push(renderedBlock);
      }
      return [{ path: output, content: `${blocks.filter(Boolean).join("\n\n")}\n` }];
    },
  };
}
