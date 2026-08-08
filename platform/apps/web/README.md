# Spyderbyte React frontend

This package is the canonical product UI for Aug. It is a React/Vite application that renders the
local-first Spyderbyte workflow surface and consumes the managed runtime through the
typed `/v1` HTTP and SSE contracts.

Run the browser frontend from the Aug repository with:

```sh
pnpm --filter @agentic-platform/web dev
```

The development Vite server starts the local daemon and proxies `/v1` requests same-origin. Set
`AGENTIC_MANAGED_RUNTIME=false` when the Tauri host supplies runtime configuration through
`local_runtime_config`.

The visual application lives under `src/components`, `src/contexts`, `src/runtime`, and
`src/screens`. The compatibility interaction model and transport remain under `src/compat` and
are re-exported from `src/index.ts` and `src/client.ts` for existing Aug tests and consumers.

The design-system audit runs with:

```sh
pnpm --filter @agentic-platform/web audit:design-system
```

The release script builds this package and copies `dist` into the Tauri frontend boundary. The
`AGENTIC_FRONTEND_ROOT` environment variable is retained only as an explicit migration override.
