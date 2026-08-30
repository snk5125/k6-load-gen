# k6-load-gen

A containerised [k6](https://k6.io) load generator for log aggregation tiers.

It generates synthetic log events with controlled field cardinality, drives them at a configured
rate through a pluggable transport, and writes a machine-readable summary of the run.

Aggregator-agnostic: anything that speaks the configured transport is a valid target.

## Quick start

Run against any OTLP/gRPC endpoint:

```bash
docker run --rm \
  -e PROFILE=otlp-grpc \
  -e RUN_ID=sweep-1 \
  -e TARGET=collector.example:4317 \
  -e SCENARIO=sweep \
  -e KNEE_EPS=5000 \
  k6-load-gen:latest
```

Or with no target at all — the `null` transport discards everything, which is the fastest way to
confirm the image works:

```bash
docker run --rm -e PROFILE=local-null -e RUN_ID=smoke k6-load-gen:latest
```

## Configuration

Runs are configured by a committed JSON **profile** plus a small environment surface. The profile
holds what is stable; the environment holds what varies per run. **The container command is never
overridden** — configuration is environment only.

### Profiles

`profiles/*.json`, bundled into the image. A profile declares the transport and endpoint, the
payload shape, the rate anchor, the scenario, and any thresholds:

```jsonc
{
  "name": "otlp-grpc",
  "target": { "transport": "otlp-grpc", "endpoint": "collector.example:4317",
              "options": { "plaintext": true, "timeout": "10s" } },
  "payload": {
    "template": "json-app",
    "batch_size": 100,
    "fields": {
      "host":     { "cardinality": 500, "distribution": "zipf" },
      "level":    { "values": ["INFO", "WARN", "ERROR"], "weights": [0.8, 0.15, 0.05] },
      "trace_id": { "cardinality": "unbounded" },
      "message":  { "cardinality": 50, "pad_to": 512 }
    }
  },
  "anchor":     { "mode": "knee", "knee_eps": 5000 },
  "scenario":   "sweep",
  "thresholds": { "send_failures": "rate<0.001", "send_duration": "p(99)<250" }
}
```

Field **cardinality** is the point: it drives the aggregator's real parse and index cost. A fixed
512 bytes of filler exercises almost none of it.

**Never put a credential in a profile.** Name the environment variable instead (`"token_env":
"HEC_TOKEN"`). Profiles are committed, and the resolved profile is embedded in the run summary —
unrecognised `target.options` keys are redacted, but the allowlist is a safety net, not a licence.

### Environment

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PROFILE` | yes | — | which profile to load |
| `RUN_ID` | yes | — | correlation key, unique per run |
| `TARGET` | no | profile | override the endpoint |
| `SCENARIO` | no | profile | override the load shape |
| `KNEE_EPS` / `RATE` | no | profile | override the rate anchor (`RATE` pins an absolute base and wins) |
| `GEN_INDEX` / `GEN_COUNT` | no | `0` / `1` | fleet slicing |
| `DURATION_SCALE` | no | `1` | multiply every stage duration |
| `RESULTS_URI` | no | — | `s3://bucket/prefix` or a local path; unset means artifacts stay in `WORKDIR` |
| `EMIT_TIMELINE` | no | profile, else `1` | `--out json` and the bucketed timeline; costs throughput at very high rates |
| `KEEP_RAW` | no | `0` | also ship the gzipped raw sample stream |
| `TIMELINE_BUCKET_SEC` | no | `15` | timeline bucket width |
| `AWS_REGION` | when `RESULTS_URI` is `s3://` | — | the AWS CLI cannot resolve a region on its own in most container runtimes |

`DURATION_SCALE=0.01` turns any long shape into a wiring check — it runs a 4-hour soak in minutes,
proving the target, credentials and payload before you commit to a real run.

## Scenarios

Twelve shapes, all relative multipliers resolved against the profile's anchor:

`smoke` · `calibrate` · `sweep` · `staircase` · `breakpoint` · `spike` · `sawtooth` · `burst-idle` ·
`plateau` · `soak` · `backpressure-hold` · `recovery`

Anchoring has two modes. `knee` multiplies a measured knee estimate — right for discovery. `absolute`
multiplies a literal base pinned in git — right for regression baselines, which must not drift when
an estimate does.

## Output

Each run writes `summary.json`: the resolved configuration, every metric, threshold verdicts, and a
machine-readable validity block. With `EMIT_TIMELINE` on, it also writes `timeline.jsonl` — 15-second
rollups, one flat JSON record per line.

`validity.valid` answers *"is this measurement trustworthy?"*, which is not the same as *"did the
target pass?"*. A run that drops iterations is invalid — it measured the generator, not the target. A
run that breaches an SLO threshold is still perfectly valid; it just found what it was looking for.

**Exit codes:** `0` pass · `99` threshold breach · non-zero otherwise. The `99` is a CI gate.

## Transports

| Transport | Status |
|---|---|
| `otlp-grpc` | implemented |
| `null` | implemented — discards everything; measures generator ceiling |
| `otlp-http`, `hec`, `syslog` | planned |

## Building

```bash
docker build -t k6-load-gen:latest .
```

Multi-stage: `xk6` builds a pinned k6 binary with the `k6/x/tcp` extension, the Node CLIs are bundled
standalone, and both are copied onto a runtime base. The base is a build ARG:

```bash
docker build --build-arg BASE_IMAGE=your/hardened-base .
```

A substituted base must provide Node 22+ on `PATH`, plus `curl`, `unzip`, a writable `/tmp`, and
glibc for the AWS CLI installer. The image runs as a non-root user.

The k6 binary is built at image-build time rather than resolved at runtime, because runtime
extension resolution needs egress to an external build service and fails in a closed network.

## Development

```bash
npm ci
npm test          # unit tests — no k6, no network, no container
npm run typecheck # both tsconfigs
```

Most of the codebase is pure TypeScript that imports nothing from k6 — payload generation, scenario
resolution, config validation, summary assembly — so it is testable in milliseconds. The k6-coupled
adapters are deliberately thin.

Two tsconfigs on purpose: `tsconfig.json` restricts types to `@types/k6`, so a file k6 executes
cannot reference `process` and typecheck clean while failing at runtime. `tsconfig.node.json` covers
the Node CLI entrypoints and the test suite.

To verify delivery end to end, run any OTLP receiver locally, point `TARGET` at it, and compare its
received-event count against the summary's `events_sent`.
