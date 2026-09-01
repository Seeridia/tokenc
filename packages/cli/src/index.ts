import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildImpactReport,
  compareSnapshots,
  createDiagnostic,
  createCompilerSession,
  diagnosticCodeRegistry,
  evaluateSnapshotPolicy,
  FileSystemDocumentLoader,
  loadTokenFiles,
  parseTokenId,
  parseResolverDocument,
  registerDiagnosticCode,
  serializeImpactReport,
  type BackendEmissionResult,
  type BackendPreparationResult,
  type CompilationContext,
  type CompilationSnapshot,
  type CompilerSessionConfiguration,
  type CompilerConfig,
  type Diagnostic,
  type DocumentLoader,
  type DocumentChange,
  type ImpactReportV1,
  type OutputFile,
  type SnapshotDiffV1,
  type TokenId,
  type TokenLiteral,
} from "@tokenc/core";
import { watch } from "chokidar";
import { createJiti } from "jiti";

import {
  configFileChanged,
  shouldReloadConfigForEvent,
  type ConfigFileSnapshot,
} from "./config-file.js";
import {
  GitRevisionError,
  GitRevisionProvider,
  scopedGitDocumentLoader,
  type GitSourceView,
} from "./git-revision-provider.js";
import { LatestTaskRunner } from "./latest-task-runner.js";
import { createCheckReport, createDiffReport, renderReport, type ReportFormat } from "./report.js";

export * from "./report.js";

export const CLI_NAME = "tokenc";

export interface CliIO {
  readonly cwd: string;
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
}

async function sessionConfiguration(
  config: CompilerConfig,
  loader: DocumentLoader,
  signal?: AbortSignal,
): Promise<CompilerSessionConfiguration> {
  let resolver: ReturnType<typeof parseResolverDocument>["document"];
  let resolverDiagnostics: readonly Diagnostic[] = [];
  if (config.resolver) {
    const loaded = await loader.load({ specifier: config.resolver.source }, signal);
    const parsed = parseResolverDocument(loaded.content, loaded.identity);
    resolver = parsed.document;
    resolverDiagnostics = parsed.diagnostics;
  }
  return {
    ...(config.contexts ? { contexts: config.contexts } : {}),
    ...(config.outputs ? { backends: config.outputs } : {}),
    ...(resolver ? { resolver } : {}),
    ...(config.resolver?.input ? { resolverInput: config.resolver.input } : {}),
    ...(resolverDiagnostics.length > 0 ? { resolverDiagnostics } : {}),
  };
}

function outputPaths(
  config: CompilerConfig,
  outputs: readonly OutputFile[],
  io: CliIO,
): ReadonlySet<string> {
  return new Set(outputs.map((output) => resolve(config.cwd ?? io.cwd, output.path)));
}

interface ParsedArguments {
  readonly command: string;
  readonly positionals: readonly string[];
  readonly flags: ReadonlyMap<string, string | true>;
  readonly contextFilters: readonly string[];
}

function parseArguments(args: readonly string[]): ParsedArguments {
  const command = args[0] && !args[0].startsWith("-") ? args[0] : "help";
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  const contextFilters: string[] = [];
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument) continue;
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const rawFlag = argument.slice(2);
    const separator = rawFlag.indexOf("=");
    const rawName = separator < 0 ? rawFlag : rawFlag.slice(0, separator);
    const inline = separator < 0 ? undefined : rawFlag.slice(separator + 1);
    if (!rawName) continue;
    if (rawName === "context") {
      if (inline !== undefined) contextFilters.push(inline);
      else if (args[index + 1] && !args[index + 1]!.startsWith("--")) {
        contextFilters.push(args[index + 1]!);
        index += 1;
      } else contextFilters.push("");
      continue;
    }
    if (inline !== undefined) flags.set(rawName, inline);
    else if (args[index + 1] && !args[index + 1]!.startsWith("--")) {
      flags.set(rawName, args[index + 1]!);
      index += 1;
    } else flags.set(rawName, true);
  }
  return { command, positionals, flags, contextFilters };
}

const CONFIG_NAMES = [
  "tokenc.config.ts",
  "tokenc.config.mts",
  "tokenc.config.js",
  "tokenc.config.mjs",
] as const;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function findConfig(cwd: string, explicit?: string): Promise<string> {
  if (explicit) {
    const path = resolve(cwd, explicit);
    if (await exists(path)) return path;
    throw new Error(`Config file not found: ${path}`);
  }
  const candidates = CONFIG_NAMES.map((name) => resolve(cwd, name));
  const availability = await Promise.all(candidates.map(exists));
  const found = candidates.find((_, index) => availability[index]);
  if (found) return found;
  throw new Error(`No tokenc config found in ${cwd}`);
}

