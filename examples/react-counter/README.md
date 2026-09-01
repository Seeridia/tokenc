# tokenc React counter

[简体中文](README.zh-CN.md)

This is a deliberately small but complete Vite + React + TypeScript application. DTCG tokens are
the single source of truth: `tokenc` generates both CSS Custom Properties and TypeScript constants,
which React consumes for presentation and counter behavior respectively.

## Run it

From the repository root:

```bash
vp install
vp -C examples/react-counter run check:tokens
vp -C examples/react-counter run dev
```

Open the local URL printed by the terminal. The page increments, decrements, and resets the counter,
and switches between light and dark themes. To create a production build:

```bash
vp -C examples/react-counter run build
```

Both `dev` and `build` regenerate token artifacts first. To rebuild continuously while editing
tokens, run this in a second terminal:

```bash
vp -C examples/react-counter run tokens:watch
```

## How data flows

```text
tokens/*.json
    │  DTCG tokens, aliases, and theme Context
    ▼
tokenc.config.ts
    ├── CSS backend ─────► src/generated/tokens.css ─► styles.css
    └── TypeScript backend ► src/generated/tokens.ts ─► App.tsx
```

- [`tokens/foundation.json`](tokens/foundation.json) defines raw colors, spacing, radii, motion,
  and the counter range.
- [`tokens/semantic.json`](tokens/semantic.json) creates the semantic alias layer and uses
  `org.token-compiler.contexts` for dark-theme overrides.
- [`tokens/component.json`](tokens/component.json) maps semantic tokens to the app and its controls.
- [`tokenc.config.ts`](tokenc.config.ts) maps `theme=light/dark` to CSS selectors and enables flat
  TypeScript output.
- [`src/generated/tokens.css`](src/generated/tokens.css) is consumed by styles, for example
  `var(--counter-panel-background)`.
- [`src/generated/tokens.ts`](src/generated/tokens.ts) is imported by React, for example
  `counterStep`.
- [`src/theme.tsx`](src/theme.tsx) only changes the DOM `data-theme`; the actual values come from
  generated CSS.

Generated files are intentionally committed for inspection and diffing. Do not maintain them by
hand; rebuild them with `vp -C examples/react-counter run tokens`.

## Try the VS Code extension with this example

Install the VSIX, then open this example itself as the workspace:

```bash
vp -C packages/vscode-extension run package:vsix
code --install-extension artifacts/tokenc-vscode.vsix --force
code examples/react-counter
```

The install command installs the extension but does not open a window. Trust the new workspace;
the included `.vscode/settings.json` already defines light and dark Context profiles.

Try each feature:

1. Open `tokens/semantic.json` and hover over `{palette.slate.50}` to inspect its type, expression,
   resolved value, Context, and provenance.
2. Press `F12` on the alias to jump to its definition; use `Shift+F12` to list all references.
3. Put the cursor after an alias `{` and press `Ctrl+Space` (or run **Trigger Suggest**) for sorted
   Token ID completions.
4. Open Explorer's **Outline** for the document token hierarchy; press `Cmd+T` (`Ctrl+T` on
   Windows/Linux) to search workspace tokens.
5. Press `F2` on the declaration or a reference to `surface.muted`, and enter the complete ID
   `surface.subtle`. The declaration and every token alias are renamed atomically. Run
   `vp -C examples/react-counter run tokens` afterward to refresh generated files, then undo if you
   only wanted to experiment.
6. Temporarily change an alias to `{missing.token}`. Observe Problems and the inline diagnostic;
   restore valid content and the diagnostic disappears with the current snapshot.
7. Run **tokenc: Select Context Profile** → **Dark**, then hover `canvas.background` again. The
   resolved value changes to the dark Context. This editor-only query does not write files or
   control the browser theme.
8. Run **tokenc: Show Language Server Status** to inspect lifecycle and trust, or
   **tokenc: Restart Language Server** when a reload is needed.

See the [complete VS Code guide](../../docs/VS-CODE-GUIDE.md) for every feature, setting,
multi-root behavior, and troubleshooting.

## Commands

| Command                                         | Purpose                                       |
| ----------------------------------------------- | --------------------------------------------- |
| `vp -C examples/react-counter run tokens`       | Generate CSS and TypeScript                   |
| `vp -C examples/react-counter run check:tokens` | Validate tokens without writing files         |
| `vp -C examples/react-counter run tokens:watch` | Watch tokens and regenerate incrementally     |
| `vp -C examples/react-counter run dev`          | Generate tokens and start the Vite dev server |
| `vp -C examples/react-counter run build`        | Generate tokens and build the production site |
