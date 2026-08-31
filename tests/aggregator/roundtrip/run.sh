#!/usr/bin/env bash
set -euo pipefail

# Containerised Vector round trip (Task 5). See README.md in this directory
# for what this proves, what it does not, and why it is not part of `npm
# test`. Requires Docker.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required to run the containerised round trip (see tests/aggregator/roundtrip/README.md)" >&2
  exit 1
fi

npx tsx tests/aggregator/roundtrip/main.ts "$@"
