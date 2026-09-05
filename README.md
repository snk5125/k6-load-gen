# k6-load-gen

A containerised [k6](https://k6.io) load generator for log aggregation tiers. It emits several
structurally-faithful log formats at controlled cardinality, drives each at its own rate, and
writes a machine-readable summary. Aggregator-agnostic — anything speaking the configured
transport is a valid target.

It also generates the Cribl and Vector parsing configs for the formats it emits, so the generator
and the parser configs cannot drift.

---

## Quickstart — ECS

Run a task, overriding whatever the run needs. `--overrides` varies a run without re-registering
the task definition.

```bash
aws ecs run-task \
  --cluster "$CLUSTER" \
  --task-definition k6-load-gen \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNET_ID],securityGroups=[$SG_ID],assignPublicIp=DISABLED}" \
  --region "$AWS_REGION" \
  --overrides '{
    "containerOverrides": [{
      "name": "k6-load-gen",
      "environment": [
        { "name": "RUN_ID",                "value": "sweep-001" },
        { "name": "TYPES",                 "value": "auditd,nginx-access" },
        { "name": "AUDITD_RATE",           "value": "5000" },
        { "name": "NGINX_ACCESS_SCENARIO", "value": "spike" },
        { "name": "DURATION_SCALE",        "value": "0.5" }
      ]
    }]
  }'
```

Prove wiring before a real run — `DURATION_SCALE=0.02` turns a 4-hour soak into minutes:

```bash
--overrides '{"containerOverrides":[{"name":"k6-load-gen","environment":[
  {"name":"RUN_ID","value":"wiring-check"},{"name":"DURATION_SCALE","value":"0.02"}]}]}'
```

Locally:

```bash
docker run --rm -e PROFILE=local-null -e RUN_ID=smoke k6-load-gen:latest
```

A multi-task fleet in one command, from a small operator image built with `--target launcher`
and your AWS credentials: N tasks launched, waited for, merged from S3 into one fleet summary.

```bash
docker build --target launcher -t k6-fleet-launch . && docker run --rm --user "$(id -u):$(id -g)" -e HOME=/aws -v "$HOME/.aws:/aws/.aws:ro" -e AWS_PROFILE -e AWS_REGION -v "$PWD:/w:ro" k6-fleet-launch run --cluster "$CLUSTER" --task-definition k6-load-gen --network-configuration "$NETCFG" --overrides /w/overrides.json --count 4
```

Task-definition examples, IAM notes and fleet patterns: **[docs/deployment-guide.md](docs/deployment-guide.md)**.

---

## Environment overrides

The container command is never overridden. Configuration is environment only.

| Variable | Default | Impact |
|---|---|---|
| `PROFILE` | *required* | Which profile to load: `local-null`, `otlp-grpc`, `otlp-http`, `hec`, `syslog`, `mixed-estate` |
| `RUN_ID` | *required* | Correlation key stamped on every event and artifact. Unique per run |
| `TARGET` | profile | Destination endpoint. Overrides the profile's `target.endpoint` |
| `TYPES` | all declared | Comma-separated subset of the profile's log types to run |
| `DURATION_SCALE` | `1` | Multiplies every stage duration. `0.02` = wiring check; `1` = full run. No effect on `smoke`, which always runs its 20 iterations |
| `GEN_COUNT` | `1` | Fleet size. On its own, `GEN_COUNT=N` runs N generators inside this one task and ships one merged fleet summary plus each generator's own. Exit code is the worst generator's. `smoke` runs in full per generator |
| `GEN_INDEX` | unset | Set it (`0`..`N-1`) to run one generator per task instead; N tasks with the same `RUN_ID` and `GEN_COUNT` together offer the full rate |
| `RESULTS_URI` | — | `s3://bucket/prefix` or a local path. Unset means artifacts die with the container |
| `EMIT_TIMELINE` | profile, else `1` | Bucketed timeline output. Costs throughput at very high rates |
| `KEEP_RAW` | `0` | Also ship the gzipped raw sample stream |
| `TIMELINE_BUCKET_SEC` | `15` | Timeline bucket width, seconds |
| `AWS_REGION` | — | **Required when `RESULTS_URI` is `s3://`.** Fargate cannot resolve one itself; without it artifacts silently fail to persist |

### Per-type overrides

Prefix is the type name uppercased with hyphens as underscores — `nginx-access` → `NGINX_ACCESS`.

| Variable | Impact |
|---|---|
| `<TYPE>_RATE` | Pin an absolute base rate. Wins over `<TYPE>_KNEE_EPS` |
| `<TYPE>_KNEE_EPS` | Override the knee-anchor estimate |
| `<TYPE>_SCENARIO` | Override the load shape |
| `<TYPE>_BATCH_SIZE` | Override events per send |

`SCENARIO`, `RATE` and `KNEE_EPS` as *global* overrides now fail at startup — a profile can declare
several types, so they are ambiguous. Use the per-type form.

---

## Log types

| Type | Format | Parse class |
|---|---|---|
| `auditd` | `type=… msg=audit(epoch:serial): k=v` | key=value + prefix regex |
| `cloudtrail` | nested JSON in a `Records[]` envelope | JSON decode + unroll + nested extract |
| `nginx-access` | combined log format | regex / grok — typically 10–50× a JSON decode |
| `json-app` | flat JSON | JSON — the cheap baseline |

Cardinality is the point: it drives the aggregator's real parse and index cost. Set it per field in
the profile's `cardinality` overrides. A type can also size its k6 VU pool with `pre_allocated_vus`
(default 200) and `max_vus` (default 10×); raise them if a run reports dropped iterations.

## Transports

| Transport | Options | Notes |
|---|---|---|
| `otlp-grpc` | `plaintext`, `timeout`, `resource_attributes` | `wire_bytes` is `null` — k6 does not expose the encoded size |
| `otlp-http` | `path`, `encoding`, `headers` | `encoding: "json"` only; `protobuf` is rejected at init |
| `hec` | `path`, `token_env`, `index`, `sourcetype`, `gzip` | Fails at init if the named env var is unset. `wire_bytes` is `null` when gzipped |
| `syslog` | `rfc`, `framing`, `tls`, `app_name` | Connects per batch, so throughput is handshake-bound and subject to a `TIME_WAIT` port ceiling |
| `null` | `count_bytes` | Discards everything. Measures the generator ceiling |

**Never put a credential in a profile.** Name the environment variable instead
(`"token_env": "HEC_TOKEN"`) and supply it via the task definition's `secrets` block.

## Scenarios

`smoke` · `calibrate` · `sweep` · `staircase` · `breakpoint` · `spike` · `sawtooth` · `burst-idle` ·
`plateau` · `soak` · `backpressure-hold` · `recovery`

Each type anchors its own rate: `knee` multiplies a measured knee estimate (discovery), `absolute`
multiplies a base pinned in git (regression baselines, which must not drift when an estimate does).

## Output

`summary.json` — resolved config, per-type and aggregate metrics, threshold verdicts, and a
validity block. With `EMIT_TIMELINE`, also `timeline.jsonl` (15s rollups, one JSON record per line).

`validity.valid` answers *"is this measurement trustworthy?"* — separate from *"did the target
pass?"*. A run that drops iterations measured the generator, not the target.

`events_sent` counts what the target **accepted**, not what was handed to it. An OTLP receiver can
answer `200` and still refuse part of a batch (`partial_success`); those records land in
`events_rejected` and the batch counts as a failed send. See
[OTLP Partial Success](docs/user-guide.md#otlp-partial-success).

| Exit code | Meaning |
|---|---|
| `0` | Pass |
| `99` | Threshold breached — the run completed and found what it was looking for |
| other | The run failed to complete |

## Aggregator configs

`aggregator-configs/<type>/{cribl/pipeline.json,vector/transform.json}` — generated from the same
log-type definitions the generator emits from.

```bash
npm run aggregator-configs   # regenerate; CI fails if the tree drifts
```

Vector configs are verified automatically: a containerised Vector parses real generated events and
every declared field is checked. **Cribl configs are verified manually** — see
[aggregator-configs/README.md](aggregator-configs/README.md). A green test suite does not cover them.

## Known limitations

- **CloudTrail emits one record per envelope.** Exercises an aggregator's unroll path but not its
  amortisation across a large `Records[]` array, so real per-record cost may be lower.
- **Field values are synthetic.** Cardinality and skew are realistic; values are not. `awsRegion`
  is `region-3`, ARNs are `arn:synthetic::0:role/r-7`. A rule keyed on a real value will not fire.
- **Live delivery was verified over `hec`, not `otlp-grpc`.** Payloads for all three multi-type
  formats are confirmed end-to-end; `otlp-grpc` carrying a multi-scenario run is not.
- **`json-app` had no live-delivery check** in that pass. Its wire output is unchanged from before,
  so this is a verification gap, not a known regression.

## Building

```bash
docker build -t k6-load-gen:latest .
docker build --build-arg BASE_IMAGE=your/hardened-base .   # substitute the runtime base
```

`xk6` builds a pinned k6 binary with the `k6/x/tcp` extension at image-build time — runtime
extension resolution needs external egress and fails in a closed network. A substituted base needs
Node 22+, `curl`, `unzip`, a writable `/tmp`, and glibc. The image runs as non-root.

## Development

```bash
npm ci
npm test          # unit tests — no k6, no network, no container
npm run typecheck # both tsconfigs
```

Most of the codebase imports nothing from k6 — payload generation, scenario resolution, config
validation, summary assembly, the aggregator renderers — so it is testable in milliseconds. The
k6-coupled adapters are deliberately thin.

Two tsconfigs on purpose: `tsconfig.json` restricts types to `@types/k6`, so a file k6 executes
cannot reference `process` and typecheck clean. `tsconfig.node.json` covers the Node entrypoints
and the test suite.

## Docs

- **[docs/deployment-guide.md](docs/deployment-guide.md)** — ECS task definitions, IAM, fleets
- **[docs/user-guide.md](docs/user-guide.md)** — profiles, log types, interpreting output
- **[docs/results-guide.md](docs/results-guide.md)** — reading the S3 artifacts: key layout, every field, merge rules, worked examples
- **[docs/run-validity.md](docs/run-validity.md)** — why a run is invalid, and the fix for each condition
- **[docs/architecture-overview.md](docs/architecture-overview.md)** — internals
