# Interpreting k6-load-gen results in S3

A reference for reading the artifacts a run leaves under `RESULTS_URI`. Written so that a person
or an LLM with S3 read access can answer "what happened in this run, and can the numbers be
trusted?" from the files alone, without the source. Every field named here exists in the code as
of schema_version 2; nothing is inferred.

## 0. Rules that override everything else

1. **`validity.valid: false` means the numbers are void.** The generator could not do its job
   (it dropped iterations, sent nothing, or a fleet member never ran), so the run measured the
   generator, not the target. Report the reasons; do not report latency or throughput as findings.
2. **Threshold failures are the measurement, not a defect.** `thresholds.slo[].ok: false` says the
   target missed an SLO. A `breakpoint` or `sweep` run exists to find that point. It does not make
   the run invalid.
3. **`rate.requested_eps` and `rate.achieved_eps` are already fleet-wide on every artifact.**
   Never add them across generators. `metrics.*.count` and `types.*` counts are per artifact and
   do add up.
4. **`rate.delta_pct` is rounding drift, not throughput shortfall.** It is the worst gap between
   the rate a stage asked for and the rate k6 can express as whole iterations per second, across
   all stages. Achieved throughput is `metrics.events_sent.count / run.duration_sec`.
5. **Ignore `thresholds.structural_count`.** Those are never-failing plumbing thresholds that
   exist only to make per-type sub-metrics appear. They carry no verdict.

## 1. Where things are

For `RESULTS_URI=s3://<bucket>/<prefix>` (prefix may be empty):

| Key | One per | Read it to |
|---|---|---|
| `<prefix>/index/dt=<YYYY-MM-DD>/<run_id>-gen<i>.json` | generator | find runs; one flat JSON object per file |
| `<prefix>/index/dt=<YYYY-MM-DD>/<run_id>-fleet.json` | single-task fleet | find fleet runs; same flat shape with `is_fleet: true` |
| `<prefix>/runs/<run_id>/gen-<i>/summary.json` | generator | the full nested report for one generator |
| `<prefix>/runs/<run_id>/fleet/summary.json` | single-task fleet | the merged report; **read this one first when it exists** |
| `<prefix>/runs/<run_id>/gen-<i>/run.log` and `.../fleet/run.log` | generator / fleet | console output; the fleet log is the rendered fleet report |
| `<prefix>/timeline/dt=<YYYY-MM-DD>/<run_id>-gen<i>.jsonl` and `...-fleet.jsonl` | generator / fleet | 15-second buckets of throughput, failures and latency |
| `<prefix>/runs/<run_id>/gen-<i>/raw.json.gz` | generator, only with `KEEP_RAW=1` | every k6 sample; rarely needed |

`dt=` is the UTC date of `run.started_at`. A run that crosses midnight stays in its start date.
Keys contain only `run_id` and the generator index, so two runs that reused a `run_id` overwrote
each other; the newer object wins and the older is gone.

**Which summary to read.** If `runs/<run_id>/fleet/summary.json` exists, it is the authoritative
result for the run and the `gen-<i>/` summaries are the evidence behind it. If it does not exist,
either the run was a single generator (`gen-0/` only) or a multi-task fleet (several `gen-<i>/`
and no merge was performed; the merge can be produced later with `fleet-cli merge`, see §6).

## 2. The index row

One flat object per generator or fleet, every value a scalar or null. Meant for scanning many
runs; go to the summary for detail.

| Field | Type | Meaning |
|---|---|---|
| `schema_version` | number | 2 for everything described here |
| `run_id` | string | the run; shared by every generator of a fleet |
| `started_at`, `ended_at` | ISO 8601 | UTC; for a fleet, earliest start and latest end |
| `duration_sec` | number or null | wall clock; null if k6 could not report it |
| `k6_version` | string | may read `unknown` in container runs (known gap; not a fault) |
| `gen_index` | number or null | which generator; **null for a fleet row** |
| `gen_count` | number | how many generators the run was configured for |
| `is_fleet` | boolean | true only for the merged row of a single-task fleet |
| `generator_count`, `generators_reported` | number or null | fleet rows only: configured vs. produced a summary |
| `profile` | string | profile name |
| `transport` | string | `otlp-grpc`, `otlp-http`, `hec`, `syslog`, `null` |
| `scenario` | string | comma-joined shape per declared type, e.g. `soak,sweep,spike` |
| `requested_eps`, `achieved_eps` | number | fleet-wide peak-stage rate asked for / expressible |
| `delta_pct` | number | worst-stage rounding drift, signed percent (rule 4) |
| `events_attempted`, `events_sent` | number | totals for this artifact (summed on a fleet row) |
| `send_failure_rate` | number | 0..1, share of sends that failed |
| `dropped_iterations` | number | must be 0 for a valid run |
| `thresholds_failed` | number | count of SLO thresholds with `ok: false` |
| `valid` | boolean or null | rule 1 |

