#!/bin/sh
# Prove both images run before anything is published. Usage: smoke-images.sh <version>
# No network, no target, no credentials: the generator runs its null-transport
# smoke profile end to end; the launcher answers with usage and rejects bad input.
set -eu
version="${1:?usage: smoke-images.sh <version>}"
GENERATOR_IMAGE="${GENERATOR_IMAGE:-k6-load-gen}"
LAUNCHER_IMAGE="${LAUNCHER_IMAGE:-k6-fleet-launch}"

echo "smoke: generator runs the null-transport profile and reports VALID"
out=$(docker run --rm -e PROFILE=local-null -e RUN_ID=ci-smoke "$GENERATOR_IMAGE:$version" 2>&1) || {
  echo "$out" | tail -20; echo "smoke: generator exited non-zero" >&2; exit 1; }
echo "$out" | grep -q -- '— VALID ===' || { echo "$out" | tail -20; echo "smoke: generator did not report VALID" >&2; exit 1; }

echo "smoke: generator dispatches fleet-launch"
docker run --rm "$GENERATOR_IMAGE:$version" fleet-launch --help | grep -q 'fleet-launch run'

echo "smoke: launcher image starts unprivileged, has the aws CLI, prints usage, rejects a bad URI"
docker run --rm "$LAUNCHER_IMAGE:$version" | grep -q 'fleet-launch run'
docker run --rm --entrypoint sh "$LAUNCHER_IMAGE:$version" -c 'test "$(id -u)" != 0 && aws --version >/dev/null'
if docker run --rm "$LAUNCHER_IMAGE:$version" merge --results-uri /bad --run-id x --count 1 >/dev/null 2>&1; then
  echo "smoke: launcher accepted a bad results URI" >&2; exit 1
fi
echo "smoke: ok"
