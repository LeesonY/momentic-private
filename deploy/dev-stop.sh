#!/usr/bin/env bash
# Stops the development stack and its file watcher WITHOUT deleting volumes
# (dev-stop.ps1 on Windows).
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
state="${LOCALQA_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/localqa}"
pid_file="$state/compose-dev-watch.pid"

if [ -f "$pid_file" ]; then
  pid="$(cat "$pid_file")"
  if ps -p "$pid" -o command= 2>/dev/null | grep -q 'compose.*watch'; then
    kill "$pid"
    echo 'Compose Watch stopped.'
  fi
  rm -f "$pid_file"
fi
docker compose -f "$repo/deploy/docker-compose.dev.yml" stop
echo 'Containers stopped; database and credentials preserved.'
