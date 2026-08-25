---
"@tokenc/core": minor
"@tokenc/cli": minor
"@tokenc/backend-css": minor
"@tokenc/backend-tailwind": minor
"@tokenc/backend-typescript": minor
---

Establish a stricter semantic compilation baseline. Context-dependent references now participate in
cycle checks only when their selectors can be active together, and diagnostics identify the active
context. Canonical context keys now escape unsafe UTF-16 code units as `%XXXX`; consumers that set
the generated `data-context` attribute must use the emitted canonical key. Document-root `$schema`
declarations are accepted. Conditional-cycle candidates that exceed 16,384 Context projections now
fail with `TOKEN_CONTEXT_PROJECTION_LIMIT` instead of consuming unbounded compilation time.

Backends can validate a compilation before any output is emitted. The bundled backends reject
normalized-name collisions, CSS and Tailwind serialize supported composite values without JSON
fallbacks, unsupported lossless CSS shapes produce diagnostics, Tailwind uses a stable
`--shadow-default` name for a top-level shadow token, and TypeScript avoids reserved binding names
and object leaf/namespace conflicts. CSS and Tailwind now reject incomplete automatic
multi-dimensional context coverage, duplicate selector targets, and invalid explicit context sets.
CSS numbers and colors no longer lose precision. DTCG gradients now fail CSS/Tailwind preflight
until an explicit platform transform supplies the missing gradient function and geometry, rather
than emitting a non-standalone stop list. CSS font-family control characters use CSS escapes, while
code units that CSS cannot preserve produce an unsupported-value diagnostic.

`tokenc check` runs backend preflight without generating artifacts. Builds also reject duplicate
normalized output paths before the CLI writes files, and dev mode reloads custom-named config files
and their imported configuration modules when backend settings change.
