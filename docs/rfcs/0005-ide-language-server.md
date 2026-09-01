# RFC 0005: IDE and Language Server Semantics

[简体中文](0005-ide-language-server.zh-CN.md)

- Status: Accepted for M3-00
- Milestone: M3-00 through M3-09
- Updated: 2026-09-01

## Summary

The tokenc language server is a protocol adapter over the existing compiler. Each trusted workspace
folder owns one `CompilerSession`; every diagnostic, navigation target, completion, hover, rename,
and code action is projected from the current immutable Snapshot and Core-owned source facts.

M3-00 fixes workspace trust, document identity, UTF-16 position mapping, open-buffer precedence,
revision ordering, cancellation, invalid-document behavior, editor symbol roles, and atomic rename.
It adds authored protocol fixtures, draft Core contracts, and pre-LSP performance baselines, but no
production language-server package.

## User problem

Design Token authors currently leave the editor to run `tokenc check`, `explain`, or `usages`. A
useful editor integration must answer from unsaved text and recover continuously while a JSON
document is temporarily incomplete. It must not disagree with the CLI, apply a partial rename, show
a resolved value from an obsolete revision, or execute workspace code without trust.

LSP also introduces failure modes that do not exist in a one-shot CLI: edits and filesystem events
race, requests outlive the document version that created them, several workspace folders may use the
same relative paths, and protocol positions count UTF-16 code units rather than bytes or Unicode
code points. These are semantic constraints, not UI details.

## Terms

- **Workspace coordinator:** host-owned state for one LSP workspace folder.
- **Overlay:** the latest complete text of an open editor document, which shadows disk content.
- **Requested revision:** a monotonic workspace number allocated when an input event is accepted.
- **Published revision:** the newest requested revision whose Snapshot may answer requests or publish
  diagnostics.
- **Document version:** the client-provided monotonic version for one open text document.
- **Current invalid Snapshot:** a committed Snapshot representing the latest input even when it has
  diagnostics and cannot provide resolved or Backend facts.
- **Editor source index:** immutable, transport-neutral declarations and reference occurrences
  produced by the Core frontend.

## Decisions

### 1. CompilerSession remains the only semantic lifecycle

One workspace coordinator owns one `CompilerSession`. The coordinator translates trusted config,
filesystem state, overlays, and active Resolver input into atomic Session transactions. It does not
construct `TokenNode`, edges, resolved values, diagnostics, or Backend symbols itself.

Every feature captures one Snapshot reference before querying. A multi-step response cannot mix
facts from different revisions. Multi-root clients use separate coordinators; identical relative
paths in two roots never share caches or identity.

The language server may own scheduling, URI conversion, logging, and protocol serialization. Core
continues to own parsing, linking, Graph operations, checking, Context resolution, incremental cache
validity, and Backend preparation.

### 2. Workspace trust precedes config execution

`tokenc.config.ts`, `.mts`, `.js`, and `.mjs` are executable code. The VS Code extension starts or
enables a configured workspace only after Workspace Trust is granted. A generic LSP client supplies
an explicit trusted initialization/configuration value. Absence of that value means untrusted.

An untrusted coordinator may report that configuration is unavailable, but it must not import the
config, expand its source globs, initialize configured Backends, or infer safety from a filesystem
path. Trust is per workspace folder and can be revoked; revocation closes the Session and clears its
published results.

The server does not execute configuration from Git revisions or from another workspace. M2's trusted
configuration boundary remains authoritative.

### 3. Open buffers are authoritative

For a configured source identity, precedence is:

```text
latest accepted open-buffer version > latest accepted filesystem content > absent
```

LSP incremental changes are applied by the protocol adapter to its buffer. Core receives the full
resulting document in one `DocumentChange`, so editing semantics do not leak into the compiler.
Closing a document removes its overlay and atomically restores the current disk document or removes
the source if it no longer exists.

A config change rebuilds the trusted project inputs and submits configuration plus document changes
as one transaction. Generated Backend output paths remain excluded from watchers. An event that
cannot be classified safely triggers conservative project reload rather than a partial guess.

### 4. Document identity and positions are canonical

