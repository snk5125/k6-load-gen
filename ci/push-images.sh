#!/bin/sh
# Push both images at one version. Usage: push-images.sh <version>
# Env: PUSH_LATEST=1 to also push :latest. Registry login is the runner's job.
set -eu
version="${1:?usage: push-images.sh <version>}"
GENERATOR_IMAGE="${GENERATOR_IMAGE:-k6-load-gen}"
LAUNCHER_IMAGE="${LAUNCHER_IMAGE:-k6-fleet-launch}"
for image in "$GENERATOR_IMAGE" "$LAUNCHER_IMAGE"; do
  docker push "$image:$version"
  [ "${PUSH_LATEST:-}" = "1" ] && docker push "$image:latest"
done
echo "push: $GENERATOR_IMAGE:$version and $LAUNCHER_IMAGE:$version${PUSH_LATEST:+ (+latest)}"
