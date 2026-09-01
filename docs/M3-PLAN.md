# M3 Execution Plan: IDE-first Experience

[简体中文](M3-PLAN.zh-CN.md)

> Status: in progress. M3-00 through M3-06 are complete; M3-07 is next. M2 is closed with the
> synchronized `0.5.0` packages published under the `next` dist-tag. Updated 2026-09-02.
>
> Intended release line: `0.6.0`. M3 adds the public `@tokenc/language-server` package. The thin VS
> Code client is validated as an installable VSIX; marketplace publication is not an M3 exit gate.

## 1. Outcome

M3 brings the compiler's existing source of truth into the edit loop. A user editing a DTCG project
must receive the same diagnostics and graph answers as the CLI, while unsaved buffers, invalid JSON,
cancellation, and multiple workspace folders remain safe and deterministic.

The first release answers five questions:

1. What semantic object is under the cursor?
2. Where is it defined and where is it used under the active Context?
3. What type, expression, resolved value, and provenance does it have?
4. Which completions and edits are valid without creating canonical or Backend collisions?
5. Can the editor discard obsolete work and recover from incomplete input without stale results?

The implementation is a protocol adapter over `CompilerSession`, immutable snapshots, Query, the
diagnostic registry, and Backend preparation. It is not a second parser, graph, resolver, or checker.

## 2. Decisions fixed for M3

1. **One semantic authority.** Every LSP answer comes from the current `CompilationSnapshot` and its
   public Query APIs. The protocol layer never parses DTCG semantics or traverses dependencies.
2. **One Session per workspace folder.** Multi-root workspaces are isolated. Each folder owns its
   config, document overlay, active Context, revision counter, scheduler, and diagnostics.
3. **Unsaved text wins.** Open editor buffers overlay filesystem documents. `didChange` submits the
   complete current buffer to one atomic Session transaction; `didClose` returns authority to disk.
4. **UTF-16 is explicit.** The LSP boundary uses UTF-16 positions as required by LSP 3.17. Core keeps
   source offsets independent of LSP types. CRLF, astral Unicode, escaped strings, and file URI
   normalization receive dedicated fixtures.
5. **Every result is revision-bound.** Requests capture workspace revision and document version.
   Results from cancelled or superseded work are discarded before publication, even if underlying
   computation finishes later.
6. **Invalid input is a normal state.** Current invalid-source diagnostics are published. Features
   backed by the partial source index may continue; resolved-value and Backend facts return no result
   rather than silently reading the last successful snapshot.
7. **Cancellation is cooperative and fail-closed.** The server aborts obsolete work, Core observes
   `AbortSignal` at bounded stage/traversal boundaries, and aborted transactions never commit Session
   state or publish diagnostics.
8. **Editor operations are plans, not writes.** Rename and code actions return deterministic,
   digest-guarded edits. Only the client applies a `WorkspaceEdit`; the server never writes project
   files directly.
9. **Rename is semantic.** Core plans declaration and reference edits for aliases, JSON Pointer
   references, inheritance, and component occurrences, then preflights canonical IDs and every
   configured Backend symbol table before any edit is offered.
10. **Context is workspace state.** Hover, references, diagnostics, and rename previews use one
    explicit effective Context. Resolver inputs and ordinary Context overrides remain distinct.
11. **Workspace trust gates executable config.** The VS Code client starts the server only for a
    trusted workspace. Other clients must explicitly opt into config execution; an untrusted server
    session never imports `tokenc.config.*`.
12. **Standard LSP first.** M3 uses standard initialize, sync, diagnostics, completion, definition,
    references, hover, symbols, rename, and code-action methods. Rich graph/diff views and custom
    protocol methods wait.
13. **The extension stays thin.** It starts the server, forwards configuration and Context choices,
    exposes status/commands, and contains no compiler semantics.
14. **Direct change is allowed.** No compatibility facade is required during M3. Public TypeScript
    changes still require a Changeset and contract update; published JSON schemas are versioned.

## 3. Existing authority map

