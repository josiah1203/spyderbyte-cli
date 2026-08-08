#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "macOS architecture verification requires macOS." >&2
  exit 2
fi

app_path="${1:?Usage: verify-macos-architectures.sh <app-path> <architecture>}"
requested_architecture="${2:?Usage: verify-macos-architectures.sh <app-path> <architecture>}"

if [[ ! -d "$app_path" ]]; then
  echo "App bundle not found: $app_path" >&2
  exit 1
fi

case "$requested_architecture" in
  arm64|aarch64) required_architectures=(arm64) ;;
  x86_64|x64) required_architectures=(x86_64) ;;
  universal|universal2) required_architectures=(x86_64 arm64) ;;
  *)
    echo "Unsupported release architecture: $requested_architecture" >&2
    exit 1
    ;;
esac

main_binary="$app_path/Contents/MacOS/agentic-local-edition"
sidecar_binary="$app_path/Contents/MacOS/agentic-local-daemon"
for binary in "$main_binary" "$sidecar_binary"; do
  if [[ ! -f "$binary" ]]; then
    echo "Expected executable is missing from the app bundle: $binary" >&2
    exit 1
  fi
  architecture_info="$(lipo -info "$binary")"
  for required_architecture in "${required_architectures[@]}"; do
    if [[ "$architecture_info" != *"$required_architecture"* ]]; then
      echo "$binary is missing $required_architecture: $architecture_info" >&2
      exit 1
    fi
  done
done

echo "macOS architecture verification passed for ${requested_architecture}: $app_path"