## 3. summary.json, field by field

```
schema_version   2
run              { run_id, started_at, ended_at, duration_sec, k6_version, active_types[] }
resolved_config  the profile as it ran, with per-type overrides applied and secrets redacted
generator        { gen_index (null on a fleet), gen_count }
rate             { requested_eps, achieved_eps, delta_pct }        rules 3 and 4
metrics          k6 metric values by name                           §3.1
types            per log type breakdown                             §3.2
thresholds       { slo[ {ok, metric, expression} ], structural_count }
verdict_from     the expressions that gated pass/fail (informational)
validity         { dropped_iterations, generator_cpu (always null today), valid, reasons[] }
payload_sample   up to 10 real events as sent, split across active types
warnings         configuration and merge notes                      §3.3
fleet            present only on a merged fleet summary             §4
```

`run.active_types` is which types actually ran; `resolved_config.types` lists every type the
profile declares. They differ when `TYPES=` selected a subset. `resolved_config.target.options`
values that are not on a safe allowlist appear as `"[redacted]"`; the endpoint itself is kept.

### 3.1 `metrics`

Keys are k6 metric names. Each value is the metric's k6 summary object; which fields exist
depends on the metric kind:

| Metric | Kind | Fields | Read |
|---|---|---|---|
| `events_attempted`, `events_sent`, `wire_bytes`, `send_errors`, `dropped_iterations` | Counter | `count`, `rate` | `count` is the total; `rate` is per second over the run |
| `send_failures` | Rate | `rate`, `passes`, `fails` | `rate` = share of sends that failed (0..1); a send is one batch, not one event |
| `send_duration` | Trend | `avg`, `min`, `med`, `max`, `p(90)`, `p(95)`, `p(99)` | milliseconds per send (one batch); on a fleet, see §4 |

Also present: k6's own metrics (`iterations`, `vus`, `data_sent`, `http_req_*` or
`grpc_req_duration` depending on transport) and tagged copies such as
`events_sent{scenario:auditd}`. The tagged copies are what `types` is built from; prefer `types`.

Meaning of the project metrics: a **send** is one iteration delivering one batch of
`batch_size` events. `events_attempted` counts events in every batch tried;
`events_sent` counts events in batches the target acknowledged; `send_errors` counts failed
batches; `wire_bytes` is bytes on the wire as the transport could observe them.

### 3.2 `types`

One entry per type in `run.active_types`, each with `events_attempted`, `events_sent`,
`send_failures` (a rate, 0..1), `send_duration` (the Trend object), `wire_bytes`, `send_errors`.

- **`null` means not measured**, not zero: no sub-metric reached the summary for that type.
- **`wire_bytes: null` is normal** for `otlp-grpc` (k6 cannot see the encoded size) and for
  `hec` with gzip on. It never means zero bytes were sent.
- On a fleet, counts are summed; `send_failures` is the worst generator; `send_duration` follows §4.

### 3.3 `warnings`

Free text. Common entries and what they imply:

| Warning contains | Meaning | Effect on interpretation |
|---|---|---|
| `rate drift` | a stage's target did not divide evenly by `batch_size` | explains a non-zero `delta_pct`; not a fault |
| `gen_count=N ... ignored: this shape uses the shared-iterations executor` | the `smoke` shape ran its fixed 20 iterations in every generator | totals are N x 2000 events; not a rate measurement |
| `duration_scale=... ignored` | same, for `DURATION_SCALE` on `smoke` | run length was not scaled |
| `looks like a per-type override, but ... does not match` | an env var with a type-like prefix was not recognised | that override did nothing |
| `profile threshold ... ignored` | a profile tried to set a validity threshold | the fixed validity threshold applied instead |
| `send failures occurred (run-wide total); console logging is capped` | more failures than the log shows | trust `metrics.send_failures`, not the log |
| `generators disagree on ...` | fleet members ran with different config or identity | treat the merged config as the first generator's; investigate |
| `null on gen-i; summed the rest` | a per-type count was missing on some generators | the fleet total under-counts those generators |
| `k6 did not report state.testRunDurationMs` | duration unknown | `duration_sec` is null; do not compute throughput from it |

