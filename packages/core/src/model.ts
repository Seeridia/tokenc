/** Canonical, dot-separated token identifier. */
export type TokenId = string & { readonly __brand: "TokenId" };
export type DependencyCandidateId = string;

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
}

export type SRGBColor = DTCGColor & { readonly colorSpace: "srgb" };
export type OKLCHColor = DTCGColor & { readonly colorSpace: "oklch" };

export type ColorValue = DTCGColor;

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
  | "heavy"
  | "extra-black"
  | "ultra-black";

export type FontFamilyValue = string | readonly string[];

export type CubicBezierValue = readonly [number, number, number, number];

export type StrokeStyleKeyword =
  | "solid"
  | "dashed"
  | "dotted"
  | "double"
  | "groove"
  | "ridge"
  | "outset"
  | "inset";

export interface StrokeStyleObjectValue {
  readonly dashArray: readonly DimensionValue[];
  readonly lineCap: "round" | "butt" | "square";
}

export type StrokeStyleValue = StrokeStyleKeyword | StrokeStyleObjectValue;

export interface BorderValue {
  readonly color: ColorValue;
  readonly width: DimensionValue;
  readonly style: StrokeStyleValue;
}

export interface TransitionValue {
  readonly duration: DurationValue;
  readonly delay: DurationValue;
  readonly timingFunction: CubicBezierValue;
}

export interface ShadowValue {
  readonly color: ColorValue;
  readonly offsetX: DimensionValue;
  readonly offsetY: DimensionValue;
  readonly blur: DimensionValue;
  readonly spread: DimensionValue;
  readonly inset?: boolean;
}

export type ShadowTokenValue = ShadowValue | readonly ShadowValue[];

export interface GradientStopValue {
  readonly color: ColorValue;
  readonly position: number;
}

/** Gradient-token references remain single array elements and are not flattened. */
export type GradientValue = readonly (GradientStopValue | GradientValue)[];

export interface TypographyValue {
  readonly fontFamily: FontFamilyValue;
  readonly fontSize: DimensionValue;
  readonly fontWeight: FontWeightValue;
  readonly letterSpacing: DimensionValue;
  readonly lineHeight: number;
}

export interface TokenValueMap {
  readonly color: ColorValue;
  readonly dimension: DimensionValue;
  readonly fontFamily: FontFamilyValue;
  readonly number: number;
  readonly duration: DurationValue;
  readonly fontWeight: FontWeightValue;
  readonly cubicBezier: CubicBezierValue;
  readonly strokeStyle: StrokeStyleValue;
  readonly border: BorderValue;
  readonly transition: TransitionValue;
  readonly shadow: ShadowTokenValue;
  readonly gradient: GradientValue;
  readonly typography: TypographyValue;
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
  /** Present when the source spelling was a DTCG JSON Pointer `$ref`. */
  readonly pointer?: string;
  /** Carries the owning token type without changing the runtime representation. */
  readonly __type?: T;
}

export interface TokenLiteralExpression<T extends TokenType = TokenType> {
  readonly kind: "literal";
  readonly value: TokenValueMap[T];
}

export interface JsonPointerReferenceExpression<T extends TokenType = TokenType> {
  readonly kind: "json-pointer-reference";
  readonly pointer: string;
  /** Token that owns the referenced component and therefore receives the graph edge. */
  readonly target: TokenId;
  readonly value: TokenValueMap[T];
  readonly source: SourceLocation;
}

export type TokenExpression<T extends TokenType = TokenType> =
  | TokenReference<T>
  | TokenLiteralExpression<T>
  | JsonPointerReferenceExpression<T>;

export interface TokenInheritance {
  readonly token: TokenId;
  readonly group: string;
  readonly source: SourceLocation;
  readonly extendsSource: SourceLocation;
}

/** Syntax-proven canonical token or group declaration retained independently of semantic validity. */
export interface TokenDeclaration {
  readonly id: TokenId;
  readonly source: SourceLocation;
}

/** One syntax-level group inheritance spelling before member materialization. */
export interface GroupInheritance {
  readonly owner: TokenId;
  readonly target: TokenId;
  readonly source: SourceLocation;
}

export type CompilationContext = Readonly<Record<string, string>>;

export interface ContextOverride<T extends TokenType = TokenType> {
  readonly candidate: DependencyCandidateId;
  readonly selector: CompilationContext;
  readonly expression: TokenExpression<T>;
  /** Source occurrences used only when this override is selected. */
  readonly dependencyOccurrences: readonly DependencyOccurrence[];
  readonly source: SourceLocation;
  /** Explicit semantic precedence; higher values win. */
  readonly precedence?: number;
  readonly origin?: "resolver" | "extension-context";
}

/** A typed source-language token node, before context evaluation. */
export interface TokenNode<T extends TokenType = TokenType> {
  readonly kind: "token";
  readonly id: TokenId;
  readonly type: T;
  readonly baseCandidate: DependencyCandidateId;
  readonly value: TokenExpression<T>;
  readonly description?: string;
  readonly deprecated?: boolean | string;
  readonly extensions?: Readonly<Record<string, JsonValue>>;
  readonly overrides: readonly ContextOverride<T>[];
  /** Exact JSON property-key span that declares this token. */
  readonly declaration: SourceLocation;
  readonly source: SourceLocation;
  readonly dependencyOccurrences: readonly DependencyOccurrence[];
  readonly inheritance?: TokenInheritance;
}

