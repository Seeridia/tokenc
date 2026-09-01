# Diagnostic v1 Code Reference

Diagnostic v1 is the machine-readable error contract shared by Core, the CLI, and bundled
backends. The JSON Schema is published as `@tokenc/core/diagnostic-v1.schema.json`. Every diagnostic
contains a stable code, structured parameters, semantic source identity, a SHA-256 base64url
fingerprint, related information, and a fixes array.

Messages and display ranges are presentation data and do not define identity. Consumers should use
`fingerprint` for deduplication and `code` plus `parameters` for control flow. A fix may be applied
only when every edit's `expectedDocumentDigest` still matches the document.

## Policy diagnostics

The following finding codes use `ruleId + changeId` as stable identity parameters. Severity is set
by Breaking-change Policy v1 and does not affect the fingerprint:

- `POLICY_TOKEN_REMOVAL`
- `POLICY_TOKEN_TYPE_CHANGE`
- `POLICY_CONTEXT_COVERAGE_LOSS`
- `POLICY_BACKEND_SYMBOL_REMOVAL`
- `POLICY_BACKEND_ARTIFACT_PATH_REMOVAL`
- `POLICY_DIRECT_VALUE_CHANGE`
- `POLICY_PROPAGATED_VALUE_CHANGE`

`POLICY_UNKNOWN_RULE`, `POLICY_STALE_ALLOW`, `POLICY_INVALID_CONFIG`, and
`POLICY_INCOMPLETE_COMPARISON` are fail-closed policy diagnostics. Allow entries never remove a
finding and never suppress diagnostics carried by the underlying Snapshot Diff.

## Resolver permutation diagnostics

`RESOLVER_PERMUTATION_UNKNOWN_FILTER` and `RESOLVER_PERMUTATION_INVALID_FILTER` reject unknown
dimensions and undeclared exact values before enumeration.

`RESOLVER_PERMUTATION_INVALID_LIMIT`, `RESOLVER_PERMUTATION_LIMIT_REQUIRED`, and
`RESOLVER_PERMUTATION_LIMIT_EXCEEDED` enforce a positive safe-integer bound for every plan with more
than one combination. Invalid plans are not iterable.

`RESOLVER_PERMUTATION_OUTPUT_COLLISION` reports an artifact path shared by two selected Contexts
under portable NFC and case-folding rules. The complete batch is prepared before this check, and a
collision prevents all optional emission.

## Backend diagnostics

### backend-context-coverage

`BACKEND_CONTEXT_COVERAGE` — the backend cannot represent every required Context region.

### backend-invalid-context-selector

`BACKEND_INVALID_CONTEXT_SELECTOR` — a configured backend selector is invalid or ambiguous.

### backend-symbol-invalid

`BACKEND_SYMBOL_INVALID` — a generated platform symbol does not match its namespace pattern.

### backend-symbol-reserved

`BACKEND_SYMBOL_RESERVED` — a generated platform symbol is reserved by its namespace.

### backend-symbol-collision

`BACKEND_SYMBOL_COLLISION` — multiple Tokens allocate the same normalized platform symbol.

### backend-naming-failed

`BACKEND_NAMING_FAILED` — a Backend naming callback threw while planning a symbol.

### backend-artifact-invalid-path

`BACKEND_ARTIFACT_INVALID_PATH` — a planned artifact path is not a normalized relative path.

### backend-artifact-collision

`BACKEND_ARTIFACT_COLLISION` — multiple planned artifacts normalize to the same output path.

### backend-unsupported-type

`BACKEND_UNSUPPORTED_TYPE` — a token type is absent from the Backend capability declaration.

### backend-unsupported-color-space

`BACKEND_UNSUPPORTED_COLOR_SPACE` — a color space cannot be preserved by the Backend.

### backend-unsupported-context

`BACKEND_UNSUPPORTED_CONTEXT` — the requested Context output cannot be represented by the Backend.

### backend-unsupported-reference-strategy

`BACKEND_UNSUPPORTED_REFERENCE_STRATEGY` — the Backend declares no supported strategy for a reference.

### backend-unsupported-value

`BACKEND_UNSUPPORTED_VALUE` — a value cannot be represented losslessly by the backend.

## DTCG diagnostics

### dtcg-group-extends-cycle

`DTCG_GROUP_EXTENDS_CYCLE` — group inheritance contains a cycle.

### dtcg-group-extends-invalid-target

`DTCG_GROUP_EXTENDS_INVALID_TARGET` — `$extends` does not identify a valid group.

### dtcg-invalid-color

`DTCG_INVALID_COLOR` — a color does not conform to the supported DTCG representation.

### dtcg-invalid-composite-value

`DTCG_INVALID_COMPOSITE_VALUE` — a composite value has invalid fields or field values.

### dtcg-invalid-cubic-bezier

`DTCG_INVALID_CUBIC_BEZIER` — a cubic Bézier value is invalid.

### dtcg-invalid-deprecated

`DTCG_INVALID_DEPRECATED` — `$deprecated` is not a boolean or string.

### dtcg-invalid-description

`DTCG_INVALID_DESCRIPTION` — `$description` is not a string.

### dtcg-invalid-extensions

`DTCG_INVALID_EXTENSIONS` — `$extensions` is not an object.

### dtcg-invalid-group-extends

`DTCG_INVALID_GROUP_EXTENDS` — a group `$extends` declaration is malformed.

### dtcg-invalid-group-member

`DTCG_INVALID_GROUP_MEMBER` — a group member is not a valid Token or group.

### dtcg-invalid-group-property

`DTCG_INVALID_GROUP_PROPERTY` — a group contains an unsupported reserved property.

### dtcg-invalid-json-pointer

`DTCG_INVALID_JSON_POINTER` — a JSON Pointer is malformed.