| Existing boundary                 | M3 authority                                                                                          |
| --------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `packages/core/src/session.ts`    | Atomic document/config updates, cache ownership, cancellation, current and last-valid snapshots       |
| `packages/core/src/snapshot.ts`   | Immutable revision, documents, diagnostics, Query, IR, and invalid-state boundary                     |
| `packages/core/src/query.ts`      | Token lookup, source lookup, definition, usages, completion candidates, Context, resolve, and explain |
| `packages/core/src/frontend.ts`   | JSON syntax tree, source ranges, reference occurrences, and partial facts from invalid input          |
| `packages/core/src/diagnostic.ts` | Codes, severities, stable fingerprints, related locations, and digest-guarded fixes                   |
| `packages/core/src/backend.ts`    | Shared symbol allocation and collision diagnostics used by rename preview                             |
| `packages/cli/src/index.ts`       | Current config discovery/loading behavior and the CLI side of diagnostic parity                       |
| `benchmarks/` and `contracts/`    | Reproducible semantic-work evidence and public declaration/schema locks                               |

M3 may extend these public boundaries, but it must not create editor-only copies of token identity,
reference parsing, Context selection, diagnostic fingerprinting, or Backend naming.

## 4. Contract target

Core gains a transport-neutral editor query layer. Names may be refined by M3-00, but the following
invariants are fixed:

```ts
type EditorSymbolRole = "declaration" | "alias" | "json-pointer" | "inheritance";

interface EditorSymbolV1 {
  readonly schemaVersion: "1";
  readonly role: EditorSymbolRole;
  readonly owner: TokenId;
  readonly target: TokenId;
  readonly source: SourceLocation;
  readonly fieldPath: readonly (string | number)[];
  readonly condition?: ContextPredicate;
}

interface RenamePlanV1 {
  readonly schemaVersion: "1";
  readonly status: "ready" | "rejected" | "unavailable";
  readonly token: TokenId;
  readonly replacement: TokenId;
  readonly edits: readonly TextEdit[];
  readonly diagnostics: readonly DiagnosticV1[];
  readonly backendPreviews: readonly BackendRenamePreviewV1[];
}
```

- Source-index queries remain available where safely derivable from invalid JSON.
- All returned collections are immutable and deterministically ordered.
- Core types contain no `vscode-*`, URI, JSON-RPC, or LSP protocol objects.
- Definitions and references preserve occurrence roles and exact source spans.
- A rename plan is all-or-nothing: any invalid ID, stale digest, ambiguous occurrence, duplicate ID,
  or Backend collision rejects the plan and returns no applicable edits.
- Workspace edits are generated only after mapping Core offsets through the exact document content
  and version that produced the snapshot.

The public `@tokenc/language-server` package provides a Node.js server executable and a testable
library entry point. Its initial protocol capabilities are:

```text
textDocumentSync: incremental transport, full-buffer Session updates
publishDiagnostics
completionProvider
definitionProvider
referencesProvider
hoverProvider
documentSymbolProvider
workspaceSymbolProvider
renameProvider + prepareProvider
codeActionProvider
```

## 5. Workspace and protocol model

Workspace discovery starts at each LSP workspace folder. An explicit initialization/configuration
path wins; otherwise the server searches only that folder for the supported `tokenc.config.*`
names. Source globs, Resolver documents, and Backend configuration come from that trusted config.

Each workspace coordinator owns:

```text
trusted config snapshot
filesystem documents + open-buffer overlay
CompilerSession
active Context / Resolver input
latest requested and published revisions
AbortController for superseded work
URI ↔ canonical document identity mapping
```

Lifecycle rules:

- `initialize` advertises only implemented capabilities; `shutdown` closes every Session.
- `didOpen`, `didChange`, watched-file events, config changes, and Context changes become serialized,
  atomic transactions. A burst may be coalesced only when no observable intermediate version is
  promised.
- Diagnostics are cleared for removed documents and published only for the latest accepted
  document versions.
- Requests arriving before initial compilation return an empty or unavailable result, never throw.
- Files outside every configured workspace are ignored unless the client explicitly opens them as
  a standalone trusted project.
- Protocol errors are logged through the connection and do not terminate the server process.

## 6. Feature semantics

### Diagnostics and recovery

- LSP severity, code, source, message, related information, and documentation URL map directly from
  Diagnostic v1.
