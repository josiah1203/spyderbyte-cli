# ADR-0002: Identifiers, time, money, and units

- Status: Accepted
- Date: 2026-08-02

## Context

Durable workflows, events, approvals, artifacts, and budget records need stable identifiers and
lossless values across local and hosted stores. Ambiguous time zones, floating-point money, and
untyped quantities would make replay and reconciliation unsafe.

## Decision

Use UUIDv7 for newly generated durable identifiers and keep identifiers opaque at package
boundaries. Encode timestamps as UTC ISO 8601 strings with millisecond precision at the wire
boundary; inject a clock in tests. Represent money as an integer minor-unit amount plus an explicit
ISO 4217 currency. Represent measurements as a decimal value plus an explicit unit and dimension;
do not use binary floating point for money or persisted measured values. Hashes use SHA-256 and
are encoded as lowercase hexadecimal strings.

## Alternatives considered

- UUIDv4: valid but loses useful ordering for database indexes and event inspection.
- ULID: viable, but UUIDv7 has a standards-based representation and broad database support.
- Floating-point numbers for money: rejected because rounding would be implicit and unreconcilable.

## Consequences

IDs are sortable by creation time but must never be treated as authorization or causal proof. The
wire codecs need strict validation for precision, currency, unit, and time normalization.

## Migration implications

Legacy identifiers, if introduced, will be wrapped as opaque external IDs and mapped to UUIDv7
internal IDs. A change in precision or units requires a new contract version and an explicit
upcaster.

## Security impact

Identifiers are non-secret references. Tenant scope remains mandatory on every lookup because
time-sortable IDs do not provide tenant isolation.

## Observability impact

Event, trace, and audit records can sort deterministically by UUIDv7 and UTC time while preserving
the original correlation and causation identifiers.

## Rollback or revisit trigger

Revisit if a target database or external protocol cannot safely store UUIDv7, or if a regulated
financial integration requires a currency/precision model beyond the selected minor-unit contract.
