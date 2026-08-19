#!/usr/bin/env bash
# dev-ai.sh — the local half of the AI research assistant.
#
# The assistant defaults to a local Ollama (AI_PROVIDER is unset => "ollama"), so
# a fresh clone needs no cloud account and no paid key. This script is the "is it
# actually there" check and the one command that fixes it.
#
#   bash bin/dev-ai.sh status   # is Ollama up, and is the model pulled?
#   bash bin/dev-ai.sh pull     # pull the configured model
set -euo pipefail

MODEL=${AI_MODEL:-llama3.2}
# The edge function talks to the OpenAI-compatible surface (.../v1); Ollama's own
# management API sits one level up.
BASE_URL=${OLLAMA_BASE_URL:-http://127.0.0.1:11434/v1}
HOST=${BASE_URL%/v1}
HOST=${HOST%/}

blue=$'\033[34m'; green=$'\033[32m'; yellow=$'\033[33m'; red=$'\033[31m'; reset=$'\033[0m'
step() { echo "${blue}==>${reset} $*"; }
ok()   { echo "  ${green}ok${reset} $*"; }
warn() { echo "  ${yellow}warn${reset} $*"; }
err()  { echo "  ${red}error${reset} $*" >&2; }

usage() {
  echo "usage: bash bin/dev-ai.sh {status|pull}" >&2
  exit 2
}

tags() {
  curl -fsS --max-time 5 "${HOST}/api/tags" 2>/dev/null
}

cmd_status() {
  step "Checking Ollama at ${HOST}"
  local body
  if ! body=$(tags); then
    err "Ollama is not answering on ${HOST}."
    echo
    echo "  Start it with:  systemctl --user start ollama    (or: ollama serve)"
    echo "  Override the host with OLLAMA_BASE_URL if it lives elsewhere."
    echo
    echo "  Note: from inside the Supabase edge-runtime container, 127.0.0.1 is"
    echo "  the container. Set OLLAMA_BASE_URL=http://host.docker.internal:11434/v1"
    echo "  in apps/backend/supabase/functions/.env for functions served locally."
    exit 1
  fi
  ok "Ollama is up"

  step "Checking model \"${MODEL}\""
  # Match the tag exactly, or the bare name against a ":latest" install.
  if grep -qE "\"name\"[[:space:]]*:[[:space:]]*\"${MODEL}(:latest)?\"" <<<"$body"; then
    ok "${MODEL} is installed"
  else
    warn "${MODEL} is not installed"
    echo
    echo "  Pull it with:  ollama pull ${MODEL}    (or: pnpm dev:ai:pull)"
    echo
    echo "  Until then the ai-digest function answers 503 with the same advice —"
    echo "  an upstream 404 from Ollama is mapped to it deliberately."
    exit 1
  fi

  step "Ready"
  echo
  echo "  Provider    ${AI_PROVIDER:-ollama} (default: local)"
  echo "  Model       ${MODEL}"
  echo "  Endpoint    ${BASE_URL}"
  echo
}

cmd_pull() {
  if ! command -v ollama >/dev/null 2>&1; then
    err "the ollama CLI is not on PATH — install Ollama first."
    exit 1
  fi
  step "Pulling ${MODEL}"
  ollama pull "$MODEL"
  ok "${MODEL} is installed"
}

case "${1:-}" in
  status) cmd_status ;;
  pull)   cmd_pull ;;
  *)      usage ;;
esac
