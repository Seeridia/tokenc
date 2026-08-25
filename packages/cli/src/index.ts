import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  compile,
  defaultContext,
  IncrementalCompiler,
  loadTokenFiles,
  parseTokenId,
  type CompilationContext,
  type CompilationResult,
  type CompileDocumentsOptions,
  type CompilerConfig,
  type Diagnostic,
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

export const CLI_NAME = "tokenc";

export interface CliIO {
  readonly cwd: string;
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
}

function incrementalOptions(config: CompilerConfig, io: CliIO): CompileDocumentsOptions {
  return {
    ...(config.contexts ? { contexts: config.contexts } : {}),
    ...(config.outputs ? { outputs: config.outputs } : {}),
    outputRoot: config.cwd ?? io.cwd,
  };
}

function outputPaths(
  config: CompilerConfig,
  result: CompilationResult,
  io: CliIO,
): ReadonlySet<string> {
  return new Set(result.outputs.map((output) => resolve(config.cwd ?? io.cwd, output.path)));
}

interface ParsedArguments {
  readonly command: string;
  readonly positionals: readonly string[];
  readonly flags: ReadonlyMap<string, string | true>;
}

function parseArguments(args: readonly string[]): ParsedArguments {
  const command = args[0] && !args[0].startsWith("-") ? args[0] : "help";
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument) continue;
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const [rawName, inline] = argument.slice(2).split("=", 2);
    if (!rawName) continue;
    if (inline !== undefined) flags.set(rawName, inline);
    else if (args[index + 1] && !args[index + 1]!.startsWith("--")) {
      flags.set(rawName, args[index + 1]!);
      index += 1;
    } else flags.set(rawName, true);
  }
  return { command, positionals, flags };
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

function diagnosticJson(diagnostic: Diagnostic): object {
  return {
    code: diagnostic.code,
    severity: diagnostic.severity,
    message: diagnostic.message,
    ...(diagnostic.source
      ? {
          file: diagnostic.source.file,
          line: diagnostic.source.line,
          column: diagnostic.source.column,
        }
      : {}),
    ...(diagnostic.related ? { related: diagnostic.related } : {}),
    ...(diagnostic.suggestions ? { suggestions: diagnostic.suggestions } : {}),
  };
}

