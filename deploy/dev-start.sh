#!/usr/bin/env bash
# Isolated Docker development launcher for macOS/Linux (dev-start.ps1 on Windows).
# Usage: deploy/dev-start.sh [--build]
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
compose="$repo/deploy/docker-compose.dev.yml"
state="${LOCALQA_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/localqa}"
pid_file="$state/compose-dev-watch.pid"
cd "$repo"

if [ "${1:-}" = "--build" ]; then
  docker compose -f "$compose" build
elif [ $# -gt 0 ]; then
  echo "Usage: $0 [--build]" >&2
  exit 2
fi
docker compose -f "$compose" up -d --wait

mkdir -p "$state"
watch_running() {
  [ -f "$pid_file" ] || return 1
  local pid
  pid="$(cat "$pid_file")"
  ps -p "$pid" -o command= 2>/dev/null | grep -q 'compose.*watch'
}
if watch_running; then
  echo "Compose Watch already running: PID $(cat "$pid_file")"
else
  # Rebuild/restart API and workers on backend source changes; survives this shell.
  nohup docker compose -f "$compose" watch --no-up --prune=false \
    >>"$state/compose-dev-watch.log" 2>>"$state/compose-dev-watch.err.log" &
  echo $! >"$pid_file"
  sleep 2
  if ! watch_running; then
    echo "Compose Watch exited; see $state/compose-dev-watch.err.log" >&2
    exit 1
  fi
  echo "Compose Watch running: PID $(cat "$pid_file")"
fi
echo 'LocalQA development URL: http://localhost:5173'
docker compose -f "$compose" ps
