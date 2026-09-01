# Complete guide to the tokenc VS Code extension

[简体中文](VS-CODE-GUIDE.zh-CN.md)

This guide covers installation, every current editing feature, Context and Resolver input,
multi-root workspaces, the trust model, and troubleshooting. For a runnable walkthrough, use the
[React counter example](../examples/react-counter/README.md).

## 1. Install and open the right project

Build and install the current VSIX from this repository:

```bash
vp install
vp -C packages/vscode-extension run package:vsix
code --install-extension artifacts/tokenc-vscode.vsix --force
```

`code --install-extension` only installs the extension; it does not open VS Code. Open the example
explicitly:

```bash
code examples/react-counter
```

The extension requires VS Code 1.134.0 or newer. An opened workspace folder must either contain a
root `tokenc.config.ts`, `.mts`, `.js`, or `.mjs`, or set `tokenc.configPath` to a config path
relative to that folder.

Config files are executable code. Choose **Trust** when first opening the project. In an untrusted
workspace the extension may start, but it does not execute configuration or load token sources.

## 2. Five-minute complete tour

Open `examples/react-counter`, then use `tokens/semantic.json` and `tokens/component.json`:

| Capability        | How to trigger it                                                                   | What to observe                                                                                    |
| ----------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Diagnostics       | Temporarily change an alias to `{missing.token}`                                    | Problems and an inline `TOKEN_UNKNOWN_REFERENCE`; restore it and the error disappears              |
| Completion        | Put the cursor inside an existing `{canvas.background}` and run **Trigger Suggest** | Sorted canonical Token IDs with types                                                              |
| Hover             | Hover `{palette.slate.50}`                                                          | Type, selected expression, resolved value, effective Context, provenance, and relevant diagnostics |
| Go to Definition  | Press `F12` on an alias                                                             | The exact cross-file declaration range                                                             |
| Find References   | Press `Shift+F12` on a declaration or alias                                         | Declarations, aliases, JSON Pointers, composite fields, and group-inheritance references           |
| Document Symbols  | Open Explorer's **Outline**                                                         | The current document's original token/group hierarchy                                              |
| Workspace Symbols | Press `Cmd+T` / `Ctrl+T`                                                            | Search all workspace tokens by canonical ID                                                        |
| Rename            | Press `F2` on `surface.muted`, enter the full ID `surface.subtle`                   | Declaration and all token references change atomically; collisions reject the whole operation      |
| Quick Fix         | Press `Cmd+.` / `Ctrl+.` on a tokenc diagnostic with an applicable fix              | A version-guarded workspace edit; safe fixes are preferred                                         |
| Context profile   | Run **tokenc: Select Context Profile** → **Dark**                                   | Subsequent hovers use the dark Context without writing project files                               |
| Status            | Run **tokenc: Show Language Server Status**                                         | Server lifecycle and workspace trust state                                                         |
| Restart           | Run **tokenc: Restart Language Server**                                             | The old Server stops before a new instance starts                                                  |

Completion appears only in ranges Core proves are token aliases, so ordinary JSON strings stay
quiet. A Quick Fix appears only when the current diagnostic carries a fix authorized by the
Diagnostic registry; not every error has an automatic repair.

## 3. Feature details

### Diagnostics and invalid-edit recovery

The extension overlays the editor's in-memory content instead of waiting for disk writes. Each
change creates a workspace revision, and only the latest revision may publish results, so stale
diagnostics cannot overwrite newer ones while you type.

- JSON syntax, DTCG structure, types, references, Contexts, cycles, and Backend preflight failures
  appear in Problems.
- Diagnostics retain stable codes, exact UTF-16 ranges, related locations, documentation URLs, and
  fingerprints.
- While a document is temporarily invalid, only facts proven by the current snapshot remain; full
  graph information returns after recovery.
- Failed compilation never emits partial output, and the extension itself never generates files.

### Completion, hover, and navigation

- **Completion** supplies canonical Token IDs only, deterministically sorted and annotated by type.
- **Hover** reports the selected expression, resolved value, effective Context, and explain
  provenance on declarations and references. Select another Context profile and hover again to
  compare values.
- **Definition** covers aliases, JSON Pointers, composite-field references, and `$extends` group
  inheritance.
- **References** uses the current conditional dependency graph, so the effective reference set can
  change with Context.
- **Symbols** preserves group hierarchy in Document Symbols and searches across sources through
  Workspace Symbols.

These features operate on JSON/JSONC files matched by `source` in `tokenc.config.*`. Generated CSS
and TypeScript are not part of the token source graph.

### Rename

Rename uses Core's atomic rename planner rather than text replacement:

1. It plans the declaration and every known reference together.
2. A virtual compilation checks duplicate IDs, types, and Backend symbol collisions.
3. Source digests, open-document versions, and workspace revision must still match.
4. Only then does VS Code receive one versioned `documentChanges` edit.

