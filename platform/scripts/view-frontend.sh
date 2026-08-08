#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
host="${HOST:-127.0.0.1}"
port="${PORT:-8443}"
url="http://${host}:${port}/"

cd "$repo_root"

if [[ "${OPEN_BROWSER:-true}" == "true" ]]; then
  (
    for _ in {1..30}; do
      if curl -fsS "$url" >/dev/null 2>&1; then
        case "$(uname -s)" in
          Darwin) open "$url" ;;
          Linux) command -v xdg-open >/dev/null 2>&1 && xdg-open "$url" >/dev/null 2>&1 || true ;;
        esac
        exit 0
      fi
      sleep 1
    done
  ) &
fi

exec pnpm --filter @agentic-platform/web dev --host "$host" --port "$port"
