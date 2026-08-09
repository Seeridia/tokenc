/** Canonical, dot-separated token identifier. */
export type TokenId = string & { readonly __brand: "TokenId" };

export type TokenType =
  | "color"
  | "dimension"
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

export interface SRGBColor {
  readonly colorSpace: "srgb";
  readonly components: readonly [number, number, number];
  readonly alpha: number;
  readonly original?: string;
}

export interface OKLCHColor {
  readonly colorSpace: "oklch";
  readonly components: readonly [number, number, number];
  readonly alpha: number;
}

/** A valid CSS color that the core deliberately leaves platform-neutral. */
export interface CSSColor {
  readonly colorSpace: "css";
  readonly value: string;
}

export type ColorValue = SRGBColor | OKLCHColor | CSSColor;

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

export interface TokenValueMap {
  readonly color: ColorValue;
  readonly dimension: DimensionValue;
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

export interface TokenReference {
  readonly kind: "reference";
  readonly target: TokenId;
  readonly source: SourceLocation;
}

export interface TokenLiteralExpression {
  readonly kind: "literal";
  readonly value: TokenLiteral;
}

export type TokenExpression = TokenReference | TokenLiteralExpression;

export type CompilationContext = Readonly<Record<string, string>>;

export interface ContextOverride {
  readonly selector: CompilationContext;
  readonly expression: TokenExpression;
  readonly source: SourceLocation;
}

/** A typed source-language token node, before context evaluation. */
export interface TokenNode<T extends TokenType = TokenType> {
  readonly kind: "token";
  readonly id: TokenId;
  readonly type: T;
  readonly value: TokenExpression;
  readonly description?: string;
  readonly extensions?: Readonly<Record<string, JsonValue>>;
  readonly overrides: readonly ContextOverride[];
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

export interface ResolvedToken {
  readonly id: TokenId;
  readonly type: TokenType;
  readonly expression: TokenExpression;
  readonly value: TokenLiteral;
  readonly context: CompilationContext;
  readonly dependencies: readonly TokenId[];
  readonly source: SourceLocation;
}

export interface CompiledToken extends ResolvedToken {
  readonly rawValue: TokenExpression;
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