function isConfig(value: unknown): value is CompilerConfig {
  return (
    typeof value === "object" &&
    value !== null &&
    "source" in value &&
    Array.isArray(value.source) &&
    value.source.every((item: unknown) => typeof item === "string")
  );
}

interface LoadedConfig extends ConfigFileSnapshot {
  readonly config: CompilerConfig;
}

async function loadConfigFile(cwd: string, explicit?: string): Promise<LoadedConfig> {
  const path = await findConfig(cwd, explicit);
  // Read before importing so an edit racing with the import remains detectable on the next event.
  const source = await readFile(path, "utf8");
  const jiti = createJiti(pathToFileURL(path).href, { interopDefault: true, moduleCache: false });
  const loaded: unknown = await jiti.import(path, { default: true });
  if (!isConfig(loaded)) throw new Error(`Invalid tokenc config: ${path}`);
  return { config: { ...loaded, cwd: dirname(path) }, path, source };
}

/** Load a TypeScript or ESM tokenc configuration. */
export async function loadConfig(cwd: string, explicit?: string): Promise<CompilerConfig> {
  return (await loadConfigFile(cwd, explicit)).config;
}

/** Render one structured compiler diagnostic as a terminal-friendly code frame. */
export function renderDiagnostic(diagnostic: Diagnostic, cwd = process.cwd()): string {
  const lines: string[] = [];
  if (diagnostic.source) {
    const file = isAbsolute(diagnostic.source.document)
      ? relative(cwd, diagnostic.source.document)
      : diagnostic.source.document;
    lines.push(`${file}:${diagnostic.source.range.line}:${diagnostic.source.range.column}`, "");
    if (diagnostic.source.excerpt !== undefined) {
      const gutter = String(diagnostic.source.range.line);
      const caretLength = Math.max(
        1,
        Math.min(
          diagnostic.source.range.length,
          diagnostic.source.excerpt.length - diagnostic.source.range.column + 2,
        ),
      );
      lines.push(
        `${gutter} │ ${diagnostic.source.excerpt}`,
        `${" ".repeat(gutter.length)} │ ${" ".repeat(diagnostic.source.range.column - 1)}${"^".repeat(caretLength)}`,
        "  │",
      );
    }
  }
  const marker =
    diagnostic.severity === "error" ? "×" : diagnostic.severity === "warning" ? "▲" : "●";
  lines.push(`${marker} ${diagnostic.message}`);
  for (const related of diagnostic.related) {
    const location = related.source
      ? ` (${relative(cwd, related.source.document)}:${related.source.range.line}:${related.source.range.column})`
      : "";
    lines.push(`  └─ ${related.message}${location}`);
  }
  return lines.join("\n");
}

function contextFromFlags(
  config: CompilerConfig,
  flags: ReadonlyMap<string, string | true>,
): CompilationContext {
  const context: Record<string, string> = {};
  for (const name of Object.keys(config.contexts ?? {})) {
    const value = flags.get(name);
    if (typeof value === "string") context[name] = value;
  }
  return context;
}

function displayLiteral(value: TokenLiteral): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (
    value !== null &&
    typeof value === "object" &&
    "colorSpace" in value &&
    "hex" in value &&
    typeof value.hex === "string"
  )
    return value.hex;
  if (
    value !== null &&
    typeof value === "object" &&
    "colorSpace" in value &&
    value.colorSpace === "oklch" &&
    "components" in value &&
    Array.isArray(value.components) &&
    value.components.every((component) => typeof component === "number")
  )
    return `oklch(${value.components.map(String).join(" ")})`;
  if (
    value !== null &&
    typeof value === "object" &&
    "unit" in value &&
    typeof value.unit === "string" &&
    "value" in value &&
    typeof value.value === "number"
  )
    return `${value.value}${value.unit}`;
  return JSON.stringify(value);
}

function applyResolverFlags(
  config: CompilerConfig,
  flags: ReadonlyMap<string, string | true>,
): CompilerConfig {
  if (!config.resolver) return config;
  const ignored = new Set([
    "base",
    "config",
    "context",
    "debug",
    "format",
    "head",
    "json",
    "policy",
  ]);
  const input: Record<string, string> = { ...config.resolver.input };
  for (const [name, value] of flags)
    if (!ignored.has(name) && typeof value === "string") input[name] = value;
  return { ...config, resolver: { ...config.resolver, input } };
}

function printDiagnostics(diagnostics: readonly Diagnostic[], io: CliIO, json: boolean): void {
  if (json) {
    io.stdout(
      JSON.stringify(
        {
          schemaVersion: "1",
          diagnostics,
        },
        null,
        2,
      ),
    );
  } else {
    for (const diagnostic of diagnostics) io.stderr(`${renderDiagnostic(diagnostic, io.cwd)}\n`);
  }
}

