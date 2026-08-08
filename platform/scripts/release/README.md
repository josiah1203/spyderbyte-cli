# Release scripts

Release and migration gates belong here after the runtime contracts and deployment topology are
defined.

`write-platform-release-manifest.mjs` and `verify-platform-release-manifest.mjs` are the
provider-neutral release record boundary for macOS arm64/x86_64, Linux arm64/x86_64, and Windows
x86_64 artifacts. They accept only the stable, beta, or nightly channels, bind the installer and
target triple to that platform/architecture pair, record size and SHA-256, and sign/verify the
canonical manifest payload with the release Ed25519 key. The private key is read only by the
release job; verification requires `SPYDERBYTE_UPDATE_PUBLIC_KEY`.

`build-platform-release.mjs` selects the same matrix entry for the native runner, prepares the
signed sidecar and frontend inputs, invokes Tauri for the platform installer, and prints the exact
artifact paths to feed into the manifest commands. Use `SPYDERBYTE_RELEASE_PLATFORM` and
`SPYDERBYTE_RELEASE_ARCHITECTURE` on native Linux or Windows runners; macOS release credentials
still flow through `release:check` for signing, notarization, and Gatekeeper evidence.

`package-local-dmg.sh` creates the Spyderbyte DMG from the already-built app bundle using
`hdiutil` only. It intentionally does not use Finder automation, so the same packager works on a
headless macOS release runner. Set `AGENTIC_RELEASE_ARCHITECTURE=universal` when the app bundle
and nested sidecar have both architectures; the default output is host-architecture-specific. It
also writes a matching `.sha256` checksum sidecar and a machine-readable `.manifest.json` release
record next to the DMG. The manifest records the artifact digest, bundle metadata, architecture
inspection, lockfile/config digests, toolchain versions, and whether the build was a developer or
production-keyed release.

`build-local-sidecar.mjs` emits Tauri's target-triple sidecar names for the supported macOS, Linux,
and Windows targets. The macOS release check selects the matching Rust target and verifies both the
app executable and sidecar with `lipo`; a universal release fails closed unless both `x86_64` and
`arm64` slices are present.
The sidecar builder also fails early with a clear message when an Intel host is asked to produce
the arm64 `pkg` executable; use an Apple Silicon release runner for the universal sidecar build.

`smoke-packaged-sidecar.mjs` is run against the mounted release app by the signed release check. It
proves the packaged sidecar can validate a signed offline license, authenticate the local API,
publish a source artifact, wait on an approval, accept the approval, complete the workflow, read
the authoritative workflow/artifact projections and lineage, and export, back up, preview, and
restore the portable workspace.

The default smoke inputs are the real development entitlement and public key under
`apps/desktop/dev`; set `AGENTIC_SMOKE_LICENSE_FILE`, `AGENTIC_SMOKE_LICENSE_PUBLIC_KEY_FILE`,
and `AGENTIC_SMOKE_LICENSE_KEY_ID_FILE` for a production-keyed release smoke. The smoke no longer
generates an ephemeral signing key.

`smoke-desktop-daemon-restart.sh` is the clean-Mac GUI smoke for the Tauri supervisor. It launches
the app, records the managed sidecar PID, sends that sidecar a controlled termination, and requires
the host to start a replacement process before quitting the app. Run it only on a disposable test
workspace or a clean test account.

The developer `bundle:dmg` path is useful for local packaging but does not invent license key
material. A distributable release must use `release:check`, which embeds the supplied public key and
key ID and fails closed when either is absent.

`build-desktop.mjs` keeps the root workspace build portable: macOS builds the app bundle by
default, while non-macOS CI compiles the Tauri Rust host without attempting to produce an
installer. `build-platform-release.mjs` is the explicit native-runner path for platform installers;
`bundle:dmg` remains the macOS-only developer packaging shortcut.
