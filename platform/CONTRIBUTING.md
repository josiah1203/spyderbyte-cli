# Contributing

Spyderbyte is a pnpm workspace. Use Node.js 22.14.0 and the pnpm version declared by the
repository CI workflow.

Before opening a change, run:

```bash
pnpm install --frozen-lockfile
pnpm verify
git diff --check
```

Contract changes start in `packages/runtime-contracts/schemas/` and must include valid/invalid
fixtures, regenerated outputs, and API/frontend snapshot checks where applicable. Do not put
secrets in source, fixtures, logs, screenshots, or workspace metadata.

Do not commit build or machine-local output such as `target/`, `dist/`, `frontend-dist/`, coverage,
caches, `node_modules/`, or `.DS_Store`. The repository guard is included in `pnpm verify`; run
`pnpm verify:tracked-artifacts` directly when changing build or release tooling.

Local infrastructure is optional for the local-first test suite. When needed, use the checked-in
composition through `pnpm dev:up`, `pnpm dev:health`, and `pnpm dev:down`; `pnpm dev:reset` requires
an explicit confirmation variable because it removes local volumes.
