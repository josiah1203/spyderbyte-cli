# Runtime contracts

This package is the single schema authority for versioned commands, workflows, invocations,
reports, artifacts, events, approvals, budgets, authority, resources, failures, agent
registrations, capabilities, notebooks, and Jupyter sessions. It provides strict TypeScript
contracts, Ajv validation, canonical JSON Schema, generated documentation, deterministic
serialization, pure state machines, and the shared error taxonomy.

Phase 0 fixtures in `tests/fixtures.ts` cover provider configuration/credential/model records,
runtime profiles and environment revisions, runs and attempts, artifacts, notebooks, Jupyter
sessions, approvals, capabilities, and the foundational command/event contracts. Every fixture is
validated and round-tripped by the contract test suite.
