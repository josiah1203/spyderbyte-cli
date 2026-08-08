# Documentation map

The repository has one active implementation authority and several focused documentation areas.

## Authority and history

- [`SPYDERBYTE_DECLARATIVE_IMPLEMENTATION_PLAN.md`](../SPYDERBYTE_DECLARATIVE_IMPLEMENTATION_PLAN.md) is the active implementation plan and progress ledger.
- [`IMPLEMENTATION_PLAN.md`](../IMPLEMENTATION_PLAN.md), [`SPYDERBYTE_PRODUCTION_IMPLEMENTATION_PLAN.md`](../SPYDERBYTE_PRODUCTION_IMPLEMENTATION_PLAN.md), and [`AGENTIC_PLATFORM_IMPLEMENTATION_PLAYBOOK.md`](../AGENTIC_PLATFORM_IMPLEMENTATION_PLAYBOOK.md) are historical planning records.
- [`PLATFORM_AUDIT.md`](../PLATFORM_AUDIT.md) and [`UPSTREAM_CODEX.md`](../UPSTREAM_CODEX.md) provide audit and provenance context.

## Working references

- [`adr/`](adr/) — architecture decisions and decision templates.
- [`contracts/`](contracts/) — capability inventories, command maps, and contract matrices.
- [`evaluations/`](evaluations/) — evaluation harnesses and gate definitions.
- [`operations/`](operations/) — operational objectives and product metrics.
- [`release/`](release/) — update and release documentation.
- [`runbooks/`](runbooks/) — incident, recovery, and operational procedures.
- [`threat-models/`](threat-models/) — security and control-plane threat models.

## Evidence and generated outputs

Date-stamped acceptance evidence lives under [`audit-artifacts/`](../audit-artifacts/). Checked-in
contract snapshots under `apps/api/generated/` and `packages/runtime-contracts/generated/` are
intentional and must stay synchronized through the contract checks.

Build output such as `target/`, `dist/`, `frontend-dist/`, coverage, caches, and local metadata is
ignored and must not be committed. Run `pnpm verify:tracked-artifacts` when changing build or
release tooling.
