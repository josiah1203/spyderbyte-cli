# Contract documentation

JSON Schema is the authority for public runtime contracts. Generated JSON and Markdown live under
`packages/runtime-contracts/generated/`; run `pnpm contracts:generate` after a schema change and
`pnpm contracts:check` in verification.

The Phase 0 product-truth artifacts are:

- `spyderbyte-capability-inventory.md`: visible capability classifications and authority boundaries;
- `spyderbyte-command-map.md`: first-release command-to-route/service/state/event/error behavior;
- `spyderbyte-capability-matrix.md`: terminal-first surface decision and explicit non-goals.

Every new visible command or capability must update these artifacts and add a contract fixture or
focused behavior test.