- Diagnostic identity/fingerprint is retained in `data` for deduplication and code-action lookup.
- An invalid edit publishes current parse/semantic diagnostics; fixing it automatically publishes a
  valid replacement set without restarting the server.
- CLI/LSP parity compares normalized Diagnostic v1 facts before transport formatting.

### Completion, navigation, and hover

- Completion is offered only in recognized alias and reference positions. Candidates come from
  `snapshot.query.completions()` and the Core source index; ordering and filtering are deterministic.
- Definition and references use the exact semantic target and occurrence list, including component
  pointers and inheritance. Context filtering never hides the declaration itself.
- Document/workspace symbols are derived from canonical Token hierarchy and source ownership.
- Hover shows canonical ID, type, source expression, resolved value, effective Context, provenance,
  and unresolved diagnostics when applicable. Resolved previews are unavailable on an invalid
  current snapshot rather than stale.

### Rename and code actions

- `prepareRename` succeeds only on a semantic declaration/reference with an unambiguous Token ID.
- Rename validates the replacement ID, builds all declaration/reference edits, checks overlap and
  document digests, recompiles a virtual edited project, and preflights configured Backends.
- Canonical collisions, Backend symbol collisions, invalid JSON Pointer rewrites, and incomplete
  coverage reject the entire operation before returning a `WorkspaceEdit`.
- Quick fixes reuse validated Diagnostic v1 edits. The server rechecks document version and digest
  immediately before returning the action.
- No action shells out, emits Backend files, edits configuration, or writes to disk.

## 7. Scope

M3 includes:

- Public `@tokenc/language-server` with a stdio executable and library entry point.
- A thin, private VS Code extension workspace and reproducible VSIX artifact.
- Trusted workspace/config discovery, multi-root isolation, open-buffer overlays, and file watching.
- Push diagnostics, alias completion, definition, references, hover, document/workspace symbols,
  collision-safe rename, and structured code actions.
- Explicit active Context/Resolver input configuration and resolved-value hover previews.
- Core editor source-index and rename-plan contracts with public declarations and schemas where
  machine serialization is promised.
- Protocol conformance, CLI/LSP differential tests, process-level end-to-end tests, and semantic-work
  plus latency/memory benchmarks.

M3 excludes:

- A standalone GUI, graph or diff Webview, semantic tokens, formatting, inlay hints, or color-picker
  UI.
- Marketplace publication, telemetry, account services, or remote project indexing.
- A persistent daemon/cache, worker farm, network transport, or browser-hosted language server.
- General lint/importer/plugin SDKs, new production Backends, or non-DTCG source semantics.
- Automatic edits across files not represented by the accepted snapshot.
- Executing configuration in an untrusted workspace.

## 8. Delivery sequence

### Gate 0: freeze protocol semantics and evidence

#### M3-00 — IDE RFC, protocol corpus, and baseline (P0)

Status: complete. See [RFC 0005](rfcs/0005-ide-language-server.md) and the
[M3-00 edit-loop baseline](M3-00-BASELINE.md). Gate 0 is accepted and unblocked M3-01.

Deliver:

- Add one RFC covering source-index roles, URI/offset mapping, workspace trust, overlays, revision
  ordering, cancellation, invalid-state behavior, Context selection, rename atomicity, and rejected
  alternatives.
- Add checked-in protocol transcripts for initialize/open/change/close, diagnostics, completion,
  navigation, hover, symbols, rename, code actions, cancellation, multi-root, and shutdown.
- Add Unicode/CRLF and partial-invalid JSON fixtures with explicit expected ranges.
- Record cold startup, warm one-file update, invalid/recovery, cancellation, and high-fan-out edit
  baselines, including semantic work, p50/p95 wall time, and peak memory.

Acceptance:

- Every roadmap capability maps to a protocol transcript and Core authority.
- Trust and stale-result behavior are explicit and fail closed.
- Baselines are reproducible and contain no unsupported performance claim.
- No public LSP package or editor-specific Core type lands before Gate 0 is accepted.

### Wave 1: Core editor contracts

#### M3-01 — Source index and editor Query vertical slice (P0)

Status: complete. Snapshot now owns an immutable, transport-neutral source index; Query exposes
exact position, document-symbol, and Context-filtered occurrence operations. The public
`EditorSymbolV1` schema and Unicode/CRLF/invalid-input evidence are locked; this unblocked M3-02.

