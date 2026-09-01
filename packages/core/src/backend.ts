import path from "node:path";

import { DiagnosticBag } from "./diagnostic.js";
import type {
  ColorSpace,
  CompilationContext,
  CompiledToken,
  ContextDefinition,
  Diagnostic,
  OutputFile,
  ReferenceStrategy,
  ResolvedToken,
  SourceLocation,
  TokenId,
  TokenNode,
  TokenType,
} from "./model.js";

export const ALL_TOKEN_TYPES: ReadonlySet<TokenType> = new Set([
  "color",
  "dimension",
  "fontFamily",
  "number",
  "duration",
  "fontWeight",
  "cubicBezier",
  "strokeStyle",
  "border",
  "transition",
  "shadow",
  "gradient",
  "typography",
]);

const COMPOSITE_TYPES: ReadonlySet<TokenType> = new Set([
  "strokeStyle",
  "border",
  "transition",
  "shadow",
  "gradient",
  "typography",
]);

export interface BackendCapabilities {
  readonly tokenTypes: ReadonlySet<TokenType>;
  readonly referenceStrategies: ReadonlySet<ReferenceStrategy>;
  readonly contextMode: "none" | "finite-selectors" | "runtime";
  readonly colorSpaces: "preserve" | ReadonlySet<ColorSpace>;
  readonly composite: "native" | "serialized-subset" | "none";
}

export interface SymbolNamespace {
  readonly name: string;
  readonly caseSensitive: boolean;
  readonly normalize: "NFC" | "NFKC";
  readonly reserved: ReadonlySet<string>;
  readonly pattern: RegExp;
}

export interface SymbolRequest {
  readonly id: string;
  readonly token: TokenNode;
  readonly namespace: SymbolNamespace;
  readonly name: string | ((token: TokenNode) => string);
  /** Key consulted in the explicit rename map. Defaults to the Token ID. */
  readonly renameKey?: string;
}

export interface AllocatedSymbol {
  readonly id: string;
  readonly token: TokenId;
  readonly namespace: string;
  readonly name: string;
  readonly source: SourceLocation;
}

export interface SymbolAllocation {
  readonly symbols: readonly AllocatedSymbol[];
  readonly diagnostics: readonly Diagnostic[];
}

export interface AllocateSymbolsOptions {
  readonly backendId: string;
  readonly requests: readonly SymbolRequest[];
  readonly renameMap?: Readonly<Record<string, string>>;
}

function comparableSymbol(namespace: SymbolNamespace, value: string): string {
  const normalized = value.normalize(namespace.normalize);
  return namespace.caseSensitive ? normalized : normalized.toLowerCase();
}

function matchesPattern(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(value);
}

/** Shared, deterministic symbol authority for every Backend. */
export class SymbolAllocator {
  allocate(options: AllocateSymbolsOptions): SymbolAllocation {
    const diagnostics = new DiagnosticBag();
    const symbols: AllocatedSymbol[] = [];
    const owners = new Map<string, AllocatedSymbol>();
    const renameMap = options.renameMap ?? {};
    let namingFailed = false;
    for (const request of options.requests) {
      let requested: string;
      try {
        const explicit = renameMap[request.renameKey ?? request.token.id];
        requested =
          explicit ??
          (typeof request.name === "function" ? request.name(request.token) : request.name);
      } catch (error) {
        namingFailed = true;
        diagnostics.push({
          code: "BACKEND_NAMING_FAILED",
          message: `Backend \`${options.backendId}\` naming failed for \`${request.token.id}\`: ${error instanceof Error ? error.message : String(error)}`,
          source: request.token.source,
          anchor: { kind: "token", token: request.token.id },
          parameters: { backend: options.backendId, token: request.token.id },
        });
        continue;
      }
      const name = requested.normalize(request.namespace.normalize);
      const comparable = comparableSymbol(request.namespace, name);
      if (!matchesPattern(request.namespace.pattern, name)) {
        diagnostics.push({
          code: "BACKEND_SYMBOL_INVALID",
          message: `Backend \`${options.backendId}\` generated invalid ${request.namespace.name} symbol \`${name}\` for \`${request.token.id}\``,
          source: request.token.source,
          anchor: { kind: "token", token: request.token.id },
          parameters: {
            backend: options.backendId,
            namespace: request.namespace.name,
            name,
            token: request.token.id,
          },
        });
        continue;
      }
      const reserved = new Set(
        [...request.namespace.reserved].map((entry) => comparableSymbol(request.namespace, entry)),
      );
      if (reserved.has(comparable)) {
        diagnostics.push({
          code: "BACKEND_SYMBOL_RESERVED",
          message: `Backend \`${options.backendId}\` cannot allocate reserved ${request.namespace.name} symbol \`${name}\` for \`${request.token.id}\``,
          source: request.token.source,
          anchor: { kind: "token", token: request.token.id },
          parameters: {
            backend: options.backendId,
            namespace: request.namespace.name,
            name,
            token: request.token.id,
          },
        });
        continue;
      }
      const symbol: AllocatedSymbol = Object.freeze({
        id: request.id,
        token: request.token.id,
        namespace: request.namespace.name,
        name,
        source: request.token.source,
      });
      const collisionKey = `${request.namespace.name}\u0000${comparable}`;
      const previous = owners.get(collisionKey);
      if (previous && previous.token !== symbol.token) {
        diagnostics.push({
          code: "BACKEND_SYMBOL_COLLISION",
          message: `Backend \`${options.backendId}\` maps both \`${previous.token}\` and \`${symbol.token}\` to ${request.namespace.name} symbol \`${name}\``,
          source: symbol.source,
          anchor: { kind: "token", token: symbol.token },
          parameters: {
            backend: options.backendId,
            namespace: request.namespace.name,
            name,
            firstToken: previous.token,
            secondToken: symbol.token,
          },
          related: [
            { message: `First allocated to \`${previous.token}\``, source: previous.source },
          ],
        });
        continue;
      }
      owners.set(collisionKey, symbol);
      symbols.push(symbol);
    }
    return {
      symbols: Object.freeze(namingFailed ? [] : symbols),
      diagnostics: Object.freeze([...diagnostics]),
    };
  }
}