/** Render one structured compiler diagnostic as a terminal-friendly code frame. */
export function renderDiagnostic(diagnostic: Diagnostic, cwd = process.cwd()): string {
  const lines: string[] = [];
  if (diagnostic.source) {
    const file = isAbsolute(diagnostic.source.file)
      ? relative(cwd, diagnostic.source.file)
      : diagnostic.source.file;
    lines.push(`${file}:${diagnostic.source.line}:${diagnostic.source.column}`, "");
    if (diagnostic.source.excerpt !== undefined) {
      const gutter = String(diagnostic.source.line);
      const caretLength = Math.max(
        1,
        Math.min(
          diagnostic.source.length,
          diagnostic.source.excerpt.length - diagnostic.source.column + 2,
        ),
      );
      lines.push(
        `${gutter} │ ${diagnostic.source.excerpt}`,
        `${" ".repeat(gutter.length)} │ ${" ".repeat(diagnostic.source.column - 1)}${"^".repeat(caretLength)}`,
        "  │",
      );
    }
  }
  const marker =
    diagnostic.severity === "error" ? "×" : diagnostic.severity === "warning" ? "▲" : "●";
  lines.push(`${marker} ${diagnostic.message}`);
  for (const suggestion of diagnostic.suggestions ?? [])
    lines.push(`  └─ Did you mean \`${suggestion}\`?`);
  for (const related of diagnostic.related ?? []) {
    const location = related.source
      ? ` (${relative(cwd, related.source.file)}:${related.source.line}:${related.source.column})`
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
  const ignored = new Set(["config", "json", "debug", "format"]);
  const input: Record<string, string> = { ...config.resolver.input };
  for (const [name, value] of flags)
    if (!ignored.has(name) && typeof value === "string") input[name] = value;
  return { ...config, resolver: { ...config.resolver, input } };
}

function printDiagnostics(result: CompilationResult, io: CliIO, json: boolean): void {
  if (json) {
    io.stdout(
      JSON.stringify(
        {
          errors: result.diagnostics
            .filter((item) => item.severity === "error")
            .map(diagnosticJson),
          diagnostics: result.diagnostics.map(diagnosticJson),
        },
        null,
        2,
      ),
    );
  } else {
    for (const diagnostic of result.diagnostics)
      io.stderr(`${renderDiagnostic(diagnostic, io.cwd)}\n`);
  }
}

async function loadAndCompile(
  parsed: ParsedArguments,
  io: CliIO,
  backendMode: "emit" | "validate" | "none",
): Promise<{ config: CompilerConfig; result: CompilationResult }> {
  const explicit = parsed.flags.get("config");
  const config = applyResolverFlags(
    await loadConfig(io.cwd, typeof explicit === "string" ? explicit : undefined),
    parsed.flags,
  );
  const compilationConfig = backendMode === "none" ? { ...config, outputs: [] } : config;
  const result = await compile(compilationConfig, { emit: backendMode === "emit" });
  return { config, result };
}

async function buildCommand(parsed: ParsedArguments, io: CliIO): Promise<number> {
  const { config, result } = await loadAndCompile(parsed, io, "emit");
  const json = parsed.flags.has("json");
  printDiagnostics(result, io, json);
  if (!result.success) {
    if (!json)
      io.stderr(
        `✗ Compilation failed with ${result.diagnostics.filter((item) => item.severity === "error").length} errors\n`,
      );
    return 1;
  }
  await writeOutputs(config, result, io);
  if (!json) {
    io.stdout(
      `✓ ${result.stats.tokens} tokens parsed\n✓ ${result.stats.references} references checked\n✓ ${result.outputs.length} outputs generated\n`,
    );
    for (const output of result.outputs) io.stdout(`${output.path}\n`);
    if (parsed.flags.has("debug")) io.stdout(`${JSON.stringify(result.stats.timings, null, 2)}\n`);
  }
  return 0;
}

async function writeOutputs(
  config: CompilerConfig,
  result: CompilationResult,
  io: CliIO,
): Promise<void> {
  await Promise.all(
    result.outputs.map(async (output) => {
      const path = resolve(config.cwd ?? io.cwd, output.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, output.content, "utf8");
    }),
  );
}

async function checkCommand(parsed: ParsedArguments, io: CliIO): Promise<number> {
  const { result } = await loadAndCompile(parsed, io, "validate");
  const json = parsed.flags.has("json");
  printDiagnostics(result, io, json);
  if (!result.success) {
    if (!json)
      io.stderr(
        `✗ Compilation failed with ${result.diagnostics.filter((item) => item.severity === "error").length} errors\n`,
      );
    return 1;
  }
  if (!json)
    io.stdout(
      `✓ ${result.stats.tokens} tokens checked\n✓ ${result.stats.references} references\n✓ no errors\n`,
    );
  return 0;
}

async function explainCommand(parsed: ParsedArguments, io: CliIO): Promise<number> {
  const input = parsed.positionals[0];
  if (!input) {
    io.stderr("tokenc explain requires a token ID\n");
    return 1;
  }
  const { config, result } = await loadAndCompile(parsed, io, "none");
  if (!result.success) {
    printDiagnostics(result, io, false);
    return 1;
  }
  let id: TokenId;
  try {
    id = parseTokenId(input);
  } catch {
    io.stderr(`Invalid token ID: ${input}\n`);
    return 1;
  }
  const token = result.graph.getToken(id);
  if (!token) {
    io.stderr(`Unknown token: ${id}\n`);
    return 1;
  }
  const context = {
    ...defaultContext(result.compilation.contexts),
    ...result.compilation.resolution?.context,
    ...contextFromFlags(config, parsed.flags),
  };
  const trace = result.compilation.explainToken(id, context);
  if (!trace) {
    io.stderr(`Unable to resolve token: ${id}\n`);
    return 1;
  }
  const lines = [String(id)];
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
  const dependentCount = result.graph.getAffectedTokens([id]).size - 1;
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
    `Dependencies:\n  ${token.dependencies.length}`,
    "",
    `Reverse dependencies:\n  ${dependentCount}`,
  );
  io.stdout(`${lines.join("\n")}\n`);
  return 0;
}

