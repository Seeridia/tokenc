import {
  ALL_TOKEN_TYPES,
  BackendContractError,
  DiagnosticBag,
  isColorValue,
  isUnitValue,
  SymbolAllocator,
  tokenIdSegments,
  type AllocatedSymbol,
  type BackendPlan,
  type ColorComponent,
  type ColorValue,
  type CompilationIR,
  type Diagnostic,
  type TokenBackend,
  type TokenId,
  type TokenLiteral,
} from "@tokenc/core";

const RESERVED_BINDINGS: ReadonlySet<string> = new Set([
  "arguments",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "eval",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

export interface TypeScriptBackendOptions {
  readonly output?: string;
  readonly mode?: "flat" | "object";
  readonly references?: "symbol" | "resolve";
  readonly rename?: Readonly<Record<string, string>>;
}

function upperFirst(value: string): string {
  return value ? `${value[0]?.toUpperCase()}${value.slice(1)}` : value;
}

function byte(value: number): string | undefined {
  const scaled = value * 255;
  return Number.isInteger(scaled) ? scaled.toString(16).padStart(2, "0") : undefined;
}

function component(value: ColorComponent): string {
  return value === "none" ? value : String(value);
}

function percentage(value: ColorComponent): string {
  return value === "none" ? value : `${value}%`;
}

function colorComponents(value: ColorValue): string {
  const [first, second, third] = value.components;
  if (value.colorSpace === "hsl" || value.colorSpace === "hwb")
    return [component(first), percentage(second), percentage(third)].join(" ");
  if (value.colorSpace === "lab" || value.colorSpace === "lch")
    return [percentage(first), component(second), component(third)].join(" ");
  return value.components.map(component).join(" ");
}

/** Convert a canonical token ID to a safe camelCase binding name. */
export function tokenIdentifier(id: TokenId): string {
  const parts = String(id)
    .split(/[^a-zA-Z0-9]+/u)
    .filter(Boolean);
  const name = parts
    .map((part, index) => (index === 0 ? part : upperFirst(part)))
    .join("")
    .replace(/^[^a-zA-Z_$]/u, "token$&");
  const identifier = name || "token";
  return RESERVED_BINDINGS.has(identifier) ? `token${upperFirst(identifier)}` : identifier;
}

function colorString(value: ColorValue): string {
  const components = colorComponents(value);
  const alpha = value.alpha < 1 ? ` / ${value.alpha}` : "";
  if (["hsl", "hwb", "lab", "lch", "oklab", "oklch"].includes(value.colorSpace))
    return `${value.colorSpace}(${components}${alpha})`;
  if (value.colorSpace === "srgb" && value.components.every((entry) => typeof entry === "number")) {
    const bytes = value.components.map(byte);
    const alphaByte = value.alpha < 1 ? byte(value.alpha) : "";
    if (bytes.every((entry) => entry !== undefined) && alphaByte !== undefined)
      return `#${bytes.join("")}${alphaByte}`;
  }
  return `color(${value.colorSpace} ${components}${alpha})`;
}

function jsLiteral(value: TokenLiteral): string {
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (isColorValue(value)) return JSON.stringify(colorString(value));
  if (isUnitValue(value)) return JSON.stringify(`${value.value}${value.unit}`);
  return JSON.stringify(value, null, 2);
}

function tokenExpression(
  compilation: CompilationIR,
  id: TokenId,
  strategy: "symbol" | "resolve",
  symbols: ReadonlyMap<TokenId, string>,
): string {
  const resolved = compilation.resolveToken(id);
  if (!resolved) return "undefined";
  if (strategy === "symbol" && resolved.expression.kind === "reference")
    return symbols.get(resolved.expression.target) ?? "undefined";
  return jsLiteral(resolved.value);
}

interface TreeNode {
  value?: string;
  readonly children: Map<string, TreeNode>;
}

interface ValidationTreeNode {
  token?: NonNullable<ReturnType<CompilationIR["getToken"]>>;
  firstDescendant?: NonNullable<ReturnType<CompilationIR["getToken"]>>;
  readonly children: Map<string, ValidationTreeNode>;
}

function objectLiteral(root: TreeNode, depth = 0): string {
  const indent = "  ".repeat(depth);
  const childIndent = "  ".repeat(depth + 1);
  const entries = [...root.children.entries()].map(
    ([key, child]) =>
      `${childIndent}${JSON.stringify(key)}: ${child.value ?? objectLiteral(child, depth + 1)}`,
  );
  return `{\n${entries.join(",\n")}\n${indent}}`;
}

function objectPathDiagnostics(compilation: CompilationIR): readonly Diagnostic[] {
  const root: ValidationTreeNode = { children: new Map() };
  const diagnostics = new DiagnosticBag();
  const report = (
    valueToken: NonNullable<ReturnType<CompilationIR["getToken"]>>,
    descendant: NonNullable<ReturnType<CompilationIR["getToken"]>>,
  ): void => {
    diagnostics.push({
      code: "BACKEND_SYMBOL_COLLISION",
      severity: "error",
      message: `Backend \`typescript\` object mode cannot represent both \`${valueToken.id}\` and \`${descendant.id}\`: \`${valueToken.id}\` would be both a value and an object namespace`,
      source: descendant.source,
      anchor: { kind: "token", token: descendant.id },
      parameters: {
        backend: "typescript",
        namespace: "typescript-object-path",
        name: String(valueToken.id),
        firstToken: valueToken.id,
        secondToken: descendant.id,
      },
      related: [
        { message: `Value token \`${valueToken.id}\` is defined here`, source: valueToken.source },
      ],
    });
  };

  for (const token of compilation.tokens) {
    const source = compilation.getToken(token.id);
    if (!source) continue;
    let current = root;
    for (const segment of tokenIdSegments(token.id)) {
      if (current.token) report(current.token, source);
      current.firstDescendant ??= source;
      const child = current.children.get(segment) ?? { children: new Map() };
      current.children.set(segment, child);
      current = child;
    }
    if (current.firstDescendant) report(source, current.firstDescendant);
    current.token = source;
  }
  return diagnostics;
}

const TYPESCRIPT_NAMESPACE = {
  name: "typescript-binding",
  caseSensitive: true,
  normalize: "NFKC",
  reserved: RESERVED_BINDINGS,
  pattern: /^[A-Za-z_$][A-Za-z0-9_$]*$/u,
} as const;

interface TypeScriptValidation {
  readonly diagnostics: readonly Diagnostic[];
  readonly symbols: readonly AllocatedSymbol[];
}

function validateTypeScript(
  compilation: CompilationIR,
  mode: "flat" | "object",
  strategy: "symbol" | "resolve",
  rename: Readonly<Record<string, string>> | undefined,
): TypeScriptValidation {
  const pathDiagnostics = mode === "object" ? objectPathDiagnostics(compilation) : [];
  const requests = compilation.tokens.flatMap((token) => {
    const source = compilation.getToken(token.id);
    if (!source || (mode === "object" && strategy === "resolve")) return [];
    const identifier = tokenIdentifier(token.id);
    return [
      {
        token: source,
        id: token.id,
        name: mode === "object" ? `_${identifier}` : identifier,
        namespace: TYPESCRIPT_NAMESPACE,
      },
    ];
  });
  const allocation = new SymbolAllocator().allocate({
    backendId: "typescript",
    requests,
    ...(rename ? { renameMap: rename } : {}),
  });
  return {
    diagnostics: [...pathDiagnostics, ...allocation.diagnostics],
    symbols: allocation.symbols,
  };
}

/** Configure a TypeScript constants backend. */
export function typescript(options: TypeScriptBackendOptions = {}): TokenBackend {
  const output = options.output ?? "dist/tokens.ts";
  const mode = options.mode ?? "object";
  const strategy = options.references ?? (mode === "flat" ? "symbol" : "resolve");
  return {
    id: "typescript",
    capabilities: {
      tokenTypes: ALL_TOKEN_TYPES,
      referenceStrategies: new Set(["symbol", "resolve"]),
      contextMode: "none",
      colorSpaces: "preserve",
      composite: "native",
    },
    prepare(compilation) {
      const validation = validateTypeScript(compilation, mode, strategy, options.rename);
      const symbols = new Map(validation.symbols.map((symbol) => [symbol.token, symbol.name]));
      let content: string;
      if (mode === "flat") {
        const declarations = compilation.tokens.map(
          (token) =>
            `export const ${symbols.get(token.id) ?? tokenIdentifier(token.id)} = ${tokenExpression(compilation, token.id, strategy, symbols)};`,
        );
        content = `${declarations.join("\n")}\n`;
      } else {
        const internals =
          strategy === "symbol"
            ? compilation.tokens
                .map(
                  (token) =>
                    `const ${symbols.get(token.id) ?? `_${tokenIdentifier(token.id)}`} = ${tokenExpression(compilation, token.id, strategy, symbols)};`,
                )
                .join("\n")
            : "";
        const root: TreeNode = { children: new Map() };
        for (const token of compilation.tokens) {
          let current = root;
          const segments = tokenIdSegments(token.id);
          for (const [index, segment] of segments.entries()) {
            const child = current.children.get(segment) ?? {
              children: new Map<string, TreeNode>(),
            };
            current.children.set(segment, child);
            current = child;
            if (index === segments.length - 1)
              current.value =
                strategy === "symbol"
                  ? (symbols.get(token.id) ?? `_${tokenIdentifier(token.id)}`)
                  : tokenExpression(compilation, token.id, "resolve", symbols);
          }
        }
        content = `${internals ? `${internals}\n\n` : ""}export const tokens = ${objectLiteral(root)} as const;\n`;
      }
      return {
        backendId: "typescript",
        diagnostics: validation.diagnostics,
        symbols: validation.symbols,
        artifacts: [
          {
            id: "typescript",
            path: output,
            mediaType: "text/typescript",
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
            `artifact \`${artifact.id}\` has no TypeScript payload`,
          );
        return { id: artifact.id, path: artifact.path, content: artifact.payload };
      });
    },
  };
}
