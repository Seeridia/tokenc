# Changesets

Every user-visible change should include a changeset:

```bash
vp exec changeset
```

The five public `@tokenc/*` packages use a fixed version group so their versions remain aligned while the public API is young. Test-only, documentation-only, and internal CI changes do not require a changeset unless they affect published package behavior.
