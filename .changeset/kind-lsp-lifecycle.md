---
"@tokenc/cli": minor
"@tokenc/language-server": minor
---

Add the public `@tokenc/language-server` package with pinned LSP 3.17 dependencies, a stdio
executable, a testable server factory, fail-closed workspace trust, isolated multi-root compiler
sessions, open-buffer overlays, watched-file routing, and latest-wins revision scheduling. Export the
CLI's trusted config snapshot and Core Session configuration adapters so hosts reuse one config
loading authority, including cache-safe executable config reloads.
