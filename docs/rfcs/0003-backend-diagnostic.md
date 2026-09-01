# RFC 0003: Backend Plan and Diagnostic v1

[简体中文](0003-backend-diagnostic.zh-CN.md)

- Status: Accepted
- Milestone: M1-02 / M1-05 / M1-06
- Updated: 2026-08-30

## Summary

Backends move from `validate(compilation) + emit(compilation)` to two pure phases:
`prepare(ir) → BackendPlan` and `emit(plan) → OutputFile[]`. Plans determine capabilities, symbols,
and artifact paths before any emission. Core performs one global preflight after collecting every
Backend plan; any error prevents every emit.

Every stage uses versioned Diagnostic v1 with stable codes, structured parameters, semantic source
anchors, deterministic fingerprints, documentation URLs, related locations, and optional workspace
edits. This contract directly replaces the existing interfaces, with no legacy Backend or Diagnostic
shape.

## User problem

Backends currently implement naming and value-capability checks independently. `validate()` cannot
declare a complete artifact plan, so cross-Backend path collisions are found only after `emit()` has
already generated content. Third-party Backends have no testable conformance contract.

Diagnostics have codes, messages, locations, and suggestions, but no schema version, stable
fingerprint, documentation link, or machine-applicable edit. CLI JSON is an ad-hoc mapping, and cold
and incremental clients cannot reliably deduplicate the same issue.

## Backend decisions

### 1. Read-only IR and a two-phase contract

```ts
interface TokenBackend<Options, Plan extends BackendPlan> {
  readonly id: string;
  readonly capabilities: BackendCapabilities;
  prepare(input: Readonly<CompilationIR>, options: Readonly<Options>): Promise<Plan> | Plan;
  emit(plan: Plan): Promise<readonly OutputFile[]> | readonly OutputFile[];
}

interface BackendPlan {
  readonly backendId: string;
  readonly diagnostics: readonly DiagnosticV1[];
  readonly symbols: readonly AllocatedSymbol[];
  readonly artifacts: readonly PlannedArtifact[];
}
```

IR is checked, immutable, and Backend-neutral. A Backend cannot access the Parser, mutable Graph, or
Resolver. `prepare` performs every expected validation and stores all normalized data needed by
emission. `emit` cannot rename, reparse Tokens, add artifacts, read the environment, or produce
Diagnostics; it deterministically renders the Plan. An emit throw is a Backend bug and discards the
entire in-memory result.

### 2. Capability negotiation

```ts
interface BackendCapabilities {
  readonly tokenTypes: ReadonlySet<TokenType>;
  readonly referenceStrategies: ReadonlySet<ReferenceStrategy>;
  readonly contextMode: "none" | "finite-selectors" | "runtime";
  readonly colorSpaces: "preserve" | ReadonlySet<ColorSpace>;
  readonly composite: "native" | "serialized-subset" | "none";
}
```

Core checks static capabilities before `prepare`; the Backend checks option-dependent expressibility
during `prepare`. A non-lossless value produces `BACKEND_UNSUPPORTED_VALUE` or a more specific
registry code. It cannot stringify an unknown object, silently drop fields, or implicitly convert a
color space. Capabilities are declarations, not hooks that may mutate IR.

### 3. Shared Symbol Allocator

Backends submit symbol requests rather than detecting collisions themselves:

```ts
interface SymbolNamespace {
  readonly name: string;
  readonly caseSensitive: boolean;
  readonly normalize: "NFC" | "NFKC";
  readonly reserved: ReadonlySet<string>;
  readonly pattern: RegExp;
}
```

The Allocator works per namespace, applying Unicode normalization, case folding when required,
pattern validation, reserved-word validation, and collision checks. Collision diagnostics locate both
Tokens and naming requests. No numeric suffix is appended by default; users resolve conflicts with an
explicit rename map or naming policy. The same Token may use the same string in separate namespaces.

A user naming callback is opaque code and makes plans uncached by default. A callback throw becomes
`BACKEND_NAMING_FAILED`, located at the Token, and publishes no partial symbol table.

### 4. Artifact planning and global preflight

A `PlannedArtifact` declares Backend ID, normalized relative path, media type, contributing Tokens
when applicable, and a Backend-private render payload before emission. Paths must be relative to the
output root and cannot be empty, absolute, contain an escaping `..`, or contain NUL.

After every Backend prepares, Core combines plans and:

- detects global path collisions using the strict common NFC + case-fold filesystem rule;
- detects duplicate Backend artifacts, output-root escape, and invalid paths;
- aggregates capability, symbol, value, and path Diagnostics;
- calls no Backend emit unless every Plan is error-free.

The emitted file set and paths must match the Plan exactly. A mismatch throws `BackendContractError`
and discards all output. Core returns in-memory `OutputFile` values only; the CLI atomically
materializes them with temporary files and rename.

## Diagnostic v1 decisions

### 1. Public structure

