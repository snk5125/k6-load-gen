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

`profiles/*.json`, bundled into the image. A profile declares the transport and endpoint, one or
more log types to generate (each with its own rate anchor, scenario and batch size), and any
thresholds:

```jsonc
{
  "name": "otlp-grpc",
  "target": { "transport": "otlp-grpc", "endpoint": "collector.example:4317",
              "options": { "plaintext": true, "timeout": "10s" } },
  "types": {
    "json-app": {
      "batch_size": 100,
      "anchor":     { "mode": "knee", "knee_eps": 5000 },
      "scenario":   "sweep"
    }
  },
  "thresholds": { "send_failures": "rate<0.001", "send_duration": "p(99)<250" }
}
```

Field **cardinality** is the point: it drives the aggregator's real parse and index cost. A fixed
512 bytes of filler exercises almost none of it.

**Never put a credential in a profile.** Name the environment variable instead (`"token_env":
"HEC_TOKEN"`). Profiles are committed, and the resolved profile is embedded in the run summary —
unrecognised `target.options` keys are redacted, but the allowlist is a safety net, not a licence.

**The legacy single-type shape is dropped, not supported alongside.** A profile written before
multi-type support had a top-level `payload`, `anchor` and `scenario` instead of `types`. All three
are rejected at validation if a profile still has them — `payload` with "declare one or more log
types under `types` instead", `anchor`/`scenario` with "move it into the matching entry under
`types` instead" — rather than silently ignored, which would otherwise look like a working profile
quietly running different rates/shapes than whatever is still sitting at the top level.

### Environment

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PROFILE` | yes | — | which profile to load |
| `RUN_ID` | yes | — | correlation key, unique per run |
| `TARGET` | no | profile | override the endpoint |
| `GEN_INDEX` / `GEN_COUNT` | no | `0` / `1` | fleet slicing |
| `DURATION_SCALE` | no | `1` | multiply every stage duration |
| `TYPES` | no | every type the profile declares | comma-separated subset of the profile's log types to run this invocation — see **Log types** below |
| `RESULTS_URI` | no | — | `s3://bucket/prefix` or a local path; unset means artifacts stay in `WORKDIR` |
| `EMIT_TIMELINE` | no | profile, else `1` | `--out json` and the bucketed timeline; costs throughput at very high rates |
| `KEEP_RAW` | no | `0` | also ship the gzipped raw sample stream |
| `TIMELINE_BUCKET_SEC` | no | `15` | timeline bucket width |
| `AWS_REGION` | when `RESULTS_URI` is `s3://` | — | the AWS CLI cannot resolve a region on its own in most container runtimes |

**`SCENARIO`, `RATE` and `KNEE_EPS` no longer exist as bare global overrides.** Now that a profile
can declare more than one log type, a bare `RATE` has no unambiguous target — which type would it
mean? Setting any of the three fails the run at init, naming its per-type replacement
(`<TYPE>_SCENARIO`, `<TYPE>_RATE`, `<TYPE>_KNEE_EPS`); see **Log types** below.

`DURATION_SCALE=0.01` turns any long shape into a wiring check — it runs a 4-hour soak in minutes,
proving the target, credentials and payload before you commit to a real run.

## Log types

Four log types ship today, each a `LogTypeDef` in `src/logtypes/definitions/`. Each belongs to a
**format family** (`src/logtypes/families/`), which owns the wire grammar — both how the type
serializes and how a reader parses it back (its `ParseArtifact`) — so the two can never drift apart.

| Type | Format family | Parse class | Shape |
|---|---|---|---|
| `json-app` | `json-flat` | `kind: 'json', nested: false` | one flat JSON object per event |
| `auditd` | `kv-audit` | `kind: 'kv'` — fixed `type=… msg=audit(epoch.millis:serial): ` prefix, then `key=value` pairs | Linux auditd SYSCALL record |
| `nginx-access` | `regex-clf` | `kind: 'regex'` — nginx/Apache Combined Log Format | the only regex/grok-parsed family; a regex parse typically costs an aggregator 10-50x a JSON decode |
| `cloudtrail` | `json-nested` | `kind: 'json', nested: true`, `envelope: { wrap: 'Records' }` | AWS CloudTrail management-event record, fields at dotted paths (`userIdentity.arn`) |