Core document identity remains a normalized host string. The LSP adapter owns conversion between
canonical file identities and normalized `file:` URIs. Percent encoding is decoded exactly once;
path separators, drive-letter case, and platform case sensitivity are handled by one tested mapper.
Non-file URI schemes are unavailable in M3 unless a host explicitly supplies their content.

LSP 3.17 positions use zero-based UTF-16 code units. Core `SourceLocation` retains one-based display
line/column plus a zero-based JavaScript string offset and length. The adapter maps positions using
the exact content and document version that produced the Snapshot. It never maps against a newer
buffer. CRLF is one line ending, while the carriage return remains part of the preceding line's
offset span. Astral characters count as two UTF-16 code units.

### 5. Revisions are latest-wins

Each accepted input event allocates a requested revision. At most one Session transaction commits at
a time. A newer revision aborts older pending work and becomes the only revision eligible for
publication.

Completion of an asynchronous operation is insufficient to publish it. Immediately before sending
diagnostics or a response, the coordinator verifies:

- the workspace is still active;
- the captured requested revision equals the latest requested revision;
- every relevant open document still has the captured version;
- the Snapshot is the coordinator's current committed Snapshot.

A result that fails any check is discarded. Responses to explicit requests return LSP cancellation
or an empty/unavailable result as required by the method; notifications publish nothing.

### 6. Cancellation cannot commit partial state

The coordinator aborts superseded work with `AbortController`. `CompilerSession.apply()` already
guards asynchronous loading and commits only after a prepared build succeeds. M3 may add cooperative
abort checkpoints between expensive compiler stages and bounded traversals, but cancellation checks
must not make output timing-dependent.

An aborted transaction:

- does not replace `currentSnapshot` or `lastSuccessfulSnapshot`;
- does not update published revision/document versions;
- does not publish diagnostics or edits;
- leaves the queue able to accept the next transaction.

The M3-00 active-loader benchmark measures cancellation acknowledgement without pretending that it
already measures interruption of synchronous CPU work.

### 7. Invalid current input is not replaced by stale success

The Session commits an invalid Snapshot for invalid current source and retains the last successful
Snapshot only as explicit history. The server publishes diagnostics from the current invalid
Snapshot. It must not answer resolved-value, Backend, hover, or rename requests from the retained
successful Snapshot unless a future protocol explicitly labels that data as stale; M3 defines no
such protocol.

Core may expose source facts that are sound under invalid input. A partial source-index entry must
carry only syntax-proven identity/range information. It cannot invent a target, Context condition,
type, or resolved value. Unsupported requests return null/empty/unavailable rather than throwing.

When repaired text produces a valid Snapshot, the next published revision replaces invalid
diagnostics automatically. Restart is never required for ordinary syntax recovery.

### 8. The editor source index is a Core contract

The frontend already owns JSON syntax nodes, token declarations, dependency occurrences, field
paths, and source locations. It will publish an immutable index rather than making the language
server parse source text again.

Draft `EditorSymbolV1` roles are:

| Role           | Meaning                                                                      |
| -------------- | ---------------------------------------------------------------------------- |
| `declaration`  | Canonical Token declaration key; owner and target are the declared Token.    |
| `alias`        | Curly-alias occurrence targeting a canonical Token.                          |
| `json-pointer` | DTCG `$ref` occurrence normalized to its owning Token/component target.      |
| `inheritance`  | Group `$extends` occurrence targeting the inherited Token/group source fact. |

Each entry has owner, target, exact source span, field path, and optional canonical Context
predicate. Ordering is document identity, source offset, role, owner, then target. Duplicate source
spans are forbidden unless roles represent distinct semantic occurrences.

Position lookup chooses the narrowest containing occurrence, then the normative order above.
Document/workspace symbols derive from the same declaration entries. Definitions and references
join by canonical target identity; Graph queries remain authoritative for semantic usage and Context
filtering.

### 9. Diagnostics preserve Diagnostic v1 identity

The LSP adapter maps Diagnostic v1 without reclassification:

| Diagnostic v1                | LSP                    |
| ---------------------------- | ---------------------- |
| `severity`                   | `DiagnosticSeverity`   |
| `code`                       | `code`                 |
| documentation URL            | `codeDescription.href` |
| message                      | `message`              |
| primary source               | `range`                |
| related sources              | `relatedInformation`   |
| fingerprint and fix identity | `data`                 |

CLI/LSP parity is tested on normalized Diagnostic v1 values before display/transport projection.
The LSP may omit a diagnostic only when its source is outside the addressed workspace; it may not
change code, severity, fingerprint, or source range.

Push diagnostics are used in M3. Pull diagnostics may be added later without changing compiler
semantics.

### 10. Completion, navigation, symbols, and hover are projections

Completion is limited to recognized alias/reference positions. Candidate identities come from Core
Query and source-index facts. The adapter may apply LSP prefix filtering and result limits, but it
cannot invent aliases or infer a second scope model.

Definition resolves the exact occurrence target. References combine the declaration when requested
with indexed occurrences filtered through the same Context predicate semantics as Query usages.
Document and workspace symbols reflect canonical hierarchy and source ownership.

Hover includes canonical ID, type, selected source expression, resolved value, effective Context,
and provenance from Query/explain. On an invalid current Snapshot, unavailable semantic fields are
omitted and relevant current diagnostics may be shown. No stale successful value is substituted.

### 11. Rename is an atomic Core plan

Rename begins only on an unambiguous declaration or reference. Core validates the replacement with
the canonical Token ID authority, finds every supported occurrence, constructs non-overlapping
digest-guarded `TextEdit` values, applies them to an in-memory document set, recompiles, and prepares
all configured Backends.

`RenamePlanV1.status` is:

- `ready` only when coverage is complete, the virtual Snapshot is valid, and Backend preparation has
  no collision or invalid-symbol diagnostics;
- `rejected` for invalid replacement, canonical/Backend collision, edit overlap, or unsupported
  occurrence;
- `unavailable` when the current Snapshot or required document content cannot prove a complete plan.

The server converts only a current `ready` plan to `WorkspaceEdit`. It rechecks workspace revision,
document versions, and content digests immediately before returning. It never writes files itself.

JSON Pointer escaping is structural: path segments are decoded and re-encoded by the Core pointer
authority. Text search-and-replace is forbidden.

### 12. Code actions reuse validated fixes

Code actions are views over Diagnostic v1 fixes. The diagnostic registry remains the authority for
which codes may carry fixes. The server looks up the current diagnostic fingerprint, checks edit
ordering/non-overlap, document versions, and digests, then returns a standard quick fix.

A stale, missing, suppressed, or no-longer-matching diagnostic yields no action. M3 actions do not
modify config, emit generated files, run shell commands, or invoke arbitrary extension code.

### 13. Protocol and package boundary

The first public `@tokenc/language-server` release targets Node.js and LSP 3.17. It provides a stdio
executable and a library factory for process/in-memory tests. It advertises only implemented standard
capabilities:

- incremental text synchronization, internally converted to complete-buffer Session updates;
- push diagnostics;
- completion, definition, references, and hover;
- document/workspace symbols;
- prepare rename and rename;
- code actions.

The VS Code extension contains activation, server launch, Workspace Trust, configuration forwarding,
Context selection, restart/status commands, and packaging only. Its testable VSIX is an M3 artifact,
but marketplace publication is not required for closure.

## Contracts and protocol corpus

M3-01 and M3-02 promote the implemented Core editor contracts to:

- [`editor-symbol-v1.schema.json`](../../packages/core/schema/editor-symbol-v1.schema.json)
- [`rename-plan-v1.schema.json`](../../packages/core/schema/rename-plan-v1.schema.json)

The authored protocol authority is
[`corpus.v1.json`](../../benchmarks/fixtures/editor-protocol/corpus.v1.json). It covers trusted and
untrusted initialization, valid open, invalid/recovery edits, overlay close, diagnostics,
completion, navigation, symbols, Context-aware hover, successful and rejected rename, current and
stale code actions, latest-wins cancellation, multi-root isolation, and UTF-16/CRLF ranges.

