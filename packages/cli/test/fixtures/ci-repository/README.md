# CI recipe fixture

`base` is committed into a temporary Git repository by `ci-recipe.test.ts`. Each directory under
`scenarios` is then overlaid onto that worktree:

- `pass`: a warning-level direct value change, exit `0`;
- `breaking`: a Token removal rejected by the default policy, exit `1`;
- `compiler-failure`: an unresolved reference rejected by `tokenc check`, exit `1`;
- `incomplete`: a changed implicit executable configuration, exit `2`.

The test renders text, Report v1 JSON, and SARIF for every scenario and verifies that exit codes and
Diagnostic fingerprints remain identical across formats.
