import { resolve } from "node:path";

export interface ConfigFileSnapshot {
  readonly path: string;
  readonly source: string;
}

/** Match a watcher event against the configuration file that was actually loaded. */
export function isConfigFileEvent(
  eventPath: string,
  configPath: string,
  watchRoot: string,
): boolean {
  return resolve(watchRoot, eventPath) === resolve(configPath);
}

export interface DevWatchFiles {
  readonly configPath: string;
  readonly tokenPaths: ReadonlySet<string>;
  readonly outputPaths: ReadonlySet<string>;
  readonly watchRoot: string;
}

/**
 * Unknown project files may be imported by the config, so treat them conservatively as config
 * dependencies. Known generated outputs are excluded to prevent write-triggered rebuild loops.
 */
export function shouldReloadConfigForEvent(eventPath: string, files: DevWatchFiles): boolean {
  const path = resolve(files.watchRoot, eventPath);
  if (isConfigFileEvent(path, files.configPath, files.watchRoot)) return true;
  if (files.outputPaths.has(path)) return false;
  return !files.tokenPaths.has(path);
}

/** Detect configuration edits even when compiler-facing source/context fields are unchanged. */
export function configFileChanged(previous: ConfigFileSnapshot, next: ConfigFileSnapshot): boolean {
  return resolve(previous.path) !== resolve(next.path) || previous.source !== next.source;
}
