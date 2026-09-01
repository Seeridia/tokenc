# tokenc for VS Code

[简体中文](README.zh-CN.md)

Thin VS Code client for the tokenc Design Token Compiler. The extension starts the bundled
`@tokenc/language-server`; compiler parsing, graph, resolution, diagnostics, and rename semantics
remain in the shared tokenc packages.

For a feature-by-feature walkthrough, settings reference, multi-root behavior, and troubleshooting,
see the [complete guide](../../docs/VS-CODE-GUIDE.md). The runnable
[React counter](../../examples/react-counter/README.md) provides a ready-made extension playground.

## Install from this repository

From the repository root:

```bash
vp install
vp -C packages/vscode-extension run package:vsix
code --install-extension artifacts/tokenc-vscode.vsix --force
```

Open a folder containing `tokenc.config.ts`, `.mts`, `.js`, or `.mjs`. The extension activates
automatically. The config is executable, so tokenc does not load it until VS Code reports that the
workspace is trusted.

## Features

- Current-snapshot diagnostics with invalid-edit recovery.
- Alias completion, definition, references, document/workspace symbols, and Context-aware hover.
- Collision-safe rename and registry-authorized quick fixes through standard LSP edits.
- `tokenc: Restart Language Server` and `tokenc: Show Language Server Status` commands.
- In-memory selection of configured Context and Resolver input profiles; no project file is written.

Configure defaults and named selections in VS Code settings:

```json
{
  "tokenc.configPath": "tokenc.config.ts",
  "tokenc.context": { "theme": "light" },
  "tokenc.resolverInput": { "brand": "default" },
  "tokenc.contextProfiles": {
    "Light": { "theme": "light" },
    "Dark": { "theme": "dark" }
  },
  "tokenc.resolverInputProfiles": {
    "Default brand": { "brand": "default" },
    "Acme": { "brand": "acme" }
  }
}
```

Run `tokenc: Select Context Profile` or `tokenc: Select Resolver Input Profile`. A selection lasts
for the current extension session and is forwarded independently to the language server. Changing
the underlying `tokenc.*` settings clears temporary selections and restarts the server.

## Troubleshooting

- **No features appear:** confirm the opened folder contains a supported `tokenc.config.*` file,
  trust the workspace, then run `tokenc: Restart Language Server`.
- **Config not found:** set `tokenc.configPath` relative to the workspace folder. This setting is
  restricted while the workspace is untrusted.
- **Unexpected resolved value:** Context and Resolver input are intentionally separate. Use
  `tokenc: Show Language Server Status`, then reselect the relevant profile.
- **Need logs:** open **View → Output** and choose **tokenc Language Server**.

The repository smoke test packages a deterministic VSIX, installs it into temporary clean
user-data and extension directories, activates the installed extension, and verifies navigation,
diagnostics, and the no-source-write guarantee:

```bash
vp -C packages/vscode-extension run smoke:vsix
```

Marketplace publication and credentials are intentionally outside the M3 acceptance gate.
