# syntax=docker/dockerfile:1

# Substitute a hardened base at build time without editing this file:
#   docker build --build-arg BASE_IMAGE=<your/hardened-ubi9> .
# Whatever image is substituted here MUST provide Node 22+ on PATH (the two
# CLI bundles under /app/dist are invoked as bare `node ...`) and the AWS
# CLI v2 installer's prerequisites: curl, unzip, and a writable /tmp for the
# install, plus glibc at runtime (the installer ships a glibc binary).
ARG BASE_IMAGE=registry.access.redhat.com/ubi9/nodejs-22:latest

# ---- stage 1: pinned k6 binary with the tcp extension ----
# Built now even though only otlp-grpc and null exist, because Plan 2's syslog
# transport needs k6/x/tcp and runtime resolution is impossible in a private
# VPC: it takes 37s and requires egress to Grafana's build service.
FROM grafana/xk6:latest AS k6build
# This image runs as an unprivileged `xk6` user (WORKDIR /xk6) that cannot
# mkdir at /, so --output /out/k6 (root-owned, nonexistent) fails with
# "permission denied". Its own docs write the binary inside the default
# working directory instead, so this does the same.
RUN xk6 build v2.2.0 --with github.com/grafana/xk6-tcp@v0.3.1 --output /xk6/k6

# ---- stage 2: standalone CLI bundles ----
# ubi9/nodejs-22 defaults to USER 1001 with WORKDIR /opt/app-root/src; switch
# to root and use our own WORKDIR so npm ci/build:cli behave the same as any
# other Node image.
FROM ${BASE_IMAGE} AS jsbuild
USER 0
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build:cli

# ---- stage 3: runtime ----
FROM ${BASE_IMAGE}
USER 0

# Node, npm, curl, unzip, tar, and gzip all ship in ubi9/nodejs-22 already —
# nothing to install there. (ubi9-minimal's microdnf only offers Node 16.20.2,
# EOL since 2023, with a broken npm — that's why this base changed; see the
# ARG comment above. Note this base has no microdnf at all, only dnf.)

# AWS CLI v2. UBI repos do not carry it, so install from the official bundle.
# A hardened pipeline that forbids build-time downloads should instead bake the
# CLI into its base and delete this block.
#
# Architecture is detected via `uname -m` INSIDE this stage rather than
# trusted from a --build-arg TARGETARCH: a plain `docker build` with no
# --platform (the common local/dev path) does not reliably thread TARGETARCH
# through to match whatever platform the FROM stages actually resolved to.
# Verified the hard way: a static TARGETARCH=amd64 default shipped an x86_64
# AWS CLI into this arm64 (Apple Silicon host, no --platform override) image,
# and it failed at container run time with "qemu-x86_64: Could not open
# '/lib64/ld-linux-x86-64.so.2'" — silently broken until actually run.
# uname -m always matches the container that is really being built.
RUN set -eux; \
    case "$(uname -m)" in \
      x86_64) AWS_ARCH=x86_64 ;; \
      aarch64) AWS_ARCH=aarch64 ;; \
      *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${AWS_ARCH}.zip" -o /tmp/awscliv2.zip; \
    unzip -q /tmp/awscliv2.zip -d /tmp; \
    /tmp/aws/install; \
    rm -rf /tmp/awscliv2.zip /tmp/aws

COPY --from=k6build /xk6/k6 /usr/local/bin/k6
COPY --from=jsbuild /build/dist /app/dist
COPY src      /app/src
COPY profiles /app/profiles
COPY bin      /app/bin
# Copied to /protos, matching otlp-grpc.ts's default. PROTO_ROOT is also set
# explicitly so the two can never drift apart silently.
COPY protos   /protos

ENV PROTO_ROOT=/protos \
    WORKDIR=/tmp/k6run \
    K6_AUTO_EXTENSION_RESOLUTION=false \
    K6_DEPENDENCY_MANIFEST='{"k6":"v2.2.0","k6/x/tcp":"v0.3.1"}'

RUN chmod +x /app/bin/run.sh

# Run as the base's intended non-root user. /tmp is world-writable (sticky
# bit), so bin/run.sh's `mkdir -p "$WORKDIR"` (WORKDIR=/tmp/k6run) succeeds
# under 1001 without any extra chown — verified in Step 6.
USER 1001

# Override the base's own ENTRYPOINT ([container-entrypoint]) and clear its
# CMD so nothing from the base image gets appended as stray arguments to ours.
ENTRYPOINT ["/app/bin/run.sh"]
CMD []
