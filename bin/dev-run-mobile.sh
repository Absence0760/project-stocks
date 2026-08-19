#!/usr/bin/env bash
# dev-run-mobile.sh — run the Flutter app against the local stack.
#
# The Supabase publishable key is read straight out of `supabase status` and
# passed as a --dart-define. It is never written to a file, committed, or echoed:
# a bundled .env asset would have to be either gitignored (and then missing from
# the asset path) or committed (and then a key in git).
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
BACKEND="$REPO_ROOT/apps/backend"
MOBILE="$REPO_ROOT/apps/mobile"

API_PORT=54421
DB_PORT=54422
SUPABASE_URL="http://127.0.0.1:${API_PORT}"

blue=$'\033[34m'; green=$'\033[32m'; yellow=$'\033[33m'; red=$'\033[31m'; reset=$'\033[0m'
step() { echo "${blue}==>${reset} $*"; }
ok()   { echo "  ${green}ok${reset} $*"; }
warn() { echo "  ${yellow}warn${reset} $*"; }
err()  { echo "  ${red}error${reset} $*" >&2; }

step "Checking the local stack"
if ! pg_isready -h 127.0.0.1 -p "$DB_PORT" -q 2>/dev/null; then
  err "Supabase is not running. Start it with: pnpm dev:core"
  exit 1
fi
ok "stack is up"

# The app targets 127.0.0.1 so one value works on an emulator and a physical
# device alike; adb reverse is what makes that true on a device.
if command -v adb >/dev/null 2>&1 && [ -n "$(adb devices | sed -n '2p')" ]; then
  step "Reversing ports to attached Android devices"
  adb reverse "tcp:${API_PORT}" "tcp:${API_PORT}" >/dev/null 2>&1 || true
  adb reverse "tcp:${DB_PORT}" "tcp:${DB_PORT}" >/dev/null 2>&1 || true
  ok "adb reverse applied"
else
  warn "no adb device attached — skipping port reverse"
fi

step "Launching"
PUBLISHABLE_KEY=$( cd "$BACKEND" && supabase status -o env | sed -n 's/^PUBLISHABLE_KEY=//p' | tr -d '"' )
if [ -z "$PUBLISHABLE_KEY" ]; then
  err "could not read PUBLISHABLE_KEY from supabase status"
  exit 1
fi

cd "$MOBILE"
exec flutter run \
  --dart-define="SUPABASE_URL=${SUPABASE_URL}" \
  --dart-define="SUPABASE_ANON_KEY=${PUBLISHABLE_KEY}" \
  "$@"