## 4. The `fleet` block and how merged fields were produced

Present only on `runs/<run_id>/fleet/summary.json`. `schema_version` stays 2 and every other
field keeps its shape, so a reader of a single summary can read a fleet summary the same way.

```
fleet.generator_count       configured N
fleet.generators_reported   how many produced a summary.json
fleet.exit_code             the fleet verdict as an exit code (see §5)
fleet.generators[]          per generator: gen_index, exit_code, summary_present, started_at,
                            ended_at, duration_sec, rate, events_attempted, events_sent,
                            send_failure_rate, send_errors, dropped_iterations,
                            send_duration_p99, thresholds_failed, valid, reasons[]
fleet.aggregation           free-text map naming the rule used for each non-obvious field
```

Merge rules:

| Field | Rule |
|---|---|
| `metrics.*.count`, `passes`, `fails`, `types.*` counts, `validity.dropped_iterations` | summed |
| `metrics.send_failures.rate` | recomputed as fails / (passes + fails) |
| `rate.*` | taken from one generator (already fleet-wide) |
| `send_duration.min` / `.max` | min / max |
| `send_duration.avg`, `med`, `p(90)`, `p(95)`, `p(99)` | **worst generator (max)**: an upper bound, not a true fleet percentile |
| `thresholds.slo[].ok` | true only if true on every generator that reported it |
| `validity.valid` | AND of the generators, and every generator must have reported |
| `validity.reasons` | each generator's reasons prefixed `gen-<i>:`, plus `gen-<i> produced no summary.json (exit <code>)` |
| `warnings` | a warning every generator emitted appears once; others are prefixed `gen-<i>:` |
| `run.started_at` / `ended_at` | earliest / latest; `duration_sec` recomputed |

A generator with `summary_present: false` in `fleet.generators[]` crashed or was misconfigured;
its `run.log` is still under `gen-<i>/` and is the place to look.

## 5. Exit codes and verdicts

| Code | Meaning |
|---|---|
| 0 | ran to completion; every SLO threshold passed |
| 99 | ran to completion; at least one SLO threshold failed (the CI gate) |
| 107 | k6 refused to start: bad profile, unknown type, missing token variable, rejected global override |
| 1 | the wrapper promoted a claimed success with no summary to a failure, or a generator recorded no exit code |
| other | k6 crashed or was killed |

