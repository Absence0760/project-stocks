#!/usr/bin/env bash
# setup-mobile.sh — resolve the Dart workspace.
#
# No melos: with a single Dart package it orchestrates nothing that `flutter test`
# doesn't already do. Reintroduce it when the web companion adds shared packages.
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$REPO_ROOT"

command -v flutter >/dev/null 2>&1 || { echo "flutter is not installed" >&2; exit 1; }

# One lockfile at the workspace root covers every member.
flutter pub get