Enter the complete canonical ID—for example, rename `surface.muted` to `surface.subtle`, not merely
`subtle`. Generated CSS and TypeScript are not edited by Rename; run `tokenc build` afterward.

### Quick Fix

Code Actions accept only diagnostics from `tokenc` whose fingerprint matches the current snapshot
and whose code is authorized for fixes by the Diagnostic registry. Stale, out-of-bounds,
overlapping, or incorrectly owned edits are dropped. `safe` fixes are preferred;
`requires-review` fixes remain available without being preferred.

### Context profiles

Ordinary Context changes the query view for conditional values in one compilation. Configure a
default and named profiles:

```json
{
  "tokenc.context": { "theme": "light" },
  "tokenc.contextProfiles": {
    "Light": { "theme": "light" },
    "Dark": { "theme": "dark" }
  }
}
```

Run **tokenc: Select Context Profile**. A temporary selection lasts for the current extension
session and immediately affects hover and references; it does not modify tokens, config, or output.
Choose **Configured default** to return to `tokenc.context`.

### Resolver input profiles

Resolver input selects DTCG Resolver source composition. It is intentionally independent from
ordinary Context:

```json
{
  "tokenc.resolverInput": { "brand": "default" },
  "tokenc.resolverInputProfiles": {
    "Default brand": { "brand": "default" },
    "Acme": { "brand": "acme" }
  }
}
```

Run **tokenc: Select Resolver Input Profile**. Resolver input updates Session sources
transactionally; ordinary Context changes only the query view. Neither writes project files.

## 4. All settings

Settings can live in `.vscode/settings.json` and can be scoped per workspace folder:

| Setting                        | Default | Purpose                                                       |
| ------------------------------ | ------- | ------------------------------------------------------------- |
| `tokenc.configPath`            | `""`    | Optional config path relative to the current workspace folder |
| `tokenc.context`               | `{}`    | Default ordinary Context selection                            |
| `tokenc.resolverInput`         | `{}`    | Default Resolver input                                        |
| `tokenc.contextProfiles`       | `{}`    | Named maps shown by **Select Context Profile**                |
| `tokenc.resolverInputProfiles` | `{}`    | Named maps shown by **Select Resolver Input Profile**         |

Changing any `tokenc.*` setting clears temporary session profile choices and restarts the Server,
making the configured values authoritative again.

## 5. Multi-root workspaces

Each workspace folder owns an independent config, Compiler Session, Context, and Resolver input.
Prefer each folder's `.vscode/settings.json`, or select the target folder in VS Code's Settings UI
before changing Workspace Folder-scoped settings.

When running a profile command:

- an active editor selects its containing folder;
- a single folder is selected automatically;
- multiple folders with no applicable active editor produce a folder picker.

Diagnostics and queries remain isolated between folders. Dynamically added or removed workspace
folders create or close the corresponding Session.

## 6. Lifecycle and security boundaries

- The extension is a thin client; parser, graph, resolver, diagnostics, and rename semantics come
  from shared tokenc packages.
- The client watches JSON/JSONC sources and `tokenc.config.*`, and talks to its bundled Server over
  standard LSP.
- Config execution is fail-closed and occurs only after VS Code reports the workspace trusted.
- Restarts are serialized, preventing two Server instances from remaining active.
- The extension never runs `tokenc build` and never writes source; output generation stays an
  explicit CLI action.

## 7. Troubleshooting

### Installation succeeds but no window opens

This is expected. Installation and opening a project are separate actions:

```bash
code --install-extension artifacts/tokenc-vscode.vsix --force
code examples/react-counter
```

### No hover, completion, or diagnostics

1. Confirm the file is JSON/JSONC matched by the config's `source`.
2. Open the folder containing the config, not an unconfigured parent.
3. For a nested config, set a path such as
   `"tokenc.configPath": "examples/react-counter/tokenc.config.ts"`.
4. Confirm the workspace is trusted.
5. Run **tokenc: Show Language Server Status**, then **Restart Language Server**.

### Context value is unexpected

Confirm whether you selected a **Context Profile** or **Resolver Input Profile**. Changing settings
clears previous temporary choices. Reselect the profile and compare `context` and `resolvedValue`
on the same hover.

### Read logs

Open **View → Output** and select **tokenc Language Server**. Configuration failures, workspace
names, and snapshot status are reported there.

### Verify the VSIX itself

The repository smoke test packages the VSIX, installs it into a temporary clean VS Code profile,
activates it, and verifies navigation, diagnostics, and the no-source-write guarantee:

```bash
vp -C packages/vscode-extension run smoke:vsix
```

## 8. Current boundaries

- Language features are registered only for file-scheme JSON/JSONC token sources.
- Config must be a local executable `tokenc.config.*` in a trusted workspace.
- Profile selection lasts only for the current extension session.
- The extension does not build outputs, preview generated CSS/TS, or publish packages.
- Marketplace publication and credentials are outside the current repository acceptance gate; the
  local VSIX is the complete verified path.
