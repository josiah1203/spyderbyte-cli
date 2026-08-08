#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Spyderbyte DMG release requires macOS." >&2
  exit 2
fi

: "${APPLE_SIGNING_IDENTITY:?Set APPLE_SIGNING_IDENTITY to the Developer ID Application identity}"
: "${APPLE_NOTARIZATION_PROFILE:?Set APPLE_NOTARIZATION_PROFILE to the notarytool keychain profile}"
: "${AGENTIC_LICENSE_PUBLIC_KEY:?Set AGENTIC_LICENSE_PUBLIC_KEY to the Spyderbyte Ed25519 public key}"
: "${AGENTIC_LICENSE_KEY_ID:?Set AGENTIC_LICENSE_KEY_ID to the active Spyderbyte license key ID}"
: "${AGENTIC_SMOKE_LICENSE_FILE:?Set AGENTIC_SMOKE_LICENSE_FILE to an entitlement signed by the active release key}"
: "${SPYDERBYTE_UPDATE_ENDPOINT:?Set SPYDERBYTE_UPDATE_ENDPOINT to the production HTTPS updater endpoint}"
: "${SPYDERBYTE_UPDATE_ARTIFACT_BASE_URL:?Set SPYDERBYTE_UPDATE_ARTIFACT_BASE_URL to the concrete HTTPS release-artifact base URL}"
: "${SPYDERBYTE_UPDATE_PUBLIC_KEY:?Set SPYDERBYTE_UPDATE_PUBLIC_KEY to the Tauri updater public key}"
: "${SPYDERBYTE_MELTANO_BIN:?Set SPYDERBYTE_MELTANO_BIN to the signed Meltano executable}"
: "${SPYDERBYTE_MELTANO_PUBLIC_KEY:?Set SPYDERBYTE_MELTANO_PUBLIC_KEY to the Meltano runtime public key}"
: "${SPYDERBYTE_MELTANO_SIGNATURE:?Set SPYDERBYTE_MELTANO_SIGNATURE to the detached Meltano signature}"
: "${SPYDERBYTE_BRIDGE_PUBLIC_KEY:?Set SPYDERBYTE_BRIDGE_PUBLIC_KEY to the signed local-bridge public key}"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

release_architecture="${AGENTIC_RELEASE_ARCHITECTURE:-$(uname -m)}"
case "$release_architecture" in
  arm64|aarch64)
    release_target="aarch64-apple-darwin"
    release_suffix="arm64"
    export AGENTIC_SIDECAR_TARGETS="$release_target"
    ;;
  x86_64|x64)
    release_target="x86_64-apple-darwin"
    release_suffix="x64"
    export AGENTIC_SIDECAR_TARGETS="$release_target"
    ;;
  universal|universal2)
    release_target="universal-apple-darwin"
    release_suffix="universal"
    export AGENTIC_SIDECAR_TARGETS="x86_64-apple-darwin,aarch64-apple-darwin"
    ;;
  *)
    echo "Unsupported Spyderbyte release architecture: $release_architecture" >&2
    exit 1
    ;;
esac

node scripts/release/prepare-desktop.mjs
# Build the app bundle separately. DMG creation is handled by the repository-owned
# hdiutil packager below so release verification does not depend on Finder automation.
AGENTIC_RELEASE_BUILD=true CI=true pnpm --dir apps/desktop exec tauri build --config src-tauri/tauri.generated.conf.json --target "$release_target" --bundles app

app_path="$(find apps/desktop/src-tauri/target/release/bundle/macos -maxdepth 1 -name '*.app' -print -quit)"
if [[ -z "$app_path" ]]; then
  echo "Tauri did not produce the signed macOS app bundle." >&2
  exit 1
fi

bash scripts/release/verify-macos-architectures.sh "$app_path" "$release_architecture"

codesign --verify --deep --strict --verbose=2 "$app_path"
spctl --assess --type execute --verbose=4 "$app_path"

AGENTIC_RELEASE_BUILD=true AGENTIC_RELEASE_ARCHITECTURE="$release_architecture" \
  bash scripts/release/package-local-dmg.sh
dmg_path="apps/desktop/src-tauri/target/release/bundle/dmg/Spyderbyte_0.0.1_${release_suffix}.dmg"
if [[ ! -f "$dmg_path" ]]; then
  echo "Tauri did not produce the macOS DMG." >&2
  exit 1
fi
checksum_path="${dmg_path}.sha256"
if [[ ! -f "$checksum_path" ]]; then
  echo "Spyderbyte DMG checksum sidecar is missing." >&2
  exit 1
fi
manifest_path="${dmg_path}.manifest.json"
if [[ ! -f "$manifest_path" ]]; then
  echo "Spyderbyte DMG release manifest is missing." >&2
  exit 1
fi
(cd "$(dirname "$dmg_path")" && shasum -a 256 -c "$(basename "$checksum_path")")

# Tauri uses APPLE_SIGNING_IDENTITY for the app and nested sidecar signing. The
# release gate uses an explicit notarytool keychain profile so credentials never
# enter the repository or command-line arguments as plaintext secrets.
xcrun notarytool submit "$dmg_path" --keychain-profile "$APPLE_NOTARIZATION_PROFILE" --wait
xcrun stapler staple "$dmg_path"
xcrun stapler validate "$dmg_path"

mount_point="$(mktemp -d /tmp/agentic-local-edition-dmg.XXXXXX)"
trap 'hdiutil detach "$mount_point" >/dev/null 2>&1 || true' EXIT
hdiutil attach -nobrowse -readonly -mountpoint "$mount_point" "$dmg_path" >/dev/null
mounted_app="$(find "$mount_point" -maxdepth 2 -name '*.app' -print -quit)"
if [[ -z "$mounted_app" ]]; then
  echo "The notarized DMG does not contain a macOS app bundle." >&2
  exit 1
fi
codesign --verify --deep --strict --verbose=2 "$mounted_app"
spctl --assess --type execute --verbose=4 "$mounted_app"
AGENTIC_SMOKE_LICENSE_FILE="$AGENTIC_SMOKE_LICENSE_FILE" \
AGENTIC_SMOKE_LICENSE_PUBLIC_KEY="$AGENTIC_LICENSE_PUBLIC_KEY" \
AGENTIC_SMOKE_LICENSE_KEY_ID="$AGENTIC_LICENSE_KEY_ID" \
  node scripts/release/smoke-packaged-sidecar.mjs "$mounted_app/Contents/MacOS/agentic-local-daemon"
hdiutil detach "$mount_point" >/dev/null
trap - EXIT

shasum -a 256 "$dmg_path"

echo "Spyderbyte DMG release checks passed: $dmg_path"