export interface PlannedArtifact<Payload = unknown> {
  readonly id: string;
  readonly path: string;
  readonly mediaType: string;
  readonly tokenIds: readonly TokenId[];
  readonly payload: Payload;
}

export interface BackendPlan<Data = unknown, Payload = unknown> {
  readonly backendId: string;
  readonly diagnostics: readonly Diagnostic[];
  readonly symbols: readonly AllocatedSymbol[];
  readonly artifacts: readonly PlannedArtifact<Payload>[];
  readonly data: Data;
}

export interface TokenBackend<Plan extends BackendPlan = BackendPlan> {
  readonly id: string;
  readonly capabilities: BackendCapabilities;
  prepare(ir: CompilationIR): Promise<Plan> | Plan;
  emit(plan: Plan): Promise<readonly OutputFile[]> | readonly OutputFile[];
}

export interface BackendPreparationResult {
  readonly success: boolean;
  readonly diagnostics: readonly Diagnostic[];
  readonly plans: readonly BackendPlan[];
}

export interface BackendEmissionResult extends BackendPreparationResult {
  readonly outputs: readonly OutputFile[];
}

interface CompilationIRSource {
  readonly tokens: readonly CompiledToken[];
  readonly sourceTokens: readonly TokenNode[];
  readonly contexts: ContextDefinition;
  readonly availableContexts: readonly CompilationContext[];
  readonly resolutionContext?: CompilationContext;
  getToken(id: TokenId): TokenNode | undefined;
  resolveToken(id: TokenId, context?: CompilationContext): ResolvedToken | undefined;
}