async function loadAndCompile(
  parsed: ParsedArguments,
  io: CliIO,
  backendMode: "emit" | "validate" | "none",
): Promise<{
  config: CompilerConfig;
  snapshot: CompilationSnapshot;
  operation?: BackendPreparationResult | BackendEmissionResult;
}> {
  const explicit = parsed.flags.get("config");
  const config = applyResolverFlags(
    await loadConfig(io.cwd, typeof explicit === "string" ? explicit : undefined),
    parsed.flags,
  );
  const loader = new FileSystemDocumentLoader(config.cwd ?? io.cwd);
  const [sources, semanticConfig] = await Promise.all([
    loadTokenFiles(config.source, config.cwd),
    sessionConfiguration(config, loader),
  ]);
  const session = createCompilerSession({ loader, config: semanticConfig });
  try {
    const snapshot = await session.apply({
      documents: sources.map((source) => ({
        kind: "add",
        document: { identity: source.file, content: source.content },
      })),
    });
    if (snapshot.status === "invalid" || backendMode === "none") return { config, snapshot };
    const operation =
      backendMode === "emit"
        ? await snapshot.emit(config.outputs ?? [])
        : await snapshot.prepare(config.outputs ?? []);
    return { config, snapshot, operation };
  } finally {
    await session.close();
  }
}

async function buildCommand(parsed: ParsedArguments, io: CliIO): Promise<number> {
  const { config, snapshot, operation } = await loadAndCompile(parsed, io, "emit");
  const diagnostics = [...snapshot.diagnostics, ...(operation?.diagnostics ?? [])];
  const json = parsed.flags.has("json");
  printDiagnostics(diagnostics, io, json);
  if (snapshot.status === "invalid" || !operation?.success || !("outputs" in operation)) {
    if (!json)
      io.stderr(
        `✗ Compilation failed with ${diagnostics.filter((item) => item.severity === "error").length} errors\n`,
      );
    return 1;
  }
  await writeOutputs(config, operation.outputs, io);
  if (!json) {
    io.stdout(
      `✓ ${snapshot.stats.tokens} tokens parsed\n✓ ${snapshot.stats.references} references checked\n✓ ${operation.outputs.length} outputs generated\n`,
    );
    for (const output of operation.outputs) io.stdout(`${output.path}\n`);
    if (parsed.flags.has("debug"))
      io.stdout(`${JSON.stringify(snapshot.stats.timings, null, 2)}\n`);
  }
  return 0;
}

async function writeOutputs(
  config: CompilerConfig,
  outputs: readonly OutputFile[],
  io: CliIO,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  await Promise.all(
    outputs.map(async (output) => {
      const path = resolve(config.cwd ?? io.cwd, output.path);
      await mkdir(dirname(path), { recursive: true });
      signal?.throwIfAborted();
      await writeFile(path, output.content, { encoding: "utf8", signal });
    }),
  );
  signal?.throwIfAborted();
}

async function checkCommand(parsed: ParsedArguments, io: CliIO): Promise<number> {
  const rawFormat = parsed.flags.has("json") ? "json" : (parsed.flags.get("format") ?? "text");
  if (rawFormat !== "text" && rawFormat !== "json" && rawFormat !== "sarif") {
    io.stderr(`Unsupported check format: ${String(rawFormat)}\n`);
    return 1;
  }
  const format: ReportFormat = rawFormat;
  const { config, snapshot, operation } = await loadAndCompile(parsed, io, "validate");
  const diagnostics = [...snapshot.diagnostics, ...(operation?.diagnostics ?? [])];
  const report = createCheckReport({
    root: config.cwd ?? io.cwd,
    tokens: snapshot.stats.tokens,
    references: snapshot.stats.references,
    success: snapshot.status === "valid" && operation?.success === true,
    diagnostics,
  });
  io.stdout(renderReport(report, format));
  return report.verdict === "pass" ? 0 : 1;
}

