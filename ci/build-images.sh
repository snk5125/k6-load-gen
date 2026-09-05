#!/bin/sh
# Build both images at one version. Usage: build-images.sh <version>
# Env: GENERATOR_IMAGE, LAUNCHER_IMAGE (full image names; default local names),
#      BASE_IMAGE, LAUNCHER_BASE_IMAGE (optional hardened bases, passed
#      through as build args only when set).
# Pulls each image's :latest first so a fresh daemon can reuse layers; the
# images are built with inline cache metadata so that reuse works next time.
set -eu
version="${1:?usage: build-images.sh <version>}"
GENERATOR_IMAGE="${GENERATOR_IMAGE:-k6-load-gen}"
LAUNCHER_IMAGE="${LAUNCHER_IMAGE:-k6-fleet-launch}"
export DOCKER_BUILDKIT=1

args="--build-arg BUILDKIT_INLINE_CACHE=1"
[ -n "${BASE_IMAGE:-}" ] && args="$args --build-arg BASE_IMAGE=$BASE_IMAGE"
[ -n "${LAUNCHER_BASE_IMAGE:-}" ] && args="$args --build-arg LAUNCHER_BASE_IMAGE=$LAUNCHER_BASE_IMAGE"

docker pull "$GENERATOR_IMAGE:latest" >/dev/null 2>&1 || true
docker pull "$LAUNCHER_IMAGE:latest" >/dev/null 2>&1 || true

# shellcheck disable=SC2086 # intentional word-splitting of build args
docker build $args --cache-from "$GENERATOR_IMAGE:latest" \
  -t "$GENERATOR_IMAGE:$version" -t "$GENERATOR_IMAGE:latest" .
# shellcheck disable=SC2086
docker build $args --cache-from "$LAUNCHER_IMAGE:latest" --target launcher \
  -t "$LAUNCHER_IMAGE:$version" -t "$LAUNCHER_IMAGE:latest" .

echo "build: $GENERATOR_IMAGE:$version and $LAUNCHER_IMAGE:$version"