function transitiveDependents(result: CompilationResult, id: TokenId): readonly TokenId[] {
  const direct = new Set(result.graph.getDependents(id));
  return [...result.graph.getAffectedTokens([id])].filter(
    (candidate) => candidate !== id && !direct.has(candidate),
  );
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
  const { result } = await loadAndCompile(parsed, io, "none");
  if (!result.success) {
    printDiagnostics(result, io, false);
    return 1;
  }
  let id: TokenId;
  try {
    id = parseTokenId(input);
  } catch {
    io.stderr(`Invalid token ID: ${input}\n`);
    return 1;
  }
  if (!result.graph.hasToken(id)) {
    io.stderr(`Unknown token: ${id}\n`);
    return 1;
  }
  const direct = result.graph.getDependents(id);
  const indirect = transitiveDependents(result, id);
  io.stdout(
    `${id}\n\n${usagesSection("Direct usages", direct)}\n\n${usagesSection("Indirect usages", indirect)}\n\n${direct.length + indirect.length} total dependent tokens\n`,
  );
  return 0;
}

function dependencyTree(result: CompilationResult, id: TokenId): readonly string[] {
  const lines: string[] = [String(id)];
  const visit = (current: TokenId, depth: number, seen: ReadonlySet<TokenId>): void => {
    for (const dependency of result.graph.getDependencies(current)) {
      const cycle = seen.has(dependency);
      lines.push(`${"   ".repeat(depth)}└─ ${dependency}${cycle ? " (cycle)" : ""}`);
      if (!cycle) visit(dependency, depth + 1, new Set(seen).add(dependency));
    }
  };
  visit(id, 0, new Set([id]));
  return lines;
}

async function graphCommand(parsed: ParsedArguments, io: CliIO): Promise<number> {
  const { result } = await loadAndCompile(parsed, io, "none");
  if (!result.success) {
    printDiagnostics(result, io, false);
    return 1;
  }
  const input = parsed.positionals[0];
  const root = input ? parseTokenId(input) : undefined;
  if (root && !result.graph.hasToken(root)) {
    io.stderr(`Unknown token: ${root}\n`);
    return 1;
  }
  const ids = root
    ? [...result.graph.getDependencyClosure([root])]
    : result.graph.tokens.map((token) => token.id);
  if (parsed.flags.get("format") === "mermaid") {
    const idSet = new Set(ids);
    const edges = ids.flatMap((id) =>
      result.graph
        .getDependencies(id)
        .filter((dependency) => idSet.has(dependency))
        .map(
          (dependency) =>
            `  ${JSON.stringify(String(dependency))} --> ${JSON.stringify(String(id))}`,
        ),
    );
    io.stdout(`graph TD\n${edges.join("\n")}\n`);
  } else if (root) io.stdout(`${dependencyTree(result, root).join("\n")}\n`);
  else io.stdout(`${result.graph.topologicalSort().join("\n")}\n`);
  return 0;
}