Fleet precedence (`fleet.exit_code` and the container's exit): any code other than 0 or 99 beats
99, because a generator that never ran means the fleet numbers are not a measurement; 99 beats 0.
The exit code and `validity.valid` are independent: a run can exit 0 and be invalid (dropped
iterations with no threshold on them), or exit 99 and be valid (the target missed an SLO).

## 6. timeline.jsonl

One JSON object per line, one line per bucket, chronological. Buckets are `TIMELINE_BUCKET_SEC`
wide (default 15) and aligned to the epoch, so generators of one run share boundaries.

| Field | Meaning |
|---|---|
| `bucket_start` | ISO 8601 UTC start of the bucket |
| `bucket_sec` | width |
| `events_sent`, `events_attempted` | events in this bucket |
| `eps` | `events_sent / bucket_sec`, the achieved rate in this bucket |
| `send_failures` | failed sends in this bucket |
| `send_samples` | sends observed in this bucket (the denominator of the next field) |
| `failure_rate` | `send_failures / send_samples`, 0 when no sends |
| `send_duration_p50`, `_p95`, `_p99` | ms, null when the bucket had no sends |
| `dropped_iterations` | must stay 0 |

Use it to see the shape of a run: for a `sweep`, `eps` climbs in steps while `p99` and
`failure_rate` show where the target stops keeping up. The fleet timeline is the bucket-wise sum
of the generators' timelines, with percentiles taken as the worst generator per bucket.

A timeline is absent when the run set `EMIT_TIMELINE=0` or the profile's `emit_timeline: false`.

## 7. Reading procedure

Given a `run_id`:

1. List `runs/<run_id>/`. If `fleet/` exists, read `fleet/summary.json`; otherwise read every
   `gen-<i>/summary.json`.
2. Check `validity.valid`. If false, stop and report `validity.reasons` (rule 1).
3. Read `resolved_config` for what was tested: transport, endpoint, types, batch sizes,
   scenarios, anchors. Read `run.active_types` for what actually ran.
4. Report the load: `rate.requested_eps` (peak asked for), `metrics.events_sent.count`,
   `run.duration_sec`, and throughput as their ratio. Mention `delta_pct` only if its warning
   is present, and describe it as rounding.
5. Report delivery: `metrics.send_failures.rate`, `metrics.send_errors.count`, and per type from
   `types`.
6. Report latency: `metrics.send_duration` `med` / `p(95)` / `p(99)`, stating that these are
   per batch of `batch_size` events, and on a fleet that percentiles are the worst generator's.
7. Report the verdict: `thresholds.slo` entries with `ok: false`, and the exit code if known.
8. If the question is about behaviour over time (a knee, a ramp, recovery), use the timeline.
9. Surface every entry of `warnings` that changes how a number should be read (§3.3).

For a set of runs, start from `index/dt=*/` rows: filter on `valid`, group by `profile` and
`scenario`, sort by `started_at`, and use `requested_eps` versus `send_failure_rate` and
`thresholds_failed` to locate the knee across runs.

## 8. Worked examples

**A healthy single generator.**

```json
{ "run": { "run_id": "sweep-014", "duration_sec": 1260, "active_types": ["json-app"] },
  "generator": { "gen_index": 0, "gen_count": 1 },
  "rate": { "requested_eps": 7500, "achieved_eps": 7500, "delta_pct": 4.0 },
  "metrics": { "events_sent": { "count": 5292000 }, "send_failures": { "rate": 0.0002 },
               "send_duration": { "med": 18.2, "p(95)": 41.0, "p(99)": 96.5 } },
  "thresholds": { "slo": [ { "ok": true, "metric": "send_failures", "expression": "rate<0.001" },
                           { "ok": true, "metric": "send_duration", "expression": "p(99)<250" } ],
                  "structural_count": 6 },
  "validity": { "dropped_iterations": 0, "valid": true, "reasons": [] },
  "warnings": [ "rate drift 4.0% at the 0.25x stage: ..." ] }
```

Reading: a 21-minute sweep peaking at 7500 events/s; 5.29 million events delivered; 0.02% of
sends failed; p99 of 96.5 ms per batch; both SLOs passed; valid. The 4% is rounding at the
lowest stage, not lost throughput.

**A fleet with one crashed generator.**

```json
{ "generator": { "gen_index": null, "gen_count": 3 },
  "validity": { "valid": false, "dropped_iterations": 0,
                "reasons": [ "gen-1 produced no summary.json (exit 107)" ] },
  "fleet": { "generator_count": 3, "generators_reported": 2, "exit_code": 107,
             "generators": [ { "gen_index": 0, "exit_code": 0,   "summary_present": true,  "valid": true },
                             { "gen_index": 1, "exit_code": 107, "summary_present": false, "valid": false },
                             { "gen_index": 2, "exit_code": 0,   "summary_present": true,  "valid": true } ] } }
```

Reading: invalid; generator 1 never started (107 is a configuration refusal) so the fleet offered
two thirds of the intended rate. The counts present are real for generators 0 and 2 but do not
describe the configured load. Look at `runs/<run_id>/gen-1/run.log` for the refusal message.

**A run that measured the generator.**

```json
{ "validity": { "dropped_iterations": 1842, "valid": false,
                "reasons": [ "generator dropped 1842 iterations — it could not sustain the offered rate, so this run measured the generator rather than the target (validity threshold failed: dropped_iterations count<1)" ] } }
```

Reading: void. Raise `pre_allocated_vus` / `max_vus` in the profile, lower the rate, use a bigger
task, or split across generators, then rerun.

For what to do when a run is invalid, condition by condition, see [run-validity.md](run-validity.md).

## 9. Glossary

- **generator**: one k6 process with one `gen_index`; a fleet is N of them sharing a `run_id`.
- **send / batch**: one iteration delivering `batch_size` events in one request or connection.
- **anchor**: the reference rate a shape's stage multipliers apply to; `knee` (an estimate) or
  `absolute`.
- **knee**: the rate at which the target's latency or failure rate departs from its baseline.
- **structural threshold**: a never-failing threshold that only exists to expose per-type
  sub-metrics; excluded from `thresholds.slo`.
- **validity threshold**: `dropped_iterations count<1`, fixed, cannot be changed by a profile.