function freezeContexts(contexts: readonly CompilationContext[]): readonly CompilationContext[] {
  return Object.freeze(contexts.map((context) => Object.freeze({ ...context })));
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

/** Immutable, Backend-neutral view of a checked compilation. */
export class CompilationIR {
  readonly tokens: readonly CompiledToken[];
  readonly sourceTokens: readonly TokenNode[];
  readonly contexts: ContextDefinition;
  readonly availableContexts: readonly CompilationContext[];
  readonly resolutionContext?: CompilationContext;
  readonly #getToken: CompilationIRSource["getToken"];
  readonly #resolveToken: CompilationIRSource["resolveToken"];

  constructor(source: CompilationIRSource) {
    this.tokens = Object.freeze([...source.tokens]);
    this.sourceTokens = Object.freeze([...source.sourceTokens]);
    this.contexts = Object.freeze(
      Object.fromEntries(
        Object.entries(source.contexts).map(([name, dimension]) => [
          name,
          Object.freeze({ ...dimension, values: Object.freeze([...dimension.values]) }),
        ]),
      ),
    );
    this.availableContexts = freezeContexts(source.availableContexts);
    if (source.resolutionContext)
      this.resolutionContext = Object.freeze({ ...source.resolutionContext });
    this.#getToken = source.getToken.bind(source);
    this.#resolveToken = source.resolveToken.bind(source);
    Object.freeze(this);
  }

  getToken(id: TokenId): TokenNode | undefined {
    return this.#getToken(id);
  }

  resolveToken(id: TokenId, context: CompilationContext = {}): ResolvedToken | undefined {
    return this.#resolveToken(id, context);
  }
}

export class BackendContractError extends Error {
  readonly backendId: string;

  constructor(backendId: string, message: string) {
    super(`Backend \`${backendId}\` contract violation: ${message}`);
    this.name = "BackendContractError";
    this.backendId = backendId;
  }
}

/** Freeze the public Plan surface before global preflight and emission. */
export function freezeBackendPlan<Plan extends BackendPlan>(plan: Plan): Plan {
  const artifacts = Object.freeze(
    plan.artifacts.map((artifact) =>
      deepFreeze({
        ...artifact,
        tokenIds: [...artifact.tokenIds],
        payload: artifact.payload,
      }),
    ),
  );
  return deepFreeze({
    ...plan,
    diagnostics: Object.freeze([...plan.diagnostics]),
    symbols: Object.freeze([...plan.symbols]),
    artifacts,
    data: plan.data,
  });
}

function isColorValue(value: unknown): value is { readonly colorSpace: ColorSpace } {
  return typeof value === "object" && value !== null && "colorSpace" in value;
}

export function backendCapabilityDiagnostics(
  backend: TokenBackend,
  ir: CompilationIR,
): readonly Diagnostic[] {
  const diagnostics = new DiagnosticBag();
  const reported = new Set<string>();
  for (const token of ir.tokens) {
    const source = ir.getToken(token.id);
    if (!source) continue;
    if (!backend.capabilities.tokenTypes.has(token.type)) {
      const key = `type:${token.id}`;
      if (!reported.has(key)) {
        reported.add(key);
        diagnostics.push({
          code: "BACKEND_UNSUPPORTED_TYPE",
          message: `Backend \`${backend.id}\` does not support token type \`${token.type}\` for \`${token.id}\``,
          source: source.source,
          anchor: { kind: "token", token: token.id },
          parameters: { backend: backend.id, token: token.id, type: token.type },
        });
      }
    }
    if (backend.capabilities.composite === "none" && COMPOSITE_TYPES.has(token.type)) {
      const key = `composite:${token.id}`;
      if (!reported.has(key)) {
        reported.add(key);
        diagnostics.push({
          code: "BACKEND_UNSUPPORTED_VALUE",
          message: `Backend \`${backend.id}\` does not support composite token \`${token.id}\``,
          source: source.source,
          anchor: { kind: "token", token: token.id },
        });
      }
    }
    for (const context of ir.availableContexts) {
      const resolved = ir.resolveToken(token.id, context);
      if (
        resolved &&
        (resolved.expression.kind === "reference" ||
          resolved.expression.kind === "json-pointer-reference") &&
        backend.capabilities.referenceStrategies.size === 0
      ) {
        const key = `reference:${token.id}`;
        if (!reported.has(key)) {
          reported.add(key);
          diagnostics.push({
            code: "BACKEND_UNSUPPORTED_REFERENCE_STRATEGY",
            message: `Backend \`${backend.id}\` declares no strategy for reference token \`${token.id}\``,
            source: resolved.source,
            anchor: { kind: "token", token: token.id },
            parameters: { backend: backend.id, token: token.id },
          });
        }
      }
      if (
        resolved &&
        isColorValue(resolved.value) &&
        backend.capabilities.colorSpaces !== "preserve" &&
        !backend.capabilities.colorSpaces.has(resolved.value.colorSpace)
      ) {
        const key = `color:${token.id}:${resolved.value.colorSpace}`;
        if (reported.has(key)) continue;
        reported.add(key);
        diagnostics.push({
          code: "BACKEND_UNSUPPORTED_COLOR_SPACE",
          message: `Backend \`${backend.id}\` cannot preserve color space \`${resolved.value.colorSpace}\` for \`${token.id}\``,
          source: resolved.source,
          anchor: { kind: "token", token: token.id },
          parameters: {
            backend: backend.id,
            token: token.id,
            colorSpace: resolved.value.colorSpace,
          },
        });
      }
    }
  }
  return diagnostics;
}

interface PlannedArtifactOwner {
  readonly backendId: string;
  readonly artifact: PlannedArtifact;
}

function artifactPathError(value: string): string | undefined {
  if (!value) return "path must not be empty";
  if (value.includes("\0")) return "path must not contain NUL";
  const portable = value.replaceAll("\\", "/");
  if (portable.startsWith("/") || /^[A-Za-z]:\//u.test(portable)) return "path must be relative";
  if (portable.split("/").includes("..")) return "path must not escape the output root";
  if (path.posix.normalize(portable) !== portable || portable === ".")
    return "path must be normalized";
  if (value !== value.normalize("NFC")) return "path must use Unicode NFC normalization";
  return undefined;
}

function artifactCollisionKey(value: string): string {
  return value.replaceAll("\\", "/").normalize("NFC").toLowerCase();
}

/** Validate all artifact identities and paths before any Backend is emitted. */
export function backendPlanDiagnostics(plans: readonly BackendPlan[]): readonly Diagnostic[] {
  const diagnostics = new DiagnosticBag();
  const owners = new Map<string, PlannedArtifactOwner>();
  const ids = new Set<string>();
  for (const plan of plans) {
    for (const artifact of plan.artifacts) {
      const identity = `${plan.backendId}\u0000${artifact.id}`;
      if (ids.has(identity))
        throw new BackendContractError(
          plan.backendId,
          `duplicate artifact identity \`${artifact.id}\``,
        );
      ids.add(identity);
      const error = artifactPathError(artifact.path);
      if (error) {
        diagnostics.push({
          code: "BACKEND_ARTIFACT_INVALID_PATH",
          message: `Backend \`${plan.backendId}\` artifact \`${artifact.id}\` has invalid path \`${artifact.path}\`: ${error}`,
          parameters: { backend: plan.backendId, artifact: artifact.id, path: artifact.path },
        });
      }
      const key = artifactCollisionKey(artifact.path);
      const previous = owners.get(key);
      if (!previous) {
        owners.set(key, { backendId: plan.backendId, artifact });
        continue;
      }
      diagnostics.push({
        code: "BACKEND_ARTIFACT_COLLISION",
        message: `Backend \`${plan.backendId}\` artifact \`${artifact.path}\` collides with backend \`${previous.backendId}\` artifact \`${previous.artifact.path}\``,
        parameters: {
          backend: plan.backendId,
          artifact: artifact.id,
          path: artifact.path,
          previousBackend: previous.backendId,
          previousArtifact: previous.artifact.id,
          previousPath: previous.artifact.path,
        },
      });
    }
  }
  return diagnostics;
}

export function assertBackendOutputs(plan: BackendPlan, outputs: readonly OutputFile[]): void {
  if (outputs.length !== plan.artifacts.length)
    throw new BackendContractError(
      plan.backendId,
      `planned ${plan.artifacts.length} artifact(s) but emitted ${outputs.length}`,
    );
  for (const [index, artifact] of plan.artifacts.entries()) {
    const output = outputs[index];
    if (!output)
      throw new BackendContractError(plan.backendId, `missing artifact \`${artifact.id}\``);
    if (output.id !== artifact.id || output.path !== artifact.path)
      throw new BackendContractError(
        plan.backendId,
        `planned \`${artifact.id}\` at \`${artifact.path}\` but emitted \`${output.id}\` at \`${output.path}\``,
      );
  }
}

/** Prepare every Backend and run the global preflight without emitting artifacts. */
export async function prepareBackends(
  ir: CompilationIR,
  backends: readonly TokenBackend[],
): Promise<BackendPreparationResult> {
  const capabilityDiagnostics = backends.flatMap((backend) =>
    backendCapabilityDiagnostics(backend, ir),
  );
  const plans = await Promise.all(
    backends.map(async (backend) => {
      const plan = freezeBackendPlan(await backend.prepare(ir));
      if (plan.backendId !== backend.id)
        throw new BackendContractError(
          backend.id,
          `prepare returned plan for \`${plan.backendId}\``,
        );
      return plan;
    }),
  );
  const diagnostics = Object.freeze([
    ...capabilityDiagnostics,
    ...plans.flatMap((plan) => plan.diagnostics),
    ...backendPlanDiagnostics(plans),
  ]);
  return Object.freeze({
    success: !diagnostics.some((diagnostic) => diagnostic.severity === "error"),
    diagnostics,
    plans: Object.freeze(plans),
  });
}

/** Emit one already-preflighted Plan set and enforce its artifact contract. */
export async function emitBackendPlans(
  backends: readonly TokenBackend[],
  preparation: BackendPreparationResult,
): Promise<BackendEmissionResult> {
  if (!preparation.success) return Object.freeze({ ...preparation, outputs: Object.freeze([]) });
  if (backends.length !== preparation.plans.length)
    throw new BackendContractError("core", "Backend and Plan counts differ");
  const outputGroups = await Promise.all(
    backends.map(async (backend, index) => {
      const plan = preparation.plans[index];
      if (!plan) throw new BackendContractError(backend.id, "missing prepared plan during emit");
      const outputs = await backend.emit(plan);
      assertBackendOutputs(plan, outputs);
      return outputs;
    }),
  );
  return Object.freeze({
    ...preparation,
    outputs: Object.freeze(outputGroups.flat().map((output) => Object.freeze({ ...output }))),
  });
}
