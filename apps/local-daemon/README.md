# Local daemon

`createLocalDaemon` composes the in-memory authoritative state, local CAS artifact registry, agent
registry, deterministic dataset orchestrator, persisted approval gate, and a fail-closed
signed-license gate.
`createSqliteLocalDaemon` switches the same composition to the existing SQLite metadata adapter and
filesystem CAS. `createWorkspaceLocalDaemon` derives both paths and tenant identity from a portable
workspace manifest. The runnable CLI smoke path is:

```sh
pnpm --filter @agentic-platform/local-daemon local:dataset ./fixture.csv
```

It prints a reviewable workflow result as JSON. The dataset command creates a typed plan and waits
in `awaiting_approval`; approve it through the local API before calling the workflow run route. Set
`AGENTIC_LICENSE_FILE` and
`AGENTIC_LICENSE_PUBLIC_KEY` for a valid Spyderbyte entitlement; an absent, expired, or invalid
license blocks the command before artifact staging. Set `AGENTIC_WORKSPACE` to use or create a
portable workspace, otherwise override `AGENTIC_LOCAL_DB` to choose the SQLite file location. SQLite
compositions persist approval records beside the database in a mode-0600 file, which is included in
workspace archives. The daemon also exposes a tenant-bound `BuiltinProjectionReader` that can be
passed directly to the API projection port.

The local HTTP runtime uses the same workspace and daemon composition:

```sh
AGENTIC_WORKSPACE="$PWD/.agentic-workspace" \
  pnpm --filter @agentic-platform/local-daemon local:server
```

It binds to `127.0.0.1:8787` by default and exposes `/health`, `/v1/license/status`, the typed local
API routes, projections, and reconnectable event subscriptions. Configure `AGENTIC_LOCAL_API_PORT`,
`AGENTIC_LOCAL_API_ORIGINS`, and the license variables for a desktop composition. The server only
allows the explicit loopback/webview origins passed in `AGENTIC_LOCAL_API_ORIGINS`.
