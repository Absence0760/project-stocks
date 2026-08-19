#!/usr/bin/env bash
# dev-core.sh — bring up the local stack. Idempotent; re-run any time.
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
BACKEND="$REPO_ROOT/apps/backend"
DB_PORT=54422
API_PORT=54421
STUDIO_PORT=54423

blue=$'\033[34m'; green=$'\033[32m'; yellow=$'\033[33m'; red=$'\033[31m'; reset=$'\033[0m'
step() { echo "${blue}==>${reset} $*"; }
ok()   { echo "  ${green}ok${reset} $*"; }
warn() { echo "  ${yellow}warn${reset} $*"; }
err()  { echo "  ${red}error${reset} $*" >&2; }

step "Checking Docker"
if ! docker info >/dev/null 2>&1; then
  err "Docker is not running. Start it and re-run."
  exit 1
fi
ok "Docker is up"

step "Starting Supabase (ports ${API_PORT}-54429)"
# `supabase start` exits 0 even when it fails to bind a port and rolls back, so
# its exit code is not trustworthy — verify by talking to the database instead.
( cd "$BACKEND" && supabase start >/dev/null 2>&1 ) || true

if ! pg_isready -h 127.0.0.1 -p "$DB_PORT" -q 2>/dev/null; then
  err "Supabase did not come up on ${DB_PORT}."
  echo
  echo "  Most likely another Supabase project holds these ports. Check with:"
  echo "    docker ps --format '{{.Names}}\\t{{.Ports}}' | grep supabase"
  echo
  echo "  project-running uses 54321-54327; this project is offset +100 to avoid it."
  echo "  Re-run with output:  cd apps/backend && supabase start"
  exit 1
fi
ok "Database is accepting connections on ${DB_PORT}"

step "Ready"
cat <<EOF

  Studio      http://127.0.0.1:${STUDIO_PORT}
  API         http://127.0.0.1:${API_PORT}
  Mailpit     http://127.0.0.1:54424

  Seed login  investor@test.com / testtest

  Next:
    pnpm dev:db:reset     re-apply migrations + seed
    pnpm test             deno unit tests + pgTAP

EOF
