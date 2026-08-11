import type { CompilationContext, JsonValue } from "../model.js";

export const CONTEXT_EXTENSION = "org.token-compiler.contexts";

export interface ContextExtensionEntry {
  readonly index: number;
  readonly key: string;
  readonly selector: CompilationContext;
  readonly value: JsonValue;
}

export interface ContextExtensionIssue {
  readonly code: "TOKEN_INVALID_CONTEXT_EXTENSION" | "TOKEN_INVALID_CONTEXT_SELECTOR";
  readonly message: string;
  readonly key?: string;
  readonly index?: number;
}

export interface ContextExtensionResult {
  readonly entries: readonly ContextExtensionEntry[];
  readonly issues: readonly ContextExtensionIssue[];
}

export interface RawContextExtensionEntry {
  readonly key: string;
  readonly value: JsonValue;
}

function contextSelector(input: string): CompilationContext | undefined {
  const context: Record<string, string> = {};
  for (const clause of input.split("&")) {
    const [rawName, rawValue, ...rest] = clause.split("=");
    const name = rawName?.trim();
    const value = rawValue?.trim();
    if (!name || !value || rest.length > 0) return undefined;
    context[name] = value;
  }
  return context;
}

/** Interpret tokenc's runtime-context extension independently of standard DTCG semantics. */
export function interpretContextExtension(
  extensions: Readonly<Record<string, JsonValue>> | undefined,
): ContextExtensionResult {
  const raw = extensions?.[CONTEXT_EXTENSION];
  if (raw === undefined) return { entries: [], issues: [] };
  if (raw === null || Array.isArray(raw) || typeof raw !== "object")
    return {
      entries: [],
      issues: [
        {
          code: "TOKEN_INVALID_CONTEXT_EXTENSION",
          message: `\`${CONTEXT_EXTENSION}\` must be an object`,
        },
      ],
    };
  return interpretContextEntries(Object.entries(raw).map(([key, value]) => ({ key, value })));
}

/** Interpret an ordered entry stream so duplicate JSON object keys remain diagnosable. */
export function interpretContextEntries(
  rawEntries: readonly RawContextExtensionEntry[],
): ContextExtensionResult {
  const entries: ContextExtensionEntry[] = [];
  const issues: ContextExtensionIssue[] = [];
  for (const [index, { key, value: candidate }] of rawEntries.entries()) {
    const selector = contextSelector(key);
    if (!selector) {
      issues.push({
        code: "TOKEN_INVALID_CONTEXT_SELECTOR",
        message: `Invalid context selector \`${key}\``,
        key,
        index,
      });
      continue;
    }
    const value =
      candidate !== null &&
      !Array.isArray(candidate) &&
      typeof candidate === "object" &&
      Object.hasOwn(candidate, "$value")
        ? candidate.$value
        : candidate;
    if (value === undefined) {
      issues.push({
        code: "TOKEN_INVALID_CONTEXT_EXTENSION",
        message: `Context override \`${key}\` must provide a value`,
        key,
        index,
      });
      continue;
    }
    entries.push({ index, key, selector, value });
  }
  return { entries, issues };
}
