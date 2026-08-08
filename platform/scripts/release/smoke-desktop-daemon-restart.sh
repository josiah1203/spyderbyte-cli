#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Spyderbyte desktop restart smoke requires macOS." >&2
  exit 2
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
app_path="${AGENTIC_APP_PATH:-$root/apps/desktop/src-tauri/target/release/bundle/macos/Spyderbyte.app}"
sidecar_path="$app_path/Contents/MacOS/agentic-local-daemon"
timeout_seconds="${AGENTIC_RESTART_TIMEOUT_SECONDS:-45}"
launched=0
app_pid=""

if [[ ! -d "$app_path" || ! -x "$sidecar_path" ]]; then
  echo "Expected Spyderbyte app bundle was not found: $app_path" >&2
  exit 1
fi

sidecar_pid() {
  if [[ -z "$app_pid" ]]; then return 0; fi
  pgrep -P "$app_pid" -f -- "$sidecar_path" | head -1 || true
}

wait_for_app() {
  local attempt=0
  while (( attempt < timeout_seconds )); do
    app_pid="$(pgrep -f -- "$app_path/Contents/MacOS/agentic-local-edition" | tail -1 || true)"
    if [[ -n "$app_pid" ]]; then return 0; fi
    sleep 1
    attempt=$((attempt + 1))
  done
  return 1
}

wait_for_sidecar() {
  local attempt=0
  local pid
  while (( attempt < timeout_seconds )); do
    pid="$(sidecar_pid)"
    if [[ -n "$pid" ]]; then
      printf '%s\n' "$pid"
      return 0
    fi
    sleep 1
    attempt=$((attempt + 1))
  done
  return 1
}

wait_for_exit() {
  local pid="$1"
  local attempt=0
  while (( attempt < timeout_seconds )); do
    if ! kill -0 "$pid" >/dev/null 2>&1; then return 0; fi
    sleep 1
    attempt=$((attempt + 1))
  done
  return 1
}

cleanup() {
  if [[ "$launched" -eq 1 ]]; then
    osascript -e 'tell application "Spyderbyte" to quit' >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

osascript -e 'tell application "Spyderbyte" to quit' >/dev/null 2>&1 || true
sleep 2
open -na "$app_path"
launched=1
wait_for_app || {
  echo "Spyderbyte app process did not start within ${timeout_seconds}s." >&2
  exit 1
}
initial_pid="$(wait_for_sidecar)" || {
  echo "Spyderbyte sidecar did not start within ${timeout_seconds}s." >&2
  exit 1
}

kill -TERM "$initial_pid"
wait_for_exit "$initial_pid" || {
  echo "Spyderbyte sidecar did not exit after the controlled crash/restart probe." >&2
  exit 1
}

restarted_pid="$(wait_for_sidecar)" || {
  echo "Spyderbyte host did not restart the sidecar within ${timeout_seconds}s." >&2
  exit 1
}
if [[ "$restarted_pid" == "$initial_pid" ]]; then
  echo "Spyderbyte sidecar restart reused the terminated process unexpectedly." >&2
  exit 1
fi

printf '%s\n' "$(JSON_STATUS=daemon_recovered INITIAL_PID="$initial_pid" RESTARTED_PID="$restarted_pid" node -e 'console.log(JSON.stringify({status:process.env.JSON_STATUS,initialPid:Number(process.env.INITIAL_PID),restartedPid:Number(process.env.RESTARTED_PID)}))')"