A profile enables a type by adding it under `types`, each with its own `batch_size`, `anchor` and
`scenario` (see **Profiles** above) — one k6 scenario per active type, so each gets its own load
shape and reports its own metrics in `summary.types.<type>`.

### Per-type environment surface

Every declared type gets its own `<TYPE>_*` environment prefix, derived by upper-casing the type
name and turning every hyphen into an underscore — `nginx-access` becomes `NGINX_ACCESS`, so its
rate override is `NGINX_ACCESS_RATE`, not `NGINX-ACCESS_RATE`. `json-app` becomes `JSON_APP`, and
`auditd`/`cloudtrail` need no translation.

| Variable | Purpose |
|---|---|
| `<TYPE>_RATE` | pin an absolute base rate for this type (wins over `<TYPE>_KNEE_EPS`) |
| `<TYPE>_KNEE_EPS` | override this type's knee-anchor estimate |
| `<TYPE>_SCENARIO` | override this type's load shape |
| `<TYPE>_BATCH_SIZE` | override this type's events-per-send batch size |

`TYPES` (see **Environment** above) subsets which declared types actually run this invocation —
**unset means every type the profile declares runs.** A `<TYPE>_*` variable set for a type that
`TYPES` excludes is a warning, not a silent no-op: the run still starts, but `summary.json`'s
`warnings` names the variable and says why it had no effect. The same warning-not-silence rule
applies to a `<TYPE>_*`-shaped variable whose prefix matches no type the profile declares at all —
catches a typo like `CLOUDTRAILL_RATE` that the exact-match check above cannot.

### Known limitations

**CloudTrail emits one record per envelope.** A real CloudTrail delivery batches many records into
one `Records[]` array; this generator always wraps exactly one. That exercises an aggregator's
unroll code path (pulling records out of the array) but not its amortisation of per-request
overhead across a large array — a real deployment's CloudTrail ingest cost per record can be lower
than what a one-record-per-envelope run would suggest.

**Field values are synthetic.** Cardinality is realistic — the generator drives the same number of
distinct values, with the same skew, a real deployment would see — but the values themselves are
not real. CloudTrail's `awsRegion` values are tokens like `region-3`, never an actual AWS region
name; ARNs are `arn:synthetic::0:role/r-7`, not a real account or role. A downstream rule keyed on
a real value (a specific region, a specific role ARN) will not fire against this traffic.

**Live delivery has been verified for `auditd`, `cloudtrail` and `nginx-access` over `hec`, not
over `otlp-grpc`.** `mixed-estate.json` (the shipped profile declaring all three) targets
`otlp-grpc`; the live check that confirmed the receiver's per-type counts match
`summary.types.<type>.events_sent` substituted the `hec` transport instead, because standing up a
throwaway Node receiver that speaks real OTLP/gRPC was out of scope for that check. The generated
*payload* for all three types is confirmed intact end-to-end; the `otlp-grpc` transport's handling
of a multi-scenario run specifically has not been.

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
| `otlp-http` | implemented |
| `hec` | implemented |
| `syslog` | implemented |
| `null` | implemented — discards everything; measures generator ceiling |

Each transport reads its `target.options` from the profile (see `src/config/schema.ts` for the
full validation rules).

### `otlp-grpc`

| Option | Default | Purpose |
|---|---|---|
| `plaintext` | `true` | when `true`, skip TLS and connect in cleartext; set `false` to require TLS |
| `timeout` | `"10s"` | per-call timeout |
| `resource_attributes` | — | key/value pairs attached to the OTLP `Resource` |

**The default is `plaintext: true` — TLS is skipped unless a profile explicitly sets
`plaintext: false`.** Do not assume a profile that omits this option is encrypted in transit.

### `otlp-http`

| Option | Default | Purpose |
|---|---|---|
| `path` | `/v1/logs` | request path appended to `target.endpoint` |
| `encoding` | `"json"` | **only `"json"` is implemented** — `"protobuf"` is rejected at construction, so a misconfigured profile fails in init rather than at the first send |
| `headers` | — | extra request headers |

