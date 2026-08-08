#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Spyderbyte DMG packaging requires macOS." >&2
  exit 2
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
app_path="${AGENTIC_APP_PATH:-$root/apps/desktop/src-tauri/target/release/bundle/macos/Spyderbyte.app}"
dmg_dir="${AGENTIC_DMG_DIR:-$root/apps/desktop/src-tauri/target/release/bundle/dmg}"

if [[ ! -d "$app_path" ]]; then
  echo "Expected macOS app bundle was not found: $app_path" >&2
  exit 1
fi

mkdir -p "$dmg_dir"

case "${AGENTIC_RELEASE_ARCHITECTURE:-$(uname -m)}" in
  arm64) architecture="arm64" ;;
  x86_64) architecture="x64" ;;
  universal|universal2) architecture="universal" ;;
  *) architecture="${AGENTIC_RELEASE_ARCHITECTURE:-$(uname -m)}" ;;
esac

output_path="${AGENTIC_DMG_PATH:-$dmg_dir/Spyderbyte_0.0.1_${architecture}.dmg}"
volume_name="${AGENTIC_DMG_VOLUME_NAME:-Spyderbyte}"
staging_dir="$(mktemp -d "${TMPDIR:-/tmp}/agentic-local-edition-dmg.XXXXXX")"
mount_point="$(mktemp -d "${TMPDIR:-/tmp}/agentic-local-edition-mount.XXXXXX")"
mounted=0

cleanup() {
  if [[ "$mounted" -eq 1 ]]; then
    hdiutil detach "$mount_point" >/dev/null 2>&1 || true
  fi
  rm -rf "$staging_dir" "$mount_point"
}
trap cleanup EXIT INT TERM

ditto "$app_path" "$staging_dir/$(basename "$app_path")"
ln -s /Applications "$staging_dir/Applications"

rm -f "$output_path"
hdiutil create \
  -srcfolder "$staging_dir" \
  -volname "$volume_name" \
  -fs HFS+ \
  -format UDZO \
  -imagekey zlib-level=9 \
  -ov \
  "$output_path"

hdiutil attach -nobrowse -readonly -mountpoint "$mount_point" "$output_path" >/dev/null
mounted=1
mounted_app="$(find "$mount_point" -maxdepth 2 -type d -name '*.app' -print -quit)"
if [[ -z "$mounted_app" ]]; then
  echo "Packaged DMG does not contain a macOS app bundle." >&2
  exit 1
fi
if [[ ! -L "$mount_point/Applications" ]]; then
  echo "Packaged DMG does not contain an Applications drop link." >&2
  exit 1
fi

hdiutil detach "$mount_point" >/dev/null
mounted=0

echo "Spyderbyte DMG: $output_path"
checksum="$(shasum -a 256 "$output_path")"
checksum_value="${checksum%% *}"
printf '%s  %s\n' "$checksum_value" "$(basename "$output_path")" > "${output_path}.sha256"
printf '%s\n' "$checksum"
echo "Spyderbyte checksum: ${output_path}.sha256"
node "$root/scripts/release/write-local-release-manifest.mjs" "$output_path" "$app_path" "$architecture"
