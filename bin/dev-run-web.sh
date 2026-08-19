#!/usr/bin/env bash
# dev-run-web.sh — run the SvelteKit app against the local stack.
#
# The Supabase publishable key is read straight out of `supabase status` and
# exported as PUBLIC_SUPABASE_ANON_KEY for Vite. It is never written to a file,
# committed, or echoed: a committed .env would put a key in git, and a gitignored
# one would be missing on a fresh clone. The committed .env.development carries
# only the non-sensitive URL.
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
BACKEND="$REPO_ROOT/apps/backend"

API_PORT=54421
DB_PORT=54422
WEB_PORT=7777

blue=$'\033[34m'; green=$'\033[32m'; red=$'\033[31m'; reset=$'\033[0m'
step() { echo "${blue}==>${reset} $*"; }
ok()   { echo "  ${green}ok${reset} $*"; }
err()  { echo "  ${red}error${reset} $*" >&2; }

step "Checking the local stack"
if ! pg_isready -h 127.0.0.1 -p "$DB_PORT" -q 2>/dev/null; then
  err "Supabase is not running. Start it with: pnpm dev:core"
  exit 1
fi
ok "stack is up on ${API_PORT}"

step "Reading the publishable key"
PUBLISHABLE_KEY=$( cd "$BACKEND" && supabase status -o env | sed -n 's/^PUBLISHABLE_KEY=//p' | tr -d '"' )
if [ -z "$PUBLISHABLE_KEY" ]; then
  err "could not read PUBLISHABLE_KEY from supabase status"
  exit 1
fi
ok "key resolved (not printed)"

step "Launching on http://localhost:${WEB_PORT}"
echo
echo "  Signed in automatically as the seeded user (investor@test.com)."
echo "  That only happens because the Supabase host is loopback — see"
echo "  apps/web/src/lib/auth/dev-auto-login.ts."
echo

export PUBLIC_SUPABASE_ANON_KEY="$PUBLISHABLE_KEY"
exec pnpm -C "$REPO_ROOT/apps/web" dev "$@"
