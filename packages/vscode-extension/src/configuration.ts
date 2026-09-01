export type StringMap = Readonly<Record<string, string>>;

export interface FolderConfiguration {
  readonly uri: string;
  readonly configPath?: string;
  readonly context: StringMap;
  readonly resolverInput: StringMap;
}

export interface ServerInitializationOptions {
  readonly trusted: boolean;
  readonly trustedWorkspaces: Readonly<Record<string, boolean>>;
  readonly configPaths?: Readonly<Record<string, string>>;
  readonly context?: StringMap;
  readonly resolverInput?: StringMap;
  readonly workspaceSettings: Readonly<
    Record<string, { readonly context?: StringMap; readonly resolverInput?: StringMap }>
  >;
}

export interface ServerConfigurationSettings {
  readonly tokenc: {
    readonly context?: StringMap;
    readonly resolverInput?: StringMap;
    readonly workspaces: Readonly<
      Record<string, { readonly context?: StringMap; readonly resolverInput?: StringMap }>
    >;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: StringMap): StringMap | undefined {
  return Object.keys(value).length > 0 ? value : undefined;
}

function workspaceSettings(folders: readonly FolderConfiguration[]) {
  return Object.fromEntries(
    folders.map((folder) => [
      folder.uri,
      {
        ...(nonEmpty(folder.context) ? { context: folder.context } : {}),
        ...(nonEmpty(folder.resolverInput) ? { resolverInput: folder.resolverInput } : {}),
      },
    ]),
  );
}

/** Keep only string-valued entries and canonicalize their order before crossing the LSP boundary. */
export function stringMap(value: unknown): StringMap {
  if (!isRecord(value)) return {};
  return Object.freeze(
    Object.fromEntries(
      Object.entries(value)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .toSorted(([left], [right]) => left.localeCompare(right)),
    ),
  );
}

/** Parse named profiles without interpreting any Context or Resolver semantics. */
export function configuredProfiles(value: unknown): Readonly<Record<string, StringMap>> {
  if (!isRecord(value)) return {};
  return Object.freeze(
    Object.fromEntries(
      Object.entries(value)
        .map(([name, profile]) => [name, stringMap(profile)] as const)
        .filter(([, profile]) => Object.keys(profile).length > 0)
        .toSorted(([left], [right]) => left.localeCompare(right)),
    ),
  );
}

export function createInitializationOptions(
  trusted: boolean,
  defaults: Pick<FolderConfiguration, "context" | "resolverInput">,
  folders: readonly FolderConfiguration[],
): ServerInitializationOptions {
  const configPaths = Object.fromEntries(
    folders.flatMap((folder) => (folder.configPath ? [[folder.uri, folder.configPath]] : [])),
  );
  return {
    trusted,
    trustedWorkspaces: Object.fromEntries(folders.map((folder) => [folder.uri, trusted])),
    ...(Object.keys(configPaths).length > 0 ? { configPaths } : {}),
    ...(nonEmpty(defaults.context) ? { context: defaults.context } : {}),
    ...(nonEmpty(defaults.resolverInput) ? { resolverInput: defaults.resolverInput } : {}),
    workspaceSettings: workspaceSettings(folders),
  };
}

export function createConfigurationSettings(
  defaults: Pick<FolderConfiguration, "context" | "resolverInput">,
  folders: readonly FolderConfiguration[],
): ServerConfigurationSettings {
  return {
    tokenc: {
      ...(nonEmpty(defaults.context) ? { context: defaults.context } : {}),
      ...(nonEmpty(defaults.resolverInput) ? { resolverInput: defaults.resolverInput } : {}),
      workspaces: workspaceSettings(folders),
    },
  };
}
