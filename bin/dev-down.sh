#!/usr/bin/env bash
# dev-down.sh — stop everything this project starts. Idempotent.
#
# Scope is deliberately narrow. This box runs more than one local Supabase stack
# (project-running holds 54321-54327), so the stop is pinned to this project's id
# and can never reach another project's containers. Ollama is a shared system
# service and is left alone.
#
# The Flutter app is not covered: `dev:run:mobile` runs in the foreground, so it
# stops with Ctrl-C.
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
BACKEND="$REPO_ROOT/apps/backend"

PROJECT_ID=project-stocks
WEB_PORT=7777

blue=$'\033[34m'; green=$'\033[32m'; yellow=$'\033[33m'; reset=$'\033[0m'
step() { echo "${blue}==>${reset} $*"; }
ok()   { echo "  ${green}ok${reset} $*"; }
warn() { echo "  ${yellow}warn${reset} $*"; }

stopped_anything=false

# --- web dev server --------------------------------------------------------
step "Web dev server (port ${WEB_PORT})"
web_pids=$(lsof -ti "tcp:${WEB_PORT}" -sTCP:LISTEN 2>/dev/null || true)

if [ -z "$web_pids" ]; then
  ok "not running"
else
  for pid in $web_pids; do
    # Only ever kill something that looks like the dev server. Port 7777 is not
    # reserved, and killing an unrelated process because it happened to bind
    # first would be a genuinely bad trade for a convenience script.
    comm=$(ps -o comm= -p "$pid" 2>/dev/null || true)
    if [[ "$comm" != *node* ]]; then
      warn "pid ${pid} holds ${WEB_PORT} but is '${comm}', not node — leaving it alone"
      continue
    fi

    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$pid" 2>/dev/null; then
      warn "pid ${pid} ignored SIGTERM — sending SIGKILL"
      kill -9 "$pid" 2>/dev/null || true
    fi
    ok "stopped pid ${pid}"
    stopped_anything=true
  done
fi

# --- supabase --------------------------------------------------------------
step "Supabase stack (${PROJECT_ID})"
if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q "_${PROJECT_ID}\$"; then
  ok "not running"
else
  # --project-id is explicit on purpose: a bare `supabase stop` resolves the id
  # from the config file it happens to find, and this repo is not the only
  # Supabase project on the machine.
  #
  # No --no-backup: the default keeps a dump so `pnpm dev:core` restores your
  # data. Losing an imported portfolio to a stop command would be a nasty
  # surprise; `pnpm dev:db:reset` is the explicit way to start clean.
  ( cd "$BACKEND" && supabase stop --project-id "$PROJECT_ID" >/dev/null 2>&1 ) || true

  if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "_${PROJECT_ID}\$"; then
    warn "containers still up — try: cd apps/backend && supabase stop --project-id ${PROJECT_ID}"
  else
    ok "stopped (database preserved for the next start)"
    stopped_anything=true
  fi
fi

# --- what was deliberately left running ------------------------------------
others=$(docker ps --format '{{.Names}}' 2>/dev/null | sed -n 's/^supabase_db_//p' | grep -v "^${PROJECT_ID}\$" || true)
if [ -n "$others" ]; then
  step "Left running (not this project)"
  for name in $others; do ok "supabase stack: ${name}"; done
fi

echo
if [ "$stopped_anything" = true ]; then
  echo "  Everything for ${PROJECT_ID} is down. Bring it back with: pnpm dev:core"
else
  echo "  Nothing was running."
fi
echo