async function explainCommand(parsed: ParsedArguments, io: CliIO): Promise<number> {
  const input = parsed.positionals[0];
  if (!input) {
    io.stderr("tokenc explain requires a token ID\n");
    return 1;
  }
  const { config, snapshot } = await loadAndCompile(parsed, io, "none");
  if (snapshot.status === "invalid") {
    printDiagnostics(snapshot.diagnostics, io, false);
    return 1;
  }
  let id: TokenId;
  try {
    id = parseTokenId(input);
  } catch {
    io.stderr(`Invalid token ID: ${input}\n`);
    return 1;
  }
  const token = snapshot.query.token(id);
  if (!token) {
    io.stderr(`Unknown token: ${id}\n`);
    return 1;
  }
  const context = snapshot.query.context(contextFromFlags(config, parsed.flags));
  const trace = snapshot.query.explain(id, context);
  if (!trace) {
    io.stderr(`Unable to resolve token: ${id}\n`);
    return 1;
  }
  if (parsed.flags.has("json")) {
    io.stdout(JSON.stringify(trace, null, 2));
    return 0;
  }
  const lines = [`Explain trace v1: ${id}`];
  let depth = 0;
  for (const step of trace.steps) {
    depth += 1;
    if (step.expression.kind === "reference") {
      lines.push(
        `${"   ".repeat(depth - 1)}└─ ${step.expression.pointer ? `JSON Pointer ${step.expression.pointer} → ` : ""}${step.expression.target}`,
      );
    } else if (step.expression.kind === "json-pointer-reference") {
      lines.push(
        `${"   ".repeat(depth - 1)}└─ JSON Pointer ${step.expression.pointer} → ${step.expression.target}`,
      );
      lines.push(`${"   ".repeat(depth)}└─ ${displayLiteral(step.expression.value)}`);
    } else {
      lines.push(`${"   ".repeat(depth - 1)}└─ ${displayLiteral(step.expression.value)}`);
    }
  }
  const impact = snapshot.query.impact([id], { context });
  const dependentCount = impact.directlyAffected.length + impact.indirectlyAffected.length;
  const resolutionLines = [
    ...trace.resolverSteps.map((step) =>
      step.kind === "modifier" ? `${step.name}.${step.context ?? "default"}` : step.name,
    ),
    ...trace.steps.flatMap((step) =>
      step.selection === "override" && step.selector
        ? [
            Object.entries(step.selector)
              .map(([name, value]) => `${name}.${value}`)
              .join(" & "),
          ]
        : [],
    ),
  ];
  const resolvedThrough = trace.steps
    .slice(1)
    .map(
      (step) =>
        `${relative(config.cwd ?? io.cwd, step.source.file)}:${step.source.line}:${step.source.column}`,
    );
  lines.push(
    "",
    `Type:\n  ${token.type}`,
    "",
    `Context:\n${
      Object.entries(trace.context)
        .map(([name, value]) => `  ${name} = ${value}`)
        .join("\n") || "  default"
    }`,
    ...(resolutionLines.length > 0 ? ["", `Resolution:\n  ${resolutionLines.join("\n  → ")}`] : []),
    "",
    `Defined at:\n  ${relative(config.cwd ?? io.cwd, token.source.file)}:${token.source.line}:${token.source.column}`,
    ...(token.inheritance
      ? [
          "",
          `Inherited from:\n  ${token.inheritance.token}\n\nBase group:\n  ${token.inheritance.group}`,
        ]
      : []),
    ...(resolvedThrough.length > 0
      ? ["", `Resolved through:\n${resolvedThrough.map((location) => `  ${location}`).join("\n")}`]
      : []),
    "",
    `Dependencies:\n  ${snapshot.query.dependencies(id, { context }).length}`,
    "",
    `Reverse dependencies:\n  ${dependentCount}`,
  );
  io.stdout(`${lines.join("\n")}\n`);
  return 0;
}

function usagesSection(title: string, values: readonly TokenId[]): string {
  return `${title}:\n\n${
    values.length
      ? values
          .map((value, index) => `${index === values.length - 1 ? "└─" : "├─"} ${value}`)
          .join("\n")
      : "(none)"
  }`;
}

async function usagesCommand(parsed: ParsedArguments, io: CliIO): Promise<number> {
  const input = parsed.positionals[0];
  if (!input) {
    io.stderr("tokenc usages requires a token ID\n");
    return 1;
  }
  const { config, snapshot } = await loadAndCompile(parsed, io, "none");
  if (snapshot.status === "invalid") {
    printDiagnostics(snapshot.diagnostics, io, false);
    return 1;
  }
  let id: TokenId;
  try {
    id = parseTokenId(input);
  } catch {
    io.stderr(`Invalid token ID: ${input}\n`);
    return 1;
  }
  if (!snapshot.query.token(id)) {
    io.stderr(`Unknown token: ${id}\n`);
    return 1;
  }
  const requestedContext = contextFromFlags(config, parsed.flags);
  const region =
    Object.keys(requestedContext).length > 0
      ? {
          context: snapshot.query.context(requestedContext),
        }
      : {};
  const usageEdges = snapshot.query.usages(id, region);
  const impact = snapshot.query.impact([id], region);
  const direct = impact.directlyAffected.map((entry) => entry.token);
  const indirect = impact.indirectlyAffected.map((entry) => entry.token);
  if (parsed.flags.has("json")) {
    io.stdout(
      JSON.stringify({ schemaVersion: "1", token: id, usages: usageEdges, impact }, null, 2),
    );
    return 0;
  }
  io.stdout(
    `Usages v1: ${id}\n\n${usagesSection("Direct usages", direct)}\n\n${usagesSection("Indirect usages", indirect)}\n\n${direct.length + indirect.length} total dependent tokens\n`,
  );
  return 0;
}