```ts
interface DiagnosticV1 {
  readonly schemaVersion: "1";
  readonly code: DiagnosticCode;
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
  readonly parameters: Readonly<Record<string, JsonValue>>;
  readonly fingerprint: string;
  readonly documentationUrl: string;
  readonly source?: DiagnosticLocation;
  readonly related: readonly RelatedDiagnosticV1[];
  readonly fixes: readonly DiagnosticFixV1[];
}

interface DiagnosticLocation {
  readonly document: string;
  readonly range: SourceRange;
  readonly anchor?: SemanticAnchor;
}
```

Arrays are always present and may be empty, avoiding caller-dependent serialization. `message` is for
humans and is never identity or control flow. `parameters` has fixed keys registered for each code.
`documentationUrl` targets the code anchor in versioned documentation.

### 2. Code registry and fingerprint

Core maintains a code registry with owner stage, default severity, parameter schema, documentation
anchor, and fix permission. Backends use `BACKEND_*`, Sessions use `SESSION_*`, and third-party
Backends use a reverse-domain namespace rather than registering Core codes.

The fingerprint is SHA-256 base64url of canonical JSON containing:

```text
schemaVersion, code, canonical document identity,
semantic anchor (token/candidate/field path or JSON pointer),
registry-declared identity parameters
```

Message, severity, display range, related locations, fixes, absolute cwd, and timings are excluded.
A parse error without a semantic anchor falls back to canonical document identity, parser error kind,
and original token offset. Cold and incremental builds of the same source revision must produce the
same fingerprint; it need not survive moving or rewriting the problem itself.

### 3. Fix edits and serialization

```ts
interface DiagnosticFixV1 {
  readonly title: string;
  readonly applicability: "safe" | "requires-review";
  readonly edits: readonly TextEdit[];
}
```

Edits in one fix are canonically ordered by document/range, do not overlap, and carry the expected
document content digest to prevent stale application. Core supplies edits but never writes files.
Advice that cannot be applied mechanically remains in related information or documentation rather
than pretending to be a fix.

JSON output has the fixed top-level shape `{ "schemaVersion": "1", "diagnostics": [...] }`. Object
field order is not protocol, but array order is stable. Consumers ignore unknown fields and reject a
missing required field or unknown major schemaVersion. M1 replaces old CLI JSON directly, without a
dual-format flag.

## Failure modes and diagnostics

- Unsupported type/value/reference strategy: `BACKEND_UNSUPPORTED_*`, located at Token/occurrence.
- Invalid, reserved, or colliding symbol: `BACKEND_SYMBOL_*`, with both locations for collisions.
- Invalid or colliding artifact path: `BACKEND_ARTIFACT_*`, with both Plan owners across Backends.
- Expected Backend callback failure: a structured `BACKEND_*_FAILED`.
- Backend plan-to-emit violation: throw `BackendContractError`; do not disguise it as a user-source
  Diagnostic.
- Invalid code-registry construction: development assertion/test failure; never publish a malformed
  Diagnostic.

## Incremental invalidation

- Fingerprints are build-mode independent; cold and Session builds use one registry factory.
- IR revision or Backend options invalidate a Plan. Graph source-range-only changes update Plan
  provenance.
- Symbol-request changes reallocate their namespace. Implementations may reuse unchanged requests
  only when the result equals full allocation.
- Any artifact-path change reruns global path preflight.
- Backend Plans are uncached by default. Caching requires a stable key covering options, version, and
  every callback behavior.

## Public API changes

- Remove `TokenBackend.validate` and `TokenBackend.emit(compilation)`.
- Remove `backendNameCollisionDiagnostics`; the shared Allocator is the only symbol authority.
- `emit` accepts only a successfully preflighted BackendPlan.
- Replace the current `Diagnostic` and CLI JSON directly with Diagnostic v1.
- Migrate bundled CSS, Tailwind, and TypeScript Backends together in M1-06. Third-party Backends must
  update at the same time.

## Test plan

- Backend conformance suite: capability, symbol, value, Context, and artifact failures all precede
  emission.
- Spy Backends prove every emit call count is zero after any Plan error or cross-Backend path collision.
- Plan-to-emit equality catches missing, extra, multiple, and path-changed files.
- Allocator property tests for Unicode normalization, case, reserved words, invalid leading
  characters, deterministic order, and rename maps.
- Diagnostic JSON schema fixtures, registry completeness, stable order, and unknown-field behavior.
- Cold/incremental fingerprint equality; message/range changes preserve fingerprints while identity
  parameter changes do not.
- Fix digest, ordering, overlap, and cross-document tests.
- Bundled Backend golden output and every existing M0 failure fixture remain semantically unchanged.

## Open questions

None. If review rejects a decision, its replacement and rationale must be recorded here before the
RFC is accepted.

## Explicit non-goals

- Backend mutation of IR or an arbitrary transform pipeline.
- Automatic unstable symbol suffixes.
- Core writing artifacts to disk.
- Downgrading a Backend bug to an ignorable warning.
- Compatibility with Diagnostic v0 or the old Backend API.
- M1 implementations of SARIF, PR annotations, or localized messages; they can consume Diagnostic v1.
