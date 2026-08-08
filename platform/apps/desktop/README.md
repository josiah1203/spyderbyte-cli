# Spyderbyte desktop host

This is the Tauri 2 host for the Spyderbyte desktop product. It serves the production Vite
frontend from the canonical React app in `apps/web`, starts the bundled `agentic-local-daemon` sidecar on loopback,
exposes the native runtime configuration needed by the frontend, and is the packaging boundary
for the signed macOS app and DMG.

Development:

```sh
pnpm --filter @agentic-platform/web build
pnpm --filter @agentic-platform/desktop dev
```

The developer build embeds the checked-in development public key and accepts the matching
`apps/desktop/dev/development-entitlement.json` through the normal License import action. To
create a separate development key, run `node scripts/dev/create-development-license.mjs`; the
private signing key is written to the user application-support directory with mode `0600` and is
never packaged.

The release build generates the self-contained daemon sidecar before Tauri packaging:

```sh
CI=true pnpm --filter @agentic-platform/desktop bundle:dmg
```

The provider-neutral cross-platform release wrapper uses the same sidecar and Tauri inputs on a
native runner:

```sh
SPYDERBYTE_RELEASE_PLATFORM=linux SPYDERBYTE_RELEASE_ARCHITECTURE=x86_64 pnpm release:platform
```

It selects macOS DMG, Linux AppImage, or Windows NSIS from the supported target matrix and prints
the artifact path for signed-manifest publication. macOS additionally uses `release:check` for
Developer ID, notarization, Gatekeeper, and mounted-DMG evidence.

The app keeps its mutable default workspace under the macOS application-support directory and
starts the sidecar on an OS-assigned loopback port. The sidecar emits a per-launch bearer session;
the Tauri host delivers the endpoint and token to the bundled webview, and the API also establishes
an HttpOnly session cookie for SSE. Imported signed receipts are stored in the macOS Keychain and
mirrored into a mode-0600 active cache for the daemon. A missing license remains visible in the UI
and blocks licensed effectful operations; importing a signed entitlement atomically replaces the
active cache and is revalidated without restarting the daemon. If the sidecar exits unexpectedly,
the host clears the stale endpoint and retries with bounded exponential backoff while retaining
the app-launch session token; a stable ten-second runtime resets the retry budget. The
single-instance plugin focuses the existing window when the app is launched again.
The sidebar workspace action opens a native macOS folder picker; selecting a folder updates the
workspace manifest/database/CAS root and restarts the supervised daemon while preserving the
application session. The selected root is persisted as a small mode-0600 pointer in application
support, so relaunching the app reopens the same workspace without moving user data into the app
bundle. Storage actions use native save/open/folder dialogs and the authenticated local API to
export `agentic.workspace.archive.v1` archives, preview their checksums and destination, and
restore into a new workspace before restarting the daemon on the restored root. Archives are
integrity protected but not encrypted, so users should choose a protected export location.
The local daemon persists the action-digest-bound workflow approval beside `state.sqlite`; the
Vibe plan review must receive an authorized approval before the run route can execute.

The release gate requires a macOS runner, an Apple Developer ID signing identity, notarization
credentials, a notarization profile, the release Ed25519 public key and key ID, and a clean-machine
verification pass. Run
`pnpm --filter @agentic-platform/desktop release:check` only from a configured macOS release
environment; it fails closed when signing, notarization, license-verification, or the signed smoke
entitlement inputs are absent.

Production packaging also fails closed unless the release supplies the signed execution inputs:

- `SPYDERBYTE_UPDATE_ENDPOINT` and `SPYDERBYTE_UPDATE_PUBLIC_KEY` configure the Tauri updater;
  the endpoint may use Tauri's `{{target}}`, `{{arch}}`, and `{{current_version}}` placeholders.
- `SPYDERBYTE_UPDATE_ARTIFACT_BASE_URL` is the concrete HTTPS prefix used when publishing signed
  update artifacts and must not contain template placeholders.
- `SPYDERBYTE_UPDATE_SIGNING_KEY` is used only by the release job that signs update manifests; it is
  never bundled into the app.
- `SPYDERBYTE_MELTANO_BIN`, `SPYDERBYTE_MELTANO_PUBLIC_KEY`, and
  `SPYDERBYTE_MELTANO_SIGNATURE` bundle and verify the signed Meltano runtime.
- `SPYDERBYTE_BRIDGE_PUBLIC_KEY` plus the four bridge binary/signature pairs bundle and verify the
  Premiere, Resolve, Final Cut, and local media bridges.

`scripts/release/prepare-desktop.mjs` writes the ignored generated Tauri configuration and stages
these runtimes under the app resources directory. Development packaging can omit them and will show
the corresponding capability as unavailable. The release updater endpoint is deliberately supplied
at build time rather than hard-coded as a live production service in this repository. See
`docs/release/spyderbyte-updates.md` for the release input contract.

The release public key and key ID are embedded into the Tauri host at build time and take precedence
over runtime environment values; the private license-signing key is never part of the app or
repository. The developer `bundle:dmg` command may build without release key material, but the
production `release:check` path sets `AGENTIC_RELEASE_BUILD=true` and fails closed if either value
is missing.
