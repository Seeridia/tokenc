---
"@tokenc/cli": minor
---

Add the read-only Git revision/worktree provider and `tokenc diff --base <ref>
[--head <ref|worktree>] --format text|json`. Diff compilation uses one explicitly trusted current
configuration, preserves staged, unstaged, untracked, added, renamed, and deleted source state, and
fails closed without mutating checkout, branch, index, or repository configuration.