`EditorSymbolV1` and `RenamePlanV1` are public after implementation, schema validation,
deterministic tests, and public-contract locking.

## Gate checklist before M3-01

| Gate               | Resolution                                                           | Evidence                                |
| ------------------ | -------------------------------------------------------------------- | --------------------------------------- |
| Semantic authority | Snapshot/Query/Session only; no protocol-side parser or Graph.       | Import boundary and differential tests. |
| Trust              | Executable config requires explicit per-workspace trust.             | Trusted/untrusted transcripts.          |
| Buffer precedence  | Latest accepted open buffer shadows disk until close.                | Open/change/close transcript.           |
| Position model     | LSP UTF-16 mapped against exact versioned text.                      | Unicode, escape, and CRLF anchors.      |
| Revision ordering  | Only latest requested/current committed revision may publish.        | Cancellation transcript and race tests. |
| Invalid state      | Current errors publish; resolved/Backend facts are unavailable.      | Invalid/recovery transcript.            |
| Rename atomicity   | Complete virtual recompile plus all Backend preflights before edits. | Ready/collision/stale fixtures.         |
| Server writes      | Rename/code actions return plans only.                               | Process-level filesystem hash checks.   |

## Performance baseline

M3-00 adds five pre-LSP cases to the existing isolated benchmark runner:

- cold Session startup plus representative Query projection for 1,200 Tokens;
- one-file warm update in the same layered project;
- invalid JSON publication followed by valid recovery;
- one primitive edit with 2,000 direct consumers;
- cancellation of an active loader-backed transaction without a Session commit.

Fixture generation and Session initialization for warm cases stay outside timed regions. Each report
records fixture digest, raw timing samples, compiler stage timings, Session semantic counters,
semantic hash, p50/p95, and isolated-process peak RSS. Wall-clock budgets remain advisory until M3-09
has matched CI evidence; exact Token/reference/change/affected/recomputed counts are gates now.

The cancellation case measures the currently supported asynchronous loader boundary. It does not
claim mid-parser CPU interruption. M3-04 must use the baseline to decide where cooperative Core
checkpoints are necessary.

## Test plan

- Validate that every required IDE behavior appears in the authored protocol corpus.
- Validate workspace trust, file URI containment, unique transcript identity, and non-empty expected
  outcomes.
- Lock exact UTF-16 offsets and positions for CRLF text containing astral Unicode.
- Compile the corpus's valid, invalid, and recovered text with current Core.
- Run all five baseline invocations and fail on semantic counter or hash drift.
- Validate both public editor schemas as strict versioned contracts.
- In M3-01 through M3-07, turn each authored transcript into a Core or process-level differential
  test rather than replacing the expectation with captured output.

## Rejected alternatives

- **Use a JSON language service as the semantic engine:** it cannot reproduce tokenc linking,
  Context, Resolver, diagnostic, or Backend rules and would cause CLI/LSP drift.
- **Keep one global Session:** relative paths, config, Context, and cancellation would leak across
  workspace folders.
- **Read disk on every request:** it ignores unsaved edits and introduces race-dependent answers.
- **Use the last valid Snapshot during syntax errors:** it presents stale values as current facts.
- **Let the server apply rename edits:** it bypasses client version checks and editor transaction UX.
- **Rename with textual replacement:** it mishandles JSON Pointer escaping, component occurrences,
  Contexts, and Backend collisions.
- **Count Unicode code points:** LSP 3.17 positions are UTF-16 code units.
- **Start with custom protocol/UI:** it binds semantics to one editor before standard LSP behavior is
  proven.
- **Require marketplace publication for M3:** credentials and store review do not prove compiler or
  protocol correctness; a reproducible VSIX does.

## Open questions

None for Gate 0 or the public M3-01/M3-02 editor contracts.

## Explicit non-goals

- A production `@tokenc/language-server` package in M3-00.
- VS Code Marketplace publication.
- Semantic tokens, formatting, inlay hints, color decorators, graph/diff Webviews, or custom editor
  protocol.
- Persistent caches, worker pools, remote indexing, or browser transport.
- General lint/importer/plugin APIs or new Backend formats.
