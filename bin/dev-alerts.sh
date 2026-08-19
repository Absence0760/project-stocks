#!/usr/bin/env bash
# dev-alerts.sh — drive the quotes/alerts pipeline by hand against the local stack.
#
#   refresh-quotes   price every held instrument (QUOTE_PROVIDER, default: stub)
#   evaluate         run the condition scan now instead of waiting for pg_cron
#   deliver          drain one pass of the delivery queue
#
# The two HTTP subcommands need the service role key, which is read out of
# `supabase status` at call time and never written to a file or echoed — the same
# rule dev-run-mobile.sh follows for the publishable key.
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
BACKEND="$REPO_ROOT/apps/backend"
DB_PORT=54422
API_PORT=54421
FUNCTIONS_URL="http://127.0.0.1:${API_PORT}/functions/v1"
DB_URL="postgresql://postgres:postgres@127.0.0.1:${DB_PORT}/postgres"

blue=$'\033[34m'; green=$'\033[32m'; yellow=$'\033[33m'; red=$'\033[31m'; reset=$'\033[0m'
step() { echo "${blue}==>${reset} $*"; }
ok()   { echo "  ${green}ok${reset} $*"; }
warn() { echo "  ${yellow}warn${reset} $*"; }
err()  { echo "  ${red}error${reset} $*" >&2; }

usage() {
  sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
  exit 64
}

require_stack() {
  if ! pg_isready -h 127.0.0.1 -p "$DB_PORT" -q 2>/dev/null; then
    err "Supabase is not running. Start it with: pnpm dev:core"
    exit 1
  fi
}

invoke() {
  local name=$1
  local key
  key=$( cd "$BACKEND" && supabase status -o env | sed -n 's/^SERVICE_ROLE_KEY=//p' | tr -d '"' )
  if [ -z "$key" ]; then
    err "could not read SERVICE_ROLE_KEY from supabase status"
    exit 1
  fi

  local status body
  body=$(mktemp)
  # shellcheck disable=SC2064
  trap "rm -f '$body'" RETURN

  status=$(curl -sS -o "$body" -w '%{http_code}' -X POST \
    -H "Authorization: Bearer ${key}" \
    -H 'Content-Type: application/json' \
    "${FUNCTIONS_URL}/${name}") || true

  if [ "$status" = "404" ] && grep -qi 'function not found' "$body"; then
    err "the local edge runtime is not serving ${name}."
    echo "  Restart the stack (pnpm dev:db:down && pnpm dev:core), or serve the"
    echo "  functions explicitly:  cd apps/backend && supabase functions serve"
    exit 1
  fi

  cat "$body"
  echo
  [ "$status" = "200" ] || { err "${name} returned HTTP ${status}"; exit 1; }
}

case "${1:-}" in
  refresh-quotes)
    require_stack
    step "Refreshing quotes (QUOTE_PROVIDER=${QUOTE_PROVIDER:-stub})"
    invoke refresh-quotes
    ok "done"
    ;;

  evaluate)
    require_stack
    step "Running the condition scan"
    # Straight to the database: the scan is a SECURITY DEFINER function, and
    # pg_cron calls it exactly this way every five minutes.
    psql "$DB_URL" -qAt -c 'select evaluate_alert_rules() || $$ alert event(s) fired$$'
    ok "done"
    ;;

  deliver)
    require_stack
    step "Draining the delivery queue"
    invoke deliver-alerts
    ok "done"
    ;;

  *)
    usage
    ;;
esac
