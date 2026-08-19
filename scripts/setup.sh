#!/usr/bin/env bash
# setup.sh — one-time bootstrap after a fresh clone. Idempotent.
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)

blue=$'\033[34m'; green=$'\033[32m'; red=$'\033[31m'; reset=$'\033[0m'
step() { echo "${blue}==>${reset} $*"; }
ok()   { echo "  ${green}ok${reset} $*"; }
err()  { echo "  ${red}error${reset} $*" >&2; }

step "Checking prerequisites"
missing=()
for tool in docker supabase deno pnpm; do
  command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
done
if [ ${#missing[@]} -gt 0 ]; then
  err "missing: ${missing[*]}"
  echo "  See docs/STACK.md for what each is used for."
  exit 1
fi
ok "docker, supabase, deno, pnpm present"

step "Installing workspace dependencies"
( cd "$REPO_ROOT" && pnpm install )
ok "dependencies installed"

step "Warming the Deno module cache"
( cd "$REPO_ROOT/apps/backend" && deno cache supabase/functions/_shared/ingest/*.ts >/dev/null 2>&1 ) || true
ok "module cache warm"

step "Done"
echo
echo "  Next:  pnpm dev:core"
echo