function impactContext(filters: readonly string[]): CompilationContext {
  const context: Record<string, string> = {};
  for (const filter of filters) {
    const separator = filter.indexOf("=");
    const name = filter.slice(0, separator);
    const value = filter.slice(separator + 1);
    if (separator <= 0 || value.length === 0)
      throw new TypeError(`Invalid Context filter: ${filter || "(missing value)"}`);
    if (Object.hasOwn(context, name) && context[name] !== value)
      throw new TypeError(`Conflicting Context filters for \`${name}\``);
    context[name] = value;
  }
  return Object.freeze(context);
}

function canonicalImpactDocument(
  input: string,
  root: string,
  snapshot: CompilationSnapshot,
): string {
  const absolute = resolve(root, input);
  const known = snapshot.documents.find(
    (document) => resolve(process.cwd(), document.identity) === absolute,
  );
  return known?.identity ?? relative(process.cwd(), absolute).split(sep).join("/");
}

function impactEntries(title: string, entries: ImpactReportV1["impact"]["changed"]): string {
  if (entries.length === 0) return `${title}:\n\n(none)`;
  return `${title}:\n\n${entries
    .map(
      (entry, index) =>
        `${index === entries.length - 1 ? "└─" : "├─"} ${entry.token} [${entry.condition.key}]`,
    )
    .join("\n")}`;
}

function renderImpactReport(report: ImpactReportV1, root: string): string {
  const sources = report.request.sources
    .map((source, index) => {
      const marker = source.status === "matched" ? "✓" : source.status === "empty" ? "○" : "?";
      const display = relative(root, resolve(process.cwd(), source.document)) || ".";
      const detail =
        source.status === "matched"
          ? `${source.tokens.length} Token${source.tokens.length === 1 ? "" : "s"}`
          : source.status === "empty"
            ? "no Tokens"
            : "unknown source";
      return `${index === report.request.sources.length - 1 ? "└─" : "├─"} ${marker} ${display} — ${detail}`;
    })
    .join("\n");
  return [
    "Impact Report v1",
    `Status: ${report.status}`,
    "",
    `Sources:\n\n${sources || "(none)"}`,
    "",
    impactEntries("Directly changed", report.impact.changed),
    "",
    impactEntries("Directly affected", report.impact.directlyAffected),
    "",
    impactEntries("Transitively affected", report.impact.indirectlyAffected),
  ].join("\n");
}

