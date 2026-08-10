/** Canonical, dot-separated token identifier. */
export type TokenId = string & { readonly __brand: "TokenId" };

export type TokenType =
  | "color"
  | "dimension"
  | "fontFamily"
  | "number"
  | "duration"
  | "fontWeight"
  | "cubicBezier"
  | "strokeStyle"
  | "border"
  | "transition"
  | "shadow"
  | "gradient"
  | "typography";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type TokenDialect = "dtcg-2025.10" | "tokenc";

export type ColorSpace =
  | "srgb"
  | "srgb-linear"
  | "display-p3"
  | "a98-rgb"
  | "prophoto-rgb"
  | "rec2020"
  | "xyz-d50"
  | "xyz-d65"
  | "lab"
  | "lch"
  | "oklab"
  | "oklch"
  | "hsl"
  | "hwb";

export type ColorComponent = number | "none";

/** Normalized DTCG 2025.10 color representation. */
export interface DTCGColor {
  readonly colorSpace: ColorSpace;
  readonly components: readonly [ColorComponent, ColorComponent, ColorComponent];
  readonly alpha: number;
  readonly hex?: string;
  readonly original?: string;
}

export type SRGBColor = DTCGColor & { readonly colorSpace: "srgb" };
export type OKLCHColor = DTCGColor & { readonly colorSpace: "oklch" };

/** A valid CSS color that the core deliberately leaves platform-neutral. */
export interface CSSColor {
  readonly colorSpace: "css";
  readonly value: string;
}

export type ColorValue = DTCGColor | CSSColor;

export interface DimensionValue {
  readonly value: number;
  readonly unit: "px" | "rem";
}

export interface DurationValue {
  readonly value: number;
  readonly unit: "ms" | "s";
}

export type FontWeightValue =
  | number
  | "thin"
  | "hairline"
  | "extra-light"
  | "ultra-light"
  | "light"
  | "normal"
  | "regular"
  | "book"
  | "medium"
  | "semi-bold"
  | "demi-bold"
  | "bold"
  | "extra-bold"
  | "ultra-bold"
  | "black"
  | "heavy";

export type FontFamilyValue = string | readonly string[];

export interface TokenValueMap {
  readonly color: ColorValue;
  readonly dimension: DimensionValue;
  readonly fontFamily: FontFamilyValue;
  readonly number: number;
  readonly duration: DurationValue;
  readonly fontWeight: FontWeightValue;
  readonly cubicBezier: JsonValue;
  readonly strokeStyle: JsonValue;
  readonly border: JsonValue;
  readonly transition: JsonValue;
  readonly shadow: JsonValue;
  readonly gradient: JsonValue;
  readonly typography: JsonValue;
}

export type TokenLiteral = TokenValueMap[TokenType];

export interface SourceLocation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly offset: number;
  readonly length: number;
  readonly excerpt?: string;
}

export interface TokenReference<T extends TokenType = TokenType> {
  readonly kind: "reference";
  readonly target: TokenId;
  readonly source: SourceLocation;
  /** Carries the owning token type without changing the runtime representation. */
  readonly __type?: T;
}

export interface TokenLiteralExpression<T extends TokenType = TokenType> {
  readonly kind: "literal";
  readonly value: TokenValueMap[T];
}

export type TokenExpression<T extends TokenType = TokenType> =
  | TokenReference<T>
  | TokenLiteralExpression<T>;

export type CompilationContext = Readonly<Record<string, string>>;

export interface ContextOverride<T extends TokenType = TokenType> {
  readonly selector: CompilationContext;
  readonly expression: TokenExpression<T>;
  readonly source: SourceLocation;
  /** Explicit semantic precedence; higher values win. */
  readonly precedence?: number;
  readonly origin?: "resolver" | "tokenc-context";
}

/** A typed source-language token node, before context evaluation. */
export interface TokenNode<T extends TokenType = TokenType> {
  readonly kind: "token";
  readonly id: TokenId;
  readonly type: T;
  readonly value: TokenExpression<T>;
  readonly description?: string;
  readonly deprecated?: boolean | string;
  readonly extensions?: Readonly<Record<string, JsonValue>>;
  readonly overrides: readonly ContextOverride<T>[];
  readonly source: SourceLocation;
  readonly dependencies: readonly TokenId[];
}

export interface ParsedTokenDocument {
  readonly source: string;
  readonly content: string;
  readonly tokens: readonly TokenNode[];
  readonly diagnostics: readonly Diagnostic[];
}

export type DiagnosticSeverity = "error" | "warning" | "info";

export interface RelatedDiagnostic {
  readonly message: string;
  readonly source?: SourceLocation;
}

export interface Diagnostic {
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly source?: SourceLocation;
  readonly related?: readonly RelatedDiagnostic[];
  readonly suggestions?: readonly string[];
}

export interface ContextDimension {
  readonly default: string;
  readonly values: readonly string[];
}

export type ContextDefinition = Readonly<Record<string, ContextDimension>>;

export type ReferenceStrategy = "resolve" | "preserve" | "symbol";

export interface ResolvedToken<T extends TokenType = TokenType> {
  readonly id: TokenId;
  readonly type: T;
  readonly expression: TokenExpression<T>;
  readonly value: TokenValueMap[T];
  readonly context: CompilationContext;
  readonly dependencies: readonly TokenId[];
  readonly source: SourceLocation;
}

export interface CompiledToken<T extends TokenType = TokenType> extends ResolvedToken<T> {
  readonly rawValue: TokenExpression<T>;
}

export interface OutputFile {
  readonly path: string;
  readonly content: string;
}

export interface CompilationStats {
  readonly tokens: number;
  readonly references: number;
  readonly contexts: number;
  readonly affectedTokens?: number;
  readonly checkedTokens?: number;
  readonly timings: {
    readonly parse: number;
    readonly graph: number;
    readonly check: number;
    readonly emit: number;
    readonly total: number;
  };
}

export interface ImpactAnalysis {
  readonly changed: readonly TokenId[];
  readonly directlyAffected: readonly TokenId[];
  readonly indirectlyAffected: readonly TokenId[];
}

export interface ResolutionTraceStep {
  readonly token: TokenId;
  readonly selection: "base" | "override";
  readonly expression: TokenExpression;
  readonly source: SourceLocation;
  readonly selector?: CompilationContext;
  readonly origin?: "resolver" | "tokenc-context";
  readonly precedence?: number;
}

export interface ResolverTraceStep {
  readonly kind: "set" | "modifier";
  readonly name: string;
  readonly context?: string;
  readonly source: SourceLocation;
}

export interface ResolutionTrace {
  readonly token: TokenId;
  readonly context: CompilationContext;
  readonly selectedSource?: SourceLocation;
  readonly steps: readonly ResolutionTraceStep[];
  readonly resolverSteps: readonly ResolverTraceStep[];
  readonly value?: TokenLiteral;
}