export type DependencyKind = "alias" | "json-pointer" | "inheritance" | "composite-field";

/** One source-level dependency spelling before Graph indexing or deduplication. */
export interface DependencyOccurrence {
  readonly id: string;
  readonly owner: TokenId;
  readonly candidate: DependencyCandidateId;
  readonly target: TokenId;
  readonly kind: DependencyKind;
  readonly fieldPath: readonly (string | number)[];
  readonly source: SourceLocation;
  readonly sourceOrder: number;
}

export interface ParsedTokenDocument {
  readonly source: string;
  readonly content: string;
  readonly declarations: readonly TokenDeclaration[];
  readonly inheritances: readonly GroupInheritance[];
  readonly tokens: readonly TokenNode[];
  readonly diagnostics: readonly Diagnostic[];
}

export type DiagnosticSeverity = "error" | "warning" | "info";

export type DiagnosticCode = string;

export interface SourceRange {
  readonly line: number;
  readonly column: number;
  readonly offset: number;
  readonly length: number;
}

export type SemanticAnchor =
  | { readonly kind: "token"; readonly token: TokenId }
  | {
      readonly kind: "candidate";
      readonly token: TokenId;
      readonly candidate: DependencyCandidateId;
    }
  | {
      readonly kind: "field";
      readonly token: TokenId;
      readonly candidate?: DependencyCandidateId;
      readonly path: readonly (string | number)[];
    }
  | { readonly kind: "json-pointer"; readonly pointer: string }
  | { readonly kind: "offset"; readonly errorKind: string; readonly offset: number };

export interface DiagnosticLocation {
  readonly document: string;
  readonly range: SourceRange;
  readonly anchor?: SemanticAnchor;
  /** Source line retained for terminal code frames; it is excluded from fingerprints. */
  readonly excerpt?: string;
}

export interface RelatedDiagnosticV1 {
  readonly message: string;
  readonly source?: DiagnosticLocation;
}

export interface TextEdit {
  readonly document: string;
  readonly range: SourceRange;
  readonly newText: string;
  readonly expectedDocumentDigest: string;
}

export interface DiagnosticFixV1 {
  readonly title: string;
  readonly applicability: "safe" | "requires-review";
  readonly edits: readonly TextEdit[];
}

export interface DiagnosticV1 {
  readonly schemaVersion: "1";
  readonly code: DiagnosticCode;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly parameters: Readonly<Record<string, JsonValue>>;
  readonly fingerprint: string;
  readonly documentationUrl: string;
  readonly source?: DiagnosticLocation;
  readonly related: readonly RelatedDiagnosticV1[];
  readonly fixes: readonly DiagnosticFixV1[];
}

export type Diagnostic = DiagnosticV1;

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
  readonly id: string;
  readonly path: string;
  readonly content: string;
}

/** Read-only work counters from one Context-aware cycle-check invocation. */
export interface ContextCycleMetrics {
  readonly candidateRegions: number;
  readonly relevantDimensions: number;
  readonly estimatedProjections: number;
  readonly estimateSaturated: boolean;
  readonly enumeratedProjections: number;
  readonly earlyExits: number;
  readonly limitHits: number;
}

export interface CompilationStageTimings {
  readonly parse: number;
  readonly link: number;
  readonly graph: number;
  readonly check: number;
  readonly resolve: number;
  readonly emit: number;
  readonly total: number;
}

export interface CompilationStats {
  readonly tokens: number;
  readonly references: number;
  readonly contexts: number;
  readonly affectedTokens?: number;
  readonly checkedTokens?: number;
  readonly contextCycles?: ContextCycleMetrics;
  readonly timings: CompilationStageTimings;
}

export interface DependencyTraceStepV1 {
  readonly target: TokenId;
  readonly candidate: DependencyCandidateId;
  readonly kind: DependencyKind;
  readonly fieldPath: readonly (string | number)[];
  readonly source: SourceLocation;
}

export interface ExplainTraceStepV1 {
  readonly token: TokenId;
  readonly candidate: DependencyCandidateId;
  readonly selection: "base" | "override";
  readonly expression: TokenExpression;
  readonly source: SourceLocation;
  readonly dependencies: readonly DependencyTraceStepV1[];
  readonly selector?: CompilationContext;
  readonly origin?: "resolver" | "extension-context";
  readonly precedence?: number;
}

export interface ResolverTraceStepV1 {
  readonly kind: "set" | "modifier";
  readonly name: string;
  readonly context?: string;
  readonly source: SourceLocation;
}

export interface ExplainTraceV1 {
  readonly schemaVersion: "1";
  readonly token: TokenId;
  readonly context: CompilationContext;
  readonly steps: readonly ExplainTraceStepV1[];
  readonly resolverSteps: readonly ResolverTraceStepV1[];
  readonly finalValue?: TokenLiteral;
}