async function impactCommand(parsed: ParsedArguments, io: CliIO): Promise<number> {
  if (parsed.positionals.length === 0) {
    io.stderr("tokenc impact requires at least one source path\n");
    return 1;
  }
  const format = parsed.flags.has("json") ? "json" : (parsed.flags.get("format") ?? "text");
  if (format !== "text" && format !== "json") {
    io.stderr(`Unsupported impact format: ${String(format)}\n`);
    return 1;
  }
  let context: CompilationContext;
  try {
    context = impactContext(parsed.contextFilters);
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const { config, snapshot } = await loadAndCompile(parsed, io, "none");
  const root = config.cwd ?? io.cwd;
  const documents = parsed.positionals.map((input) =>
    canonicalImpactDocument(input, root, snapshot),
  );
  const report = buildImpactReport(snapshot, {
    documents,
    ...(Object.keys(context).length > 0 ? { context } : {}),
  });
  if (format === "json") io.stdout(serializeImpactReport(report));
  else {
    io.stdout(`${renderImpactReport(report, root)}\n`);
    for (const entry of report.diagnostics)
      io.stderr(`${renderDiagnostic(entry.diagnostic, root)}\n`);
  }
  return report.status === "complete" ? 0 : 2;
}

const CONFIG_CHANGED_DIAGNOSTIC = "dev.tokenc.cli/GIT_CONFIG_CHANGED";

function configurationDiagnostic(config: string, detail: string): Diagnostic {
  if (!diagnosticCodeRegistry().some((entry) => entry.code === CONFIG_CHANGED_DIAGNOSTIC))
    registerDiagnosticCode({
      code: CONFIG_CHANGED_DIAGNOSTIC,
      stage: "session",
      defaultSeverity: "error",
      parameters: { config: { identity: true, required: true } },
      documentationUrl:
        "https://github.com/Seeridia/tokenc/blob/main/docs/rfcs/0004-change-intelligence.md#7-git-and-configuration-stay-outside-core",
      fixesAllowed: false,
      suppressible: false,
    });
  return createDiagnostic({
    code: CONFIG_CHANGED_DIAGNOSTIC,
    message: detail,
    parameters: { config },
  });
}

async function compileGitView(
  config: CompilerConfig,
  provider: GitRevisionProvider,
  view: GitSourceView,
): Promise<CompilationSnapshot> {
  const root = config.cwd ?? provider.root;
  const directory = provider.repositoryDirectory(root);
  const loader = scopedGitDocumentLoader(view, directory);
  const [sources, semanticConfig] = await Promise.all([
    view.sources(provider.patterns(root, config.source)),
    sessionConfiguration(config, loader),
  ]);
  const session = createCompilerSession({ loader, config: semanticConfig });
  try {
    return await session.apply({
      documents: sources.map((source) => ({ kind: "add", document: source })),
    });
  } finally {
    await session.close();
  }
}

function markConfigurationUnavailable(
  diff: SnapshotDiffV1,
  config: string,
  detail: string,
): SnapshotDiffV1 {
  const omissions = Object.freeze([
    ...diff.coverage.omitted,
    ...diff.coverage.requested.map((predicate) =>
      Object.freeze({
        predicate,
        reason: "configuration-unavailable" as const,
        detail,
      }),
    ),
  ]);
  return Object.freeze({
    ...diff,
    status: "incomplete",
    coverage: Object.freeze({
      ...diff.coverage,
      compared: Object.freeze([]),
      omitted: omissions,
    }),
    diagnostics: Object.freeze([
      ...diff.diagnostics,
      Object.freeze({
        side: "comparison" as const,
        diagnostic: configurationDiagnostic(config, detail),
      }),
    ]),
  });
}

async function diffCommand(parsed: ParsedArguments, io: CliIO): Promise<number> {
  const baseInput = parsed.flags.get("base");
  if (typeof baseInput !== "string" || baseInput.length === 0) {
    io.stderr("tokenc diff requires --base <ref>\n");
    return 1;
  }
  const headInput = parsed.flags.get("head") ?? "worktree";
  if (typeof headInput !== "string" || headInput.length === 0) {
    io.stderr("tokenc diff requires a value for --head\n");
    return 1;
  }
  const rawFormat = parsed.flags.has("json") ? "json" : (parsed.flags.get("format") ?? "text");
  if (rawFormat !== "text" && rawFormat !== "json" && rawFormat !== "sarif") {
    io.stderr(`Unsupported diff format: ${String(rawFormat)}\n`);
    return 1;
  }
  const format: ReportFormat = rawFormat;
  let context: CompilationContext;
  try {
    context = impactContext(parsed.contextFilters);
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const policyInput = parsed.flags.get("policy");
  if (policyInput === true) {
    io.stderr("tokenc diff requires a value for --policy\n");
    return 1;
  }
  let policy: unknown;
  if (typeof policyInput === "string") {
    const policyPath = resolve(io.cwd, policyInput);
    try {
      policy = JSON.parse(await readFile(policyPath, "utf8"));
    } catch (error) {
      io.stderr(
        `Cannot load breaking-change policy ${policyInput}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 2;
    }
  }

  try {
    const explicit = parsed.flags.get("config");
    const loaded = await loadConfigFile(
      io.cwd,
      typeof explicit === "string" ? explicit : undefined,
    );
    const config = applyResolverFlags(loaded.config, parsed.flags);
    const provider = await GitRevisionProvider.open(config.cwd ?? io.cwd);
    const baseView = await provider.revision(baseInput);
    const headView =
      headInput === "worktree" ? provider.worktree() : await provider.revision(headInput);
    const [base, head] = await Promise.all([
      compileGitView(config, provider, baseView),
      compileGitView(config, provider, headView),
    ]);
    const reportContext = Object.keys(context).length > 0 ? context : undefined;
    let report = await compareSnapshots(base, head, {
      baseLabel: baseInput,
      headLabel: headInput,
      ...(reportContext ? { context: reportContext } : {}),
      ...(config.outputs?.length
        ? {
            backends: config.outputs.map((backend) => ({
              id: backend.id,
              base: backend,
            })),
          }
        : {}),
    });

    if (typeof explicit !== "string") {
      const configPath = provider.repositoryPath(loaded.path);
      const [baseConfig, headConfig] = await Promise.all([
        baseView.readOptional(configPath),
        headView.readOptional(configPath),
      ]);
      const unavailable = [
        ...(baseConfig?.content === loaded.source
          ? []
          : [`${baseInput} does not contain the trusted current configuration`]),
        ...(headConfig?.content === loaded.source
          ? []
          : [`${headInput} does not contain the trusted current configuration`]),
      ];
      if (unavailable.length > 0)
        report = markConfigurationUnavailable(report, configPath, unavailable.join("; "));
    }

    const evaluation = policy === undefined ? undefined : evaluateSnapshotPolicy(report, policy);
    const output = createDiffReport(report, provider.root, evaluation);
    io.stdout(renderReport(output, format));
    return output.verdict === "incomplete" ? 2 : output.verdict === "fail" ? 1 : 0;
  } catch (error) {
    if (error instanceof GitRevisionError) {
      io.stderr(`${error.code}: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
}

function dependencyTree(snapshot: CompilationSnapshot, id: TokenId): readonly string[] {
  const lines: string[] = [String(id)];
  const visit = (current: TokenId, depth: number, seen: ReadonlySet<TokenId>): void => {
    for (const dependency of new Set(snapshot.query.dependencies(current).map((edge) => edge.to))) {
      const cycle = seen.has(dependency);
      lines.push(`${"   ".repeat(depth)}└─ ${dependency}${cycle ? " (cycle)" : ""}`);
      if (!cycle) visit(dependency, depth + 1, new Set(seen).add(dependency));
    }
  };
  visit(id, 0, new Set([id]));
  return lines;
}

async function graphCommand(parsed: ParsedArguments, io: CliIO): Promise<number> {
  const { config, snapshot } = await loadAndCompile(parsed, io, "none");
  if (snapshot.status === "invalid") {
    printDiagnostics(snapshot.diagnostics, io, false);
    return 1;
  }
  const input = parsed.positionals[0];
  const root = input ? parseTokenId(input) : undefined;
  if (root && !snapshot.query.token(root)) {
    io.stderr(`Unknown token: ${root}\n`);
    return 1;
  }
  const requestedContext = contextFromFlags(config, parsed.flags);
  const region =
    Object.keys(requestedContext).length > 0
      ? {
          context: snapshot.query.context(requestedContext),
        }
      : {};
  const edges = snapshot.query.graph(root ? [root] : undefined, region);
  if (parsed.flags.has("json")) {
    io.stdout(JSON.stringify({ schemaVersion: "1", roots: root ? [root] : [], edges }, null, 2));
    return 0;
  }
  if (parsed.flags.get("format") === "mermaid") {
    const lines = edges.map(
      (edge) => `  ${JSON.stringify(String(edge.to))} --> ${JSON.stringify(String(edge.from))}`,
    );
    io.stdout(`%% tokenc dependency graph v1\ngraph TD\n${lines.join("\n")}\n`);
  } else if (root) io.stdout(`Dependency graph v1\n${dependencyTree(snapshot, root).join("\n")}\n`);
  else
    io.stdout(
      `Dependency graph v1\n${edges.map((edge) => `${edge.from} -> ${edge.to} [${edge.condition.key}]`).join("\n")}\n`,
    );
  return 0;
}

async function devCommand(parsed: ParsedArguments, io: CliIO): Promise<number> {
  const explicit = parsed.flags.get("config");
  const configPath = typeof explicit === "string" ? explicit : undefined;
  let loadedConfig = await loadConfigFile(io.cwd, configPath);
  let config = applyResolverFlags(loadedConfig.config, parsed.flags);
  const sources = await loadTokenFiles(config.source, config.cwd);
  let contents = new Map(sources.map((source) => [source.file, source.content]));
  const loader = new FileSystemDocumentLoader(config.cwd ?? io.cwd);
  const session = createCompilerSession({
    loader,
    config: await sessionConfiguration(config, loader),
  });
  let initial = await session.apply({
    documents: sources.map((source) => ({
      kind: "add",
      document: { identity: source.file, content: source.content },
    })),
  });
  let initialEmission =
    initial.status === "valid" ? await initial.emit(config.outputs ?? []) : undefined;
  let generatedFiles = outputPaths(config, initialEmission?.outputs ?? [], io);
  if (initial.status === "valid" && initialEmission?.success) {
    await writeOutputs(config, initialEmission.outputs, io);
    io.stdout(`✓ ${initial.stats.tokens} tokens compiled\n✓ watching ${config.cwd ?? io.cwd}\n`);
  } else
    printDiagnostics([...initial.diagnostics, ...(initialEmission?.diagnostics ?? [])], io, false);

  const root = config.cwd ?? io.cwd;
  const watcher = watch(root, {
    ignoreInitial: true,
    ignored: (path) => /(?:^|\/)(?:node_modules|dist|\.git)(?:\/|$)/u.test(path),
    awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 10 },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let configGeneration = 0;
  let appliedConfigGeneration = 0;
  const runner = new LatestTaskRunner((error) => {
    io.stderr(
      `${error instanceof Error ? error.message : String(error)}\n✗ waiting for a valid edit\n`,
    );
  });
  const rebuild = (): void => {
    runner.schedule(async (signal) => {
      const nextLoadedConfig = await loadConfigFile(io.cwd, configPath);
      signal.throwIfAborted();
      const nextConfig = applyResolverFlags(nextLoadedConfig.config, parsed.flags);
      const requestedConfigGeneration = configGeneration;
      const configChanged =
        requestedConfigGeneration !== appliedConfigGeneration ||
        configFileChanged(loadedConfig, nextLoadedConfig) ||
        JSON.stringify({ source: config.source, contexts: config.contexts }) !==
          JSON.stringify({ source: nextConfig.source, contexts: nextConfig.contexts });
      const nextSources = await loadTokenFiles(nextConfig.source, nextConfig.cwd, signal);
      const nextContents = new Map(nextSources.map((source) => [source.file, source.content]));
      const documentChanges: DocumentChange[] = [];
      for (const file of contents.keys())
        if (!nextContents.has(file)) documentChanges.push({ kind: "remove", identity: file });
      for (const source of nextSources) {
        const previousContent = contents.get(source.file);
        if (previousContent === source.content) continue;
        documentChanges.push({
          kind: previousContent === undefined ? "add" : "update",
          document: { identity: source.file, content: source.content },
        });
      }
      if (configChanged) {
        const nextSemanticConfig = await sessionConfiguration(nextConfig, loader, signal);
        const nextSnapshot = await session.apply(
          { documents: documentChanges, config: nextSemanticConfig },
          { signal },
        );
        config = nextConfig;
        contents = nextContents;
        loadedConfig = nextLoadedConfig;
        appliedConfigGeneration = requestedConfigGeneration;
        const nextEmission =
          nextSnapshot.status === "valid"
            ? await nextSnapshot.emit(config.outputs ?? [])
            : undefined;
        generatedFiles = outputPaths(config, nextEmission?.outputs ?? [], io);
        if (nextSnapshot.status === "valid" && nextEmission?.success)
          await writeOutputs(config, nextEmission.outputs, io, signal);
        else
          printDiagnostics(
            [...nextSnapshot.diagnostics, ...(nextEmission?.diagnostics ?? [])],
            io,
            false,
          );
        io.stdout(`✓ config reloaded\n`);
        return;
      }
      if (documentChanges.length === 0) return;
      const latest = await session.apply({ documents: documentChanges }, { signal });
      config = nextConfig;
      contents = nextContents;
      if (latest.status === "invalid") {
        printDiagnostics(latest.diagnostics, io, false);
        io.stderr("✗ waiting for a valid edit\n");
        return;
      }
      const emission = await latest.emit(config.outputs ?? []);
      if (!emission.success) {
        printDiagnostics([...latest.diagnostics, ...emission.diagnostics], io, false);
        io.stderr("✗ waiting for a valid edit\n");
        return;
      }
      generatedFiles = outputPaths(config, emission.outputs, io);
      await writeOutputs(config, emission.outputs, io, signal);
      io.stdout(
        `\n✓ ${documentChanges.length} document${documentChanges.length === 1 ? "" : "s"} changed\n✓ ${latest.stats.tokens} tokens compiled\n${emission.outputs.map((output) => `✓ ${output.path} updated`).join("\n")}\n`,
      );
    });
  };
  watcher.on("all", (_event, path) => {
    if (
      shouldReloadConfigForEvent(path, {
        configPath: loadedConfig.path,
        tokenPaths: new Set(contents.keys()),
        outputPaths: generatedFiles,
        watchRoot: root,
      })
    )
      configGeneration += 1;
    if (timer) clearTimeout(timer);
    timer = setTimeout(rebuild, 75);
  });
  watcher.on("error", (error) => io.stderr(`Watcher error: ${String(error)}\n`));
  return new Promise<number>((finish) => {
    const stop = (): void => {
      if (timer) clearTimeout(timer);
      void (async () => {
        await runner.close();
        await watcher.close();
        await session.close();
        finish(0);
      })();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

const HELP = `tokenc — DTCG-native design token compiler

Usage:
  tokenc build [--config path] [--debug]
  tokenc check [--config path] [--format text|json|sarif]
  tokenc dev [--config path]
  tokenc explain <token> [--json] [--theme dark]
  tokenc usages <token> [--json] [--theme dark]
  tokenc graph [token] [--json | --format mermaid] [--theme dark]
  tokenc impact <source...> [--context name=value] [--format text|json]
  tokenc diff --base <ref> [--head <ref|worktree>] [--policy path] [--format text|json|sarif]
`;

/** Run the CLI with injectable IO for integration tests. */
export async function runCli(args: readonly string[], io: CliIO): Promise<number> {
  const parsed = parseArguments(args);
  try {
    if (parsed.command === "build") return await buildCommand(parsed, io);
    if (parsed.command === "check") return await checkCommand(parsed, io);
    if (parsed.command === "explain") return await explainCommand(parsed, io);
    if (parsed.command === "usages") return await usagesCommand(parsed, io);
    if (parsed.command === "graph") return await graphCommand(parsed, io);
    if (parsed.command === "impact") return await impactCommand(parsed, io);
    if (parsed.command === "diff") return await diffCommand(parsed, io);
    if (parsed.command === "dev") return await devCommand(parsed, io);
    if (parsed.command === "help" || parsed.command === "--help") {
      io.stdout(HELP);
      return 0;
    }
    io.stderr(`Unknown command: ${parsed.command}\n\n${HELP}`);
    return 1;
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