### dtcg-invalid-resolution-order

`DTCG_INVALID_RESOLUTION_ORDER` — a Resolver resolution order is missing or malformed.

### dtcg-invalid-resolution-source

`DTCG_INVALID_RESOLUTION_SOURCE` — a Resolver source declaration is invalid.

### dtcg-invalid-resolver-default

`DTCG_INVALID_RESOLVER_DEFAULT` — a Resolver default does not name a declared Context.

### dtcg-invalid-resolver-document

`DTCG_INVALID_RESOLVER_DOCUMENT` — a Resolver document is syntactically or structurally invalid.

### dtcg-invalid-resolver-input

`DTCG_INVALID_RESOLVER_INPUT` — a supplied Resolver input is not declared.

### dtcg-invalid-resolver-modifier

`DTCG_INVALID_RESOLVER_MODIFIER` — a Resolver modifier is invalid.

### dtcg-invalid-resolver-reference

`DTCG_INVALID_RESOLVER_REFERENCE` — a Resolver reference has an invalid target.

### dtcg-invalid-resolver-reference-override

`DTCG_INVALID_RESOLVER_REFERENCE_OVERRIDE` — a Resolver reference override is invalid.

### dtcg-invalid-resolver-version

`DTCG_INVALID_RESOLVER_VERSION` — the Resolver version is unsupported or malformed.

### dtcg-invalid-token-name

`DTCG_INVALID_TOKEN_NAME` — a Token path segment is invalid.

### dtcg-invalid-token-property

`DTCG_INVALID_TOKEN_PROPERTY` — a Token contains an unsupported reserved property.

### dtcg-invalid-token-structure

`DTCG_INVALID_TOKEN_STRUCTURE` — an object mixes incompatible Token and group structure.

### dtcg-json-pointer-invalid-array-index

`DTCG_JSON_POINTER_INVALID_ARRAY_INDEX` — a JSON Pointer array index is invalid.

### dtcg-json-pointer-invalid-target

`DTCG_JSON_POINTER_INVALID_TARGET` — a JSON Pointer resolves to an unsupported target.

### dtcg-json-pointer-not-found

`DTCG_JSON_POINTER_NOT_FOUND` — a JSON Pointer target does not exist.

### dtcg-resolver-circular-reference

`DTCG_RESOLVER_CIRCULAR_REFERENCE` — Resolver set references contain a cycle.

### dtcg-resolver-missing-input

`DTCG_RESOLVER_MISSING_INPUT` — a required Resolver modifier input was omitted.

### dtcg-resolver-single-context

`DTCG_RESOLVER_SINGLE_CONTEXT` — a modifier would not provide multiple Context choices.

### dtcg-resolver-source-not-found

`DTCG_RESOLVER_SOURCE_NOT_FOUND` — a Resolver source document was not loaded.

### dtcg-unknown-modifier

`DTCG_UNKNOWN_MODIFIER` — a resolution-order entry names an unknown modifier.

### dtcg-unknown-set

`DTCG_UNKNOWN_SET` — a resolution-order entry names an unknown set.

### dtcg-unsupported-color-space

`DTCG_UNSUPPORTED_COLOR_SPACE` — the declared color space is not supported.

### dtcg-unsupported-external-json-pointer

`DTCG_UNSUPPORTED_EXTERNAL_JSON_POINTER` — an external JSON Pointer is not supported here.

### dtcg-unsupported-resolver-reference

`DTCG_UNSUPPORTED_RESOLVER_REFERENCE` — a Resolver reference form is unsupported.

## Token diagnostics

### token-cannot-infer-type

`TOKEN_CANNOT_INFER_TYPE` — the Token type cannot be inferred from its declarations or references.

### token-circular-reference

`TOKEN_CIRCULAR_REFERENCE` — active dependency edges contain a cycle.

### token-context-domain-mismatch

`TOKEN_CONTEXT_DOMAIN_MISMATCH` — Context predicates use incompatible domains.

### token-context-invalid-default

`TOKEN_CONTEXT_INVALID_DEFAULT` — a Context default is not in its declared value set.

### token-context-predicate-limit

`TOKEN_CONTEXT_PREDICATE_LIMIT` — canonical predicate construction exceeded its safety bound.

### token-context-unknown-dimension

`TOKEN_CONTEXT_UNKNOWN_DIMENSION` — an override names an undeclared Context dimension.

### token-context-unknown-value

`TOKEN_CONTEXT_UNKNOWN_VALUE` — an override names an undeclared Context value.

### token-duplicate-id

`TOKEN_DUPLICATE_ID` — multiple source declarations have the same canonical Token ID.

### token-invalid-context-extension

`TOKEN_INVALID_CONTEXT_EXTENSION` — the Context extension is malformed.

### token-invalid-context-selector

`TOKEN_INVALID_CONTEXT_SELECTOR` — a Context selector is malformed.

### token-invalid-json

`TOKEN_INVALID_JSON` — a Token document is not valid JSON or has no root object.

### token-invalid-reference

`TOKEN_INVALID_REFERENCE` — an alias spelling is invalid.

### token-invalid-type

`TOKEN_INVALID_TYPE` — `$type` does not name a supported Token type.

### token-invalid-value

`TOKEN_INVALID_VALUE` — a Token value is invalid for its type.

### token-missing-type

`TOKEN_MISSING_TYPE` — a Token has no explicit, inherited, or inferable type.

### token-reference-type-mismatch

`TOKEN_REFERENCE_TYPE_MISMATCH` — a whole-Token reference targets a different Token type.

### token-resolution-ambiguous

`TOKEN_RESOLUTION_AMBIGUOUS` — multiple candidates have the same effective selector precedence.

### token-unknown-reference

`TOKEN_UNKNOWN_REFERENCE` — a reference target does not exist.
