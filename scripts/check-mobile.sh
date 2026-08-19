#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../apps/mobile"
flutter analyze --no-pub
exec dart format --set-exit-if-changed --output=none lib test