async function resolverDevCommand(
  parsed: ParsedArguments,
  io: CliIO,
  configPath: string | undefined,
  initialConfig: CompilerConfig,
): Promise<number> {
  let config = initialConfig;
  const build = async (): Promise<void> => {
    const result = await compile(config);
    if (result.success) {
      await writeOutputs(config, result, io);
      io.stdout(`✓ ${result.stats.tokens} tokens compiled\n`);
    } else printDiagnostics(result, io, false);
  };
  await build();
  const root = config.cwd ?? io.cwd;
  io.stdout(`✓ watching ${root}\n`);
  const watcher = watch(root, {
    ignoreInitial: true,
    ignored: (path) => /(?:^|\/)(?:node_modules|dist|\.git)(?:\/|$)/u.test(path),
    awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 10 },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let busy = Promise.resolve();
  const rebuild = (): void => {
    const previous = busy;
    busy = (async () => {
      await previous;
      try {
        config = applyResolverFlags(await loadConfig(io.cwd, configPath), parsed.flags);
        await build();
      } catch (error) {
        io.stderr(
          `${error instanceof Error ? error.message : String(error)}\n✗ waiting for a valid edit\n`,
        );
      }
    })();
  };
  watcher.on("all", () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(rebuild, 75);
  });
  watcher.on("error", (error) => io.stderr(`Watcher error: ${String(error)}\n`));
  return new Promise<number>((finish) => {
    const stop = (): void => {
      if (timer) clearTimeout(timer);
      void (async () => {
        await busy;
        await watcher.close();
        finish(0);
      })();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

async function devCommand(parsed: ParsedArguments, io: CliIO): Promise<number> {
  const explicit = parsed.flags.get("config");
  const configPath = typeof explicit === "string" ? explicit : undefined;
  let loadedConfig = await loadConfigFile(io.cwd, configPath);
  let config = applyResolverFlags(loadedConfig.config, parsed.flags);
  if (config.resolver) return resolverDevCommand(parsed, io, configPath, config);
  let sources = await loadTokenFiles(config.source, config.cwd);
  let contents = new Map(sources.map((source) => [source.file, source.content]));
  let compiler = new IncrementalCompiler(incrementalOptions(config, io));
  let initial = await compiler.initialize(sources);
  let generatedFiles = outputPaths(config, initial.result, io);
  if (initial.result.success) {
    await writeOutputs(config, initial.result, io);
    io.stdout(
      `✓ ${initial.result.stats.tokens} tokens compiled\n✓ watching ${config.cwd ?? io.cwd}\n`,
    );
  } else printDiagnostics(initial.result, io, false);

  const root = config.cwd ?? io.cwd;
  const watcher = watch(root, {
    ignoreInitial: true,
    ignored: (path) => /(?:^|\/)(?:node_modules|dist|\.git)(?:\/|$)/u.test(path),
    awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 10 },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let configDirty = false;
  let busy = Promise.resolve();
  const rebuild = (): void => {
    const previous = busy;
    busy = (async () => {
      await previous;
      try {
        const nextLoadedConfig = await loadConfigFile(io.cwd, configPath);
        const nextConfig = nextLoadedConfig.config;
        const configChanged =
          configDirty ||
          configFileChanged(loadedConfig, nextLoadedConfig) ||
          JSON.stringify({ source: config.source, contexts: config.contexts }) !==
            JSON.stringify({ source: nextConfig.source, contexts: nextConfig.contexts });
        configDirty = false;
        if (configChanged) {
          config = nextConfig;
          sources = await loadTokenFiles(config.source, config.cwd);
          contents = new Map(sources.map((source) => [source.file, source.content]));
          compiler = new IncrementalCompiler(incrementalOptions(config, io));
          initial = await compiler.initialize(sources);
          loadedConfig = nextLoadedConfig;
          generatedFiles = outputPaths(config, initial.result, io);
          if (initial.result.success) await writeOutputs(config, initial.result, io);
          else printDiagnostics(initial.result, io, false);
          io.stdout(`✓ config reloaded\n`);
          return;
        }
        config = nextConfig;
        const nextSources = await loadTokenFiles(config.source, config.cwd);
        const nextContents = new Map(nextSources.map((source) => [source.file, source.content]));
        const changedIds = new Set<TokenId>();
        const affected = new Set<TokenId>();
        let latest: CompilationResult | undefined;
        let recomputed = 0;
        for (const file of contents.keys()) {
          if (!nextContents.has(file)) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- Incremental compiler updates are stateful and must remain ordered.
            const update = await compiler.remove(file);
            update.changed.forEach((id) => changedIds.add(id));
            update.affected.forEach((id) => affected.add(id));
            latest = update.result;
            recomputed += update.recomputed;
          }
        }
        for (const source of nextSources) {
          if (contents.get(source.file) !== source.content) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- Incremental compiler updates are stateful and must remain ordered.
            const update = await compiler.update(source);
            update.changed.forEach((id) => changedIds.add(id));
            update.affected.forEach((id) => affected.add(id));
            latest = update.result;
            recomputed += update.recomputed;
          }
        }
        contents = nextContents;
        if (!latest) return;
        if (!latest.success) {
          printDiagnostics(latest, io, false);
          io.stderr("✗ waiting for a valid edit\n");
          return;
        }
        generatedFiles = outputPaths(config, latest, io);
        await writeOutputs(config, latest, io);
        io.stdout(
          `\n${[...changedIds].join(", ")} changed\n\n✓ ${changedIds.size} token${changedIds.size === 1 ? "" : "s"} changed\n✓ ${Math.max(0, affected.size - changedIds.size)} dependent tokens invalidated\n✓ ${recomputed} tokens recomputed\n${latest.outputs.map((output) => `✓ ${output.path} updated`).join("\n")}\n`,
        );
      } catch (error) {
        io.stderr(
          `${error instanceof Error ? error.message : String(error)}\n✗ waiting for a valid edit\n`,
        );
      }
    })();
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
      configDirty = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(rebuild, 75);
  });
  watcher.on("error", (error) => io.stderr(`Watcher error: ${String(error)}\n`));
  return new Promise<number>((finish) => {
    const stop = (): void => {
      if (timer) clearTimeout(timer);
      void (async () => {
        await busy;
        await watcher.close();
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
  tokenc check [--config path] [--json]
  tokenc dev [--config path]
  tokenc explain <token> [--theme dark]
  tokenc usages <token>
  tokenc graph [token] [--format mermaid]
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
