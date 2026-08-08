# Spyderbyte updater release inputs

Spyderbyte ships one local product. The native updater uses this production endpoint template:

```text
https://updates.spyderbyte.com/v1/updates/{{target}}/{{arch}}/{{current_version}}
```

The release pipeline must provide:

```text
SPYDERBYTE_UPDATE_ENDPOINT=https://updates.spyderbyte.com/v1/updates/{{target}}/{{arch}}/{{current_version}}
SPYDERBYTE_UPDATE_ARTIFACT_BASE_URL=https://updates.spyderbyte.com/releases
SPYDERBYTE_UPDATE_PUBLIC_KEY=<Spyderbyte Tauri updater public key>
SPYDERBYTE_UPDATE_SIGNING_KEY=<release-only private key path or PEM secret>
SPYDERBYTE_RELEASE_CHANNEL=stable|beta|nightly
```

`SPYDERBYTE_UPDATE_PUBLIC_KEY` is embedded into the app. `SPYDERBYTE_UPDATE_SIGNING_KEY` is used
only by `scripts/release/write-update-manifest.mjs` to sign a concrete artifact manifest and must
never be committed, bundled, or passed to the desktop app. The production release gate fails closed
when these values are absent or when either URL is not HTTPS; the artifact base URL must not contain
Tauri template placeholders.

Platform installers use the same signing boundary through
`scripts/release/write-platform-release-manifest.mjs` and
`scripts/release/verify-platform-release-manifest.mjs`. The accepted target matrix is macOS
arm64/x86_64, Linux arm64/x86_64, and Windows x86_64. A manifest cannot be verified if its channel,
target triple, installer format, size, digest, or signature does not match the artifact.