k6 has no protobuf encoder for an HTTP body (unlike gRPC, where k6 compiles the `.proto` files
itself), so implementing `encoding: "protobuf"` would mean hand-rolling one in JS. That is out of
scope here — pick an aggregator endpoint that accepts OTLP/HTTP JSON, or use `otlp-grpc` instead.

### `hec`

| Option | Default | Purpose |
|---|---|---|
| `path` | `/services/collector/event` | request path appended to `target.endpoint` |
| `token_env` | `"HEC_TOKEN"` | **names** the environment variable holding the HEC token — the token itself never lives in the profile |
| `index` | — | optional Splunk index |
| `sourcetype` | — | optional sourcetype |
| `gzip` | `false` | compress the request body |

**The container fails at init if the variable named by `token_env` is unset** — that is the
designed behaviour: a missing credential should be a startup failure, not a run's worth of 401s.

**With `gzip: true`, `summary.json` reports `wire_bytes: null` for this transport's sends.** k6
compresses the body after handing it a string and does not report the compressed length back, so
the only number available is the *uncompressed* size — reporting that as the wire size would be
exactly the confident-wrong-number `SendResult.wire_bytes` exists to prevent.

**The `gzip: true` path is unverified.** It is not covered by the unit suite (nothing that calls
`k6/http` is), and the live verification run against a real HEC listener used `gzip: false`. Treat
compressed HEC delivery as untested until it has been exercised against a real listener.

### `syslog`

| Option | Default | Purpose |
|---|---|---|
| `rfc` | `5424` | `5424` or `3164` |
| `framing` | `"octet-counted"` | `"octet-counted"` or `"lf"` |
| `tls` | `false` | wrap the TCP connection in TLS |
| `app_name` | `"k6-load-gen"` | RFC APP-NAME / TAG token |

**This transport connects and closes once per `send()` batch — it does not hold a persistent
socket.** A prior experiment found that a `k6/x/tcp` socket left undestroyed at VU teardown hangs
the entire k6 process at shutdown (140s+, no summary produced), and this codebase has no per-VU
teardown hook to call `destroy()` from, so connect-per-batch is the only shape that reliably exits.
Two consequences follow, and a reader picking a transport should know both before load-testing
against `syslog`:

- **Throughput is bounded by TCP (and, with `tls: true`, TLS) handshake latency, not by the
  aggregator's ingest rate.** Its achievable rate is not comparable to the connectionless HTTP
  transports (`hec`, `otlp-http`) or the connect-once `otlp-grpc` client.
- **Every closed connection sits in `TIME_WAIT` on the generator host for roughly 60 seconds.** A
  single generator VU pool against one `host:port` therefore tops out around a few hundred
  connections/sec — ephemeral source ports run out faster than `TIME_WAIT` clears them. Push past
  that ceiling and `connect()` itself starts failing, which shows up in the run's metrics looking
  exactly like a receiver-side problem. See `src/transports/syslog.ts` for the full reasoning.

Because every batch pays a fresh handshake, `syslog`'s `send_duration` threshold is not comparable
to the other transports' — `otlp-grpc`, `otlp-http` and `hec` measure a request over an
already-established connection (or, for `otlp-grpc`, a connect-once client), so their per-call
budgets can be tight. `syslog`'s per-call time includes a TCP handshake and, with `tls: true`, a TLS
handshake on top of it, so the shipped `profiles/syslog.json` threshold is set looser than the
HTTP/gRPC transports' to leave room for that — see the profile for the current value.

**Delivery has been verified live; strict-receiver conformance has not.** The live check used `nc`
listening on a TCP port, which confirms framing and end-to-end delivery but says nothing about
whether a real syslog daemon would accept the message. Two known conformance gaps sit
outside what that check can see: the structured-data ID emitted for the `[meta ...]` block does not
follow RFC 5424 §6.3.2 (which wants `name@<enterprise-number>` for anything carrying custom
parameters, not a bare `meta`), and no UTF-8 BOM precedes MSG as §6.4 recommends. Neither is fixed
here, but a reader pointing `syslog` at a strict receiver should know about both before assuming
conformance.

### `null`

| Option | Default | Purpose |
|---|---|---|
| `count_bytes` | `true` | measure `wire_bytes` by summing event body lengths; set `false` to report `wire_bytes: null` instead |

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