Deliver:

- Preserve declaration and reference spans/roles from the existing frontend in an immutable source
  index owned by each snapshot.
- Add position lookup, document symbols, exact occurrence queries, and contextual completion facts to
  the public Query facade.
- Retain safe partial facts on invalid input without inventing semantic targets.
- Add deterministic serialization fixtures if an editor query receives a public v1 payload.

Acceptance:

- Alias, JSON Pointer, component field, and inheritance occurrences resolve to the same Graph facts.
- Unicode, escapes, CRLF, nested groups, `$root`, and duplicate IDs have exact ranges.
- Query results are immutable, stable, and contain no LSP types.
- Existing CLI/Query behavior and public contracts remain green.

#### M3-02 — Collision-safe rename planning (P0)

Status: complete. Core now returns deterministic, digest-guarded rename plans only after virtual
recompilation, semantic-equivalence checks, and optional Backend preflight. Canonical, Unicode,
case-folded, reserved, invalid, ambiguous, and Backend collision paths fail closed. M3-03 is next.

Deliver:

- Add a pure Core rename planner over one immutable snapshot and proposed canonical ID.
- Rewrite declarations and every supported reference spelling with digest-guarded edits.
- Virtually recompile the complete edit set and preflight configured Backend symbols/artifacts.
- Return a deterministic ready/rejected/unavailable plan with structured diagnostics.

Acceptance:

- Successful plans preserve resolved values and dependency topology except for the requested ID.
- Canonical, case-folded, Unicode-normalized, reserved-word, and Backend collisions reject before
  edits are exposed.
- Ambiguous or unsupported occurrences fail closed; partial rename is impossible.
- Applying edits in memory and compiling matches the planner's preview exactly.

### Wave 2: Language Server vertical slices

#### M3-03 — Server package and workspace lifecycle (P0)

Status: complete. The public package now pins the LSP 3.17 implementation, exposes a stdio binary
and library factory, and keeps one latest-wins `CompilerSession` per trusted workspace. Config
execution fails closed, multi-root state is isolated, open buffers shadow disk, watched changes are
routed conservatively, and process-level initialize/open/shutdown evidence passes. M3-04 is next.

Deliver:

- Create `@tokenc/language-server` with pinned LSP dependencies, stdio binary, and library factory.
- Implement initialize/shutdown/exit, workspace-folder add/remove, trusted config discovery, source
  loading, open-buffer overlays, and watched-file routing.
- Maintain exactly one `CompilerSession` and latest-work scheduler per workspace folder.

Acceptance:

- A process-level client can initialize, open a fixture project, observe one snapshot, and shut down
  without leaked handles.
- Two workspace folders with equal relative paths never share documents, Context, or diagnostics.
- Untrusted workspaces do not import executable config.
- The package contains no parser, Graph, Resolver, or Backend naming implementation.

#### M3-04 — Diagnostics, recovery, and cancellation (P0)

Status: complete. Diagnostic v1 now maps to LSP 3.17 with exact UTF-16 ranges, related locations,
documentation links, fingerprint/fix metadata, and open-document versions. Publications are
revision-gated and clear removed documents; process tests cover invalid input and automatic
recovery, while active-loader tests prove superseded work does not commit or publish. The accepted
M3-00 evidence did not justify speculative synchronous Core checkpoints, so the existing measured
loader boundary remains the cancellation point. M3-05 is next.

Deliver:

- Map Diagnostic v1 to LSP diagnostics with exact ranges, related information, URLs, and fingerprint
  data.
- Implement incremental text synchronization, version tracking, latest-wins publication, diagnostic
  clearing, and automatic invalid-to-valid recovery.
- Add cooperative Core cancellation checkpoints where the M3-00 baseline proves they are needed.

Acceptance:

- CLI and LSP diagnostic facts are identical for the same source/config/Context.
- Invalid JSON never crashes or replaces current errors with stale valid diagnostics.
- Cancelled/superseded revisions publish no results and never commit Session state.
- Open/change/close and filesystem races converge to the latest authoritative content.

#### M3-05 — Definition, references, and symbols (P0)

