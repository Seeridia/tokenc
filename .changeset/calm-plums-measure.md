---
"@tokenc/core": minor
---

Expose complete compiler stage timings and read-only Context cycle-analysis work metrics through
`CompilationResult.stats`. The existing `parse` timing now measures parsing only; linking has its
own `link` field, and token resolution has its own `resolve` field.
