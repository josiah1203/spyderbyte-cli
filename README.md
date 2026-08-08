# Agentic ML/Data Platform

This repository is the TypeScript monorepo for Spyderbyte. The authoritative implementation
contract is [`SPYDERBYTE_DECLARATIVE_IMPLEMENTATION_PLAN.md`](SPYDERBYTE_DECLARATIVE_IMPLEMENTATION_PLAN.md).
[`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md),
[`SPYDERBYTE_PRODUCTION_IMPLEMENTATION_PLAN.md`](SPYDERBYTE_PRODUCTION_IMPLEMENTATION_PLAN.md), and
[`AGENTIC_PLATFORM_IMPLEMENTATION_PLAYBOOK.md`](AGENTIC_PLATFORM_IMPLEMENTATION_PLAYBOOK.md) are
historical evidence records superseded by that plan.

See [`docs/README.md`](docs/README.md) for the documentation map, architecture decisions,
contracts, operations, runbooks, release notes, and audit evidence.

The repository contains a provider-neutral local foundation: versioned runtime contracts, tenant-
scoped state and artifacts, policy and approval enforcement, durable local workflow recovery,
compute and sandbox adapters, lifecycle registries, projection-driven interaction state, and a
local HTTP/SSE surface. Hosted engines and infrastructure remain behind explicit adapter and
provider decision gates recorded in the declarative implementation plan.

## Development

Use Node.js 22.14.0 and pnpm 9.15.9. From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm verify
```

The package directories and their responsibilities are defined in the declarative implementation
plan. The package READMEs and the progress ledger record which local contracts are implemented and
which hosted integrations still require a product or operations decision.