Status: complete. Standard LSP definition, references, document-symbol, and workspace-symbol
handlers now project only the settled current Core snapshot. Alias, JSON Pointer, composite-field,
and group-inheritance references navigate to syntax-proven canonical declarations; references
preserve source-index ordering and declaration inclusion, symbols preserve canonical hierarchy, and
invalid/removed-document behavior is covered at library and stdio process levels. Core now indexes
group declarations so inheritance navigation does not guess a server-side target. M3-06 is next.

Deliver:

- Implement definition, references, document symbols, and workspace symbols from the Core source
  index and Query API.
- Preserve exact occurrence roles and deterministic ordering across files and Context regions.

Acceptance:

- Every supported reference form navigates to the canonical declaration.
- References agree exactly with Core usages/source-index facts.
- Removed/renamed files clear results, and invalid documents return only facts proven by the current
  snapshot.

#### M3-06 — Alias completion and Context-aware hover (P0)

Status: complete. Completion is limited to Core-proven alias spans and returns deterministic
canonical candidates with exact replacement ranges. Hover projects type, expression, resolved
value, effective Context, explain provenance, and current diagnostics from one settled snapshot.
Ordinary Context changes remain query-only, Resolver input changes use atomic Session transactions,
and per-workspace state plus superseded configuration events are covered. M3-07 is next.

Deliver:

- Implement completion only for recognized reference positions with stable sort/filter behavior.
- Implement hover for type, expression, resolved value, provenance, active Context, and relevant
  diagnostics.
- Support configuration changes for ordinary Context overrides and Resolver input without conflating
  their semantics.

Acceptance:

- Completion never suggests an invalid or out-of-scope canonical ID.
- Hover values equal `query.resolve()`/`query.explain()` for the same snapshot and Context.
- Changing Context invalidates only the work required by Session metrics and never leaks values
  between workspaces.

#### M3-07 — Rename and code-action transport (P0)

Deliver:

- Map Core rename plans to `prepareRename` and versioned multi-document `WorkspaceEdit` responses.
- Expose validated Diagnostic fixes as preferred quick fixes where safe.
- Revalidate snapshot revision, document versions, and digests before returning edits.

Acceptance:

- Canonical and Backend collisions are surfaced before any client edit.
- Stale, overlapping, or digest-mismatched edits are withheld.
- Applying an accepted rename through a test client produces the planner's predicted snapshot.
- Code actions never expose an edit forbidden by the diagnostic registry.

### Wave 3: editor delivery and release proof

#### M3-08 — Thin VS Code extension and VSIX smoke (P1)

Deliver:

- Add a private VS Code extension that bundles/starts the server, respects Workspace Trust, and
  forwards config plus active Context.
- Provide commands to restart the server and select configured Context/Resolver values; use standard
  hover for resolved previews.
- Build a deterministic VSIX and install it in a clean VS Code test profile during CI.
- Publish bilingual setup, troubleshooting, and feature documentation.

Acceptance:

- Extension code contains no DTCG parsing, Graph traversal, resolution, or rename logic.
- Activation is scoped to DTCG JSON/configured workspaces and does not write user files.
- The VSIX starts the bundled server and passes one edit/diagnostic/navigation smoke flow.
- Marketplace credentials or publication are not required to close M3.

#### M3-09 — Differential proof, performance gates, and `0.6.0` release candidate (P0)

Deliver:

- Run CLI/LSP differential scenarios across deterministic and seeded edit sequences, including
  invalid/recovery and Context changes.
- Gate semantic work for cold startup, one-file edit, high-fan-out edit, and cancellation; publish
  matched-environment p50/p95 and peak-memory evidence.
- Add protocol/process tests, public declaration/schema locks, package/VSIX consumer smoke tests,
  bilingual migration/release docs, and Changesets.
- Verify the synchronized `0.6.0` npm candidates and VSIX from an isolated clean worktree.

Acceptance:

- Every official M3 exit criterion has automated evidence and zero unexplained M1/M2 regression.
- The six public packages pass packed-consumer verification; the VSIX passes clean-profile install
  and activation smoke tests.
- The release workflow verifies registry contents, provenance, requested dist-tag, and six annotated
  package tags before M3 closure.

## 9. Dependencies and critical path

```text
M2 published baseline
        │
        ▼
M3-00 RFC/baseline → M3-01 source index ──────┬→ M3-02 rename planner ───────┐
                                              │                              │
                                              └→ M3-03 server lifecycle      │
                                                        │                    │
                                                        ▼                    │
                                              M3-04 diagnostics/cancellation │
                                                        │                    │
                                          ┌─────────────┴─────────────┐      │
                                          ▼                           ▼      │
                                  M3-05 navigation            M3-06 hover    │
                                          └─────────────┬─────────────┘      │
                                                        ▼                    ▼
                                                  M3-07 edits/rename
                                                        │
                                                        ▼
                                                  M3-08 VS Code
                                                        │
                                                        ▼
                                                  M3-09 release gate
```

- M3-01 is the semantic prerequisite for every cursor-based feature.
- M3-02 may proceed alongside the server skeleton after the source-index contract is accepted.
- M3-04 is the first end-to-end vertical slice and gates all user-facing query features.
- M3-05 and M3-06 may proceed in parallel; M3-07 depends on the rename planner and stable scheduling.
- M3-08 consumes the complete standard protocol and must not become a second implementation.

## 10. Recommended implementation slices

| Order | Slice                 | Primary output                                           | Merge gate                          |
| ----- | --------------------- | -------------------------------------------------------- | ----------------------------------- |
| 1     | Contract and evidence | RFC, protocol corpus, Unicode/invalid fixtures, baseline | all roadmap capabilities mapped     |
| 2     | Editor Query          | immutable source index and cursor facts                  | exact-range and semantic-role tests |
| 3     | Rename planner        | atomic edits and Backend preview                         | virtual recompile differential      |
| 4     | Server skeleton       | package, stdio, workspace lifecycle                      | process init/open/shutdown test     |
| 5     | Diagnostic loop       | overlays, latest-wins, recovery, cancellation            | CLI parity and race matrix          |
| 6     | Navigation            | definition, references, symbols                          | Core/LSP result parity              |
| 7     | Insight               | completion and Context-aware hover                       | resolve/explain parity              |
| 8     | Safe edits            | rename and code actions                                  | stale/digest/collision matrix       |
| 9     | VS Code client        | thin extension and VSIX                                  | clean-profile smoke test            |
| 10    | Release gate          | differential, budgets, contracts, packages               | all M3 exit criteria pass           |

Every slice includes implementation, focused tests, and bilingual documentation. Public behavior
changes include a Changeset. A slice introduces at most one new public contract layer.

## 11. M3 acceptance matrix

| Official exit criterion                                             | Required automated evidence                                                                                                    |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| LSP and CLI return identical diagnostics for one snapshot           | Shared fixture runner comparing normalized Diagnostic v1 facts, codes, fingerprints, locations, related information, and fixes |
| Rename detects canonical and Backend collisions before writing      | Core planner matrix, virtual recompile, all configured Backend preflights, and process-level no-write assertions               |
| Invalid JSON does not crash and recovery is automatic               | Open/change/recover protocol transcripts, current-version diagnostic assertions, and server-process liveness checks            |
| Benchmarks cover cold start, one-file edits, and high-fan-out edits | Checked-in fixtures, semantic-work budgets, p50/p95 latency, peak memory, and cancellation observations                        |
| Protocol layer does not duplicate frontend or Graph logic           | Import-boundary test, source scan, Core/LSP differential queries, and architecture review                                      |

Additional release gates:

- Multi-root workspaces are isolated and deterministic.
- UTF-16/CRLF/URI range conversion is exact.
- Superseded revisions cannot publish diagnostics, hover, navigation, or edits.
- Context and Resolver changes match direct Core queries and Session metrics.
- Code actions and rename are digest/version guarded and never write files server-side.
- All M1/M2 tests, schemas, packed packages, performance gates, and release integrity checks remain
  green.

## 12. Immediate next step

M3-06 is complete. Start M3-07: transport Core rename plans through `prepareRename` and versioned
multi-document `WorkspaceEdit`, then expose only registry-approved Diagnostic fixes as preferred
quick fixes. Revalidate snapshot revision, document versions, and source digests before returning
any edit.
