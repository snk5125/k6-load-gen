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
| `<prefix>/runs/<run_id>/gen-<i>/exit_code` | generator | k6's exit status, one line; present even when the generator wrote no summary |
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
run              { run_id, started_at, ended_at, duration_sec, k6_version, active_types[],
                   start_at }
resolved_config  the profile as it ran, with per-type overrides applied and secrets redacted
generator        { gen_index (null on a fleet), gen_count }
rate             { requested_eps, achieved_eps, delta_pct }        rules 3 and 4
schedule         what the run intended to offer, stage by stage     §3.0
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

`run.start_at` is the instant this generator was **scheduled** to start — `START_AT` exactly as it
was set (an ISO-8601 UTC timestamp, or a bare Unix epoch in seconds), or `null` when nothing
scheduled the run. `run.started_at` is when k6 actually began. The two differ by however long the
container took to place and k6 took to initialise; across a fleet that difference is
`fleet.start_skew_sec` (§4). Every task of a `fleet-launch`-launched fleet is given the *same*
`start_at`, which is what makes it the right thing to align stage boundaries on — see §8a.

### 3.0 `schedule` — what the run intended to offer

`rate` describes the **peak stage only**, and `resolved_config` names the shape but not the
resolved stage list. `schedule` is the missing statement of intent: the k6 stages as they were
actually resolved, in seconds and in events per second, so a timeline can be read against what was
offered instead of having its stage boundaries guessed from what was delivered. It is `null` on an
artifact produced before this field existed — treat that as *unknown*, never as *no stages*.

One entry per **active** type (stages are per type — see the multi-type note in §8a):

```
schedule.<type>.executor                  "ramping-arrival-rate" or "shared-iterations"
schedule.<type>.duration_scale            DURATION_SCALE as it applied (1 when unset)
schedule.<type>.gen_count                 fleet size the targets were sliced for
schedule.<type>.batch_size                events per iteration, after any <TYPE>_BATCH_SIZE
schedule.<type>.start_rate_per_sec        ramping-arrival-rate only: k6's startRate, iterations/s
schedule.<type>.iterations, .vus          shared-iterations only
schedule.<type>.stages[]                  in order; empty for shared-iterations
  .target_iterations_per_sec              k6's own `target`: ITERATIONS/s, per generator
  .target_eps_fleet                       target_iterations_per_sec x batch_size x gen_count —
                                          EVENTS/s offered by the whole fleet at that stage
  .duration_sec                           the stage's length, AFTER DURATION_SCALE
```

`target_eps_fleet` is directly comparable with a timeline bucket's `eps` (also fleet-wide on a
merged timeline): offered against delivered. Note that k6 ramps **linearly** within a stage, so a
stage is not a flat rate and a bucket cannot be labelled "ramp" or "hold" from this block — only
which stage it belongs to. Stage targets carry the same per-stage rounding `rate.delta_pct`
reports (§3, rule 4): `target_eps_fleet` is what was *achievable*, not the un-rounded request.

### 3.1 `metrics`

Keys are k6 metric names. Each value is the metric's k6 summary object; which fields exist
depends on the metric kind:

| Metric | Kind | Fields | Read |
|---|---|---|---|
| `events_attempted`, `events_sent`, `events_rejected`, `wire_bytes`, `send_errors`, `dropped_iterations` | Counter | `count`, `rate` | `count` is the total; `rate` is per second over the run |
| `send_failures` | Rate | `rate`, `passes`, `fails` | `passes` = failed sends, `fails` = successful sends; `rate` = passes/(passes+fails) = share of sends that failed (0..1); a send is one batch, not one event |
| `send_duration` | Trend | `avg`, `min`, `med`, `max`, `p(90)`, `p(95)`, `p(99)` | milliseconds per send (one batch); on a fleet, see §4 |

Also present: k6's own metrics (`iterations`, `vus`, `data_sent`, `http_req_*` or
`grpc_req_duration` depending on transport) and tagged copies such as
`events_sent{scenario:auditd}`. The tagged copies are what `types` is built from; prefer `types`.

Meaning of the project metrics: a **send** is one iteration delivering one batch of
`batch_size` events. `events_attempted` counts events in every batch tried;
`events_sent` counts events the target ACCEPTED; `events_rejected` counts events the target
took the request for and then refused; `send_errors` counts failed
batches; `wire_bytes` is bytes on the wire as the transport could observe them.

**`events_rejected` and OTLP partial success.** Only the two OTLP transports can produce a
non-zero `events_rejected`. An OTLP receiver may answer `200`/`StatusOK` and still refuse part
of the batch, in an `ExportLogsServiceResponse.partial_success` block naming how many log
records it dropped. Those records are NOT in `events_sent`, and a batch with any rejection
counts as a failed send: it raises `send_failures` and `send_errors` by one, exactly like a
transport error. So:

- `events_sent + events_rejected <= events_attempted` — a batch that failed outright (a 5xx,
  a refused connection) contributes to neither.
- A run with a high `send_failures` rate but a low `send_errors`-to-`events_rejected` ratio is
  a receiver dropping records, not a network fault. Read `events_rejected` first, then the
  warning text in the run log (`OTLP partial success: N of M log records rejected — <the
  receiver's own message>`), which usually names the limit that was hit.
- **`events_rejected: 0` on an OTLP run is a real measurement**, not an absence: it means the
  receiver acknowledged every record. Non-OTLP transports (`hec`, `syslog`, `null`) have no
  partial-acknowledgement shape at all and always report 0.
- A receiver that reports a rejection count larger than the batch, or one that is not a
  non-negative integer, is treated as a whole-batch failure and neither count is attributed —
  the warning text begins `malformed OTLP response`.
- A `partial_success` whose count is **zero** but which still carries a message is an advisory
  about the request, not a rejection. The run logs `send advisory #N (batch accepted in full)`
  and nothing is counted as failed.

### 3.2 `types`

One entry per type in `run.active_types`, each with `events_attempted`, `events_sent`,
`events_rejected`, `send_failures` (a rate, 0..1), `send_duration` (the Trend object),
`wire_bytes`, `send_errors`.

- **`null` means not measured**, not zero: no sub-metric reached the summary for that type.
- **`wire_bytes: null` is normal** for `otlp-grpc` (k6 cannot see the encoded size) and for
  `hec` with gzip on. It never means zero bytes were sent.
- **`events_rejected`** is the per-type share of the OTLP partial-success rejections described
  in §3.1. `0` means the receiver refused nothing for that type; `null` means not measured.
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
fleet.timeline_coverage     how much of the fleet timeline.jsonl covers (see below); null only
                            when a merge was run without timeline information at all
fleet.start_skew_sec        max(started_at) - min(started_at) over reporting generators (see
                            below); null when no generator reported a parseable start
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
| `metrics.send_failures.rate` | recomputed as passes / (passes + fails) — `passes` counts failed sends, `fails` counts successful sends |
| `rate.*` | taken from one generator (already fleet-wide) |
| `send_duration.min` / `.max` | min / max |
| `send_duration.avg`, `med`, `p(90)`, `p(95)`, `p(99)` | **worst generator (max)**: an upper bound, not a true fleet percentile |
| `thresholds.slo[].ok` | true only if true on every generator that reported it |
| `validity.valid` | AND of the generators; every generator must have reported; and the members must agree on configuration (§4.2) |
| `validity.reasons` | each generator's reasons prefixed `gen-<i>:`, plus `gen-<i> produced no summary.json (exit <code>)` and any `fleet members disagree on configuration:` line |
| `warnings` | a warning every generator emitted appears once; others are prefixed `gen-<i>:` |
| `run.started_at` / `ended_at` | earliest / latest; `duration_sec` recomputed |
| `run.start_at` | taken from one generator (every task is given the same `START_AT`); a disagreement is a **warning** |
| `schedule` | taken from one generator; a disagreement makes the fleet invalid (§4.2) |

A generator with `summary_present: false` in `fleet.generators[]` crashed or was misconfigured;
its `run.log` is still under `gen-<i>/` and is the place to look.

### 4.1 `fleet.timeline_coverage` — how much of the fleet the timeline covers

The merged `timeline.jsonl` is the **sum** of the per-generator timelines that existed. A
generator whose timeline is missing is simply absent from every bucket, and nothing inside the
file says so, so a per-stage EPS or failure rate read from it would silently under-count. This
block is that statement, and it is the first thing to read before any per-stage conclusion.

```
fleet.timeline_coverage.expected        generators that reported a summary — the ones a timeline
                                        could be expected from (a crashed generator is not held
                                        against coverage)
fleet.timeline_coverage.present[]       generator indexes whose timeline was found and merged
fleet.timeline_coverage.missing[]       reporting generators with no timeline
fleet.timeline_coverage.complete        missing[] is empty and at least one generator was expected
fleet.timeline_coverage.configured_off  NO generator had a timeline: EMIT_TIMELINE=0 or a profile
                                        with emit_timeline false — an intentional absence, not a gap
```

| Situation | `complete` | `configured_off` | What the merge does |
|---|---|---|---|
| every reporting generator shipped one | true | false | nothing to say |
| some did | false | false | a warning naming the missing generators and saying the fleet timeline under-counts; the report prints `timeline coverage : 2/3 generators (missing gen-1) — fleet timeline under-counts` |
| none did | false | true | no warning; the report prints `timeline coverage : none (timeline emission off)` |

When coverage is complete the merge also compares Σ`events_sent` over the merged timeline with
`metrics.events_sent.count`. Below 90% it adds a **warning** (never an error, and never
`valid: false`): the timeline looks truncated — a generator's `--out json` was cut short, or
buckets were lost — so per-stage figures under-count even though every generator is represented.

**Consumers** (including `tools/correlate_run.py`) must treat `complete: false` with
`configured_off: false` as "the timeline is a lower bound": say so prominently, list the stages,
and draw no knee verdict from figures that are missing a generator.

### 4.1a `fleet.start_skew_sec` — how far apart the fleet actually began

`max(started_at) - min(started_at)` over the **reporting** generators, in seconds (a generator that
never wrote a summary has no start to be skewed from, so it is not counted). `0` means they started
together; `null` means no generator reported a parseable start.

It bounds how sharp any per-stage reading can be. The merged timeline sums generators whose stage
boundaries sit this many seconds apart, so when the skew reaches the timeline bucket width the
merge adds a **warning**: some bucket holds two different stages and no bucket-level boundary is
exact. The width used is the merged timeline's own `bucket_sec` when there is one, else 15 s
(`TIMELINE_BUCKET_SEC`'s default). The fleet report prints it as `start skew : 3.0s across
generators`.

Reducing it is what `START_AT` is for — see the scheduled-start section of
`docs/deployment-guide.md`. A large skew with `run.start_at` set means the tasks were placed late,
not that the schedule was wrong.

### 4.2 Fleet identity — what makes N summaries one fleet

Merging summaries that are not N members of one run would invent a measurement, so some
disagreements stop the merge and others only void it.

**Hard (the merge throws; nothing is written, the fleet artifacts do not exist):**

| Condition | Why |
|---|---|
| `run.run_id` differs across reporting generators | these are two runs, not one fleet |
| `schema_version` differs | the fields do not mean the same thing |
| a summary's `generator.gen_index` is not its `gen-<i>` directory index | the summary does not belong to that generator |
| the same generator index is supplied twice | its numbers would be counted twice |
| a generator index is outside `0..gen_count-1` | the fleet is not the fleet that was merged |

**Soft (the fleet merges, `validity.valid` is false, reason prefixed `fleet members disagree on
configuration:`):** `generator.gen_count` disagreeing between generators or with the number of
directories merged; `run.active_types` disagreeing; `resolved_config` disagreeing; `schedule`
disagreeing. The evidence is still merged and still worth reading — it just does not describe one
configuration. See `docs/run-validity.md` Condition 4.

`schedule` is checked separately from `resolved_config` on purpose: `DURATION_SCALE` and
`GEN_COUNT` live in the environment, not the profile, so two generators can agree on
`resolved_config` and still have run different stage boundaries — which makes every per-stage
reading of the merged timeline describe a schedule neither of them ran.

`resolved_config` and `schedule` are compared **canonically** — JSON with every object's keys
sorted, recursively — so a difference in key order is never reported as a disagreement.

**Warnings only:** `run.k6_version`, `rate` and `thresholds.structural_count`.

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
`failure_rate` show where the target stops keeping up. Which stage a bucket belongs to comes from
`schedule` (§3.0), not from the bucket's own `eps` — inferring stages from the delivered rate
mislabels exactly the runs where the generator or target failed to keep up. The fleet timeline is the bucket-wise sum
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
8. If the question is about behaviour over time (a knee, a ramp, recovery), use the timeline,
   and read it against `schedule` (§3.0): each stage's `duration_sec` accumulated from
   `run.start_at` (or `run.started_at`) says which stage a bucket belongs to, and
   `target_eps_fleet` says what was offered there. On a fleet, check `fleet.start_skew_sec`
   (§4.1a) first — a skew at or above `bucket_sec` means no bucket-level boundary is exact.
   `tools/correlate_run.py` does all of this (§8a).
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
                  "structural_count": 7 },
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

## 8a. Correlating a run with the aggregator

`tools/correlate_run.py` (Python 3, no dependencies) joins a run's fleet summary and timeline with
the aggregator's Vector metrics and, optionally, the aggregator service's CPU from CloudWatch, stage
by stage, and prints a Markdown report plus JSON written to be handed to an LLM. Run `scrape`
against the aggregator's `prometheus_exporter` for the duration of the test, then `report` for the
run id:

```bash
python3 tools/correlate_run.py scrape --url http://<aggregator>:9598/metrics --interval 15 --out vector-metrics.jsonl
```

```bash
python3 tools/correlate_run.py report --results-uri s3://<bucket> --run-id <run_id> --metrics vector-metrics.jsonl --source http_json --records json-app --sink Splunk --cw-cluster <vector-cluster> --cw-service <vector-service> --json report.json
```

Per stage it shows what the generator offered and delivered (eps, p99, failures, dropped
iterations), what the named source, record-level and sink components received, sent, errored and
how busy they were, and the service's CPU average and maximum, then applies the knee rule from §7:
the first stage where p99 more than doubles against the first stages or failures exceed 0.1%, with
the CPU at that point.

**Where the stage boundaries come from.** When the summary carries a `schedule` (§3.0), the stages
are the run's own **intended** stages: each stage's `duration_sec` accumulated from a start
reference, with every timeline bucket assigned to the stage containing the bucket's start. The
`eps offered` column is that stage's `target_eps_fleet`, printed beside `eps delivered`. The start
reference is `run.start_at` when the run was scheduled with `START_AT` — one instant the whole
fleet shared — and otherwise the earliest of `fleet.generators[].started_at` (single generator:
`run.started_at`). Because generators do not all begin exactly on that instant, the report states a
boundary precision (`±N s`) and marks each stage's straddling buckets in the `sched` column as
`(+Nb)`: a straddling bucket holds two different offered rates, so its delivered EPS belongs
cleanly to neither stage. Buckets that fall outside the schedule entirely (an overrun) form their
own row with `sched` `-` and no offered eps. k6 ramps linearly within a stage, so a bucket carries
a stage index and never a "ramp"/"hold" label.

Only an artifact with **no** `schedule` falls back to the old behaviour — grouping consecutive
buckets whose delivered EPS stays within 15% — and the report then says `stage boundaries inferred
from delivered EPS (heuristic; older artifact)`. That inference mislabels precisely the runs worth
analysing, the ones that failed to deliver what they offered, which is why `schedule` exists.

**Multi-type runs.** Stages are per type. The report builds one stage grid when the active types'
stage boundaries are identical, and then `eps offered` is their **sum** across types (a timeline
bucket sums every type, so the sum is what the bucket should be compared against); it says so in
the alignment note. When the active types' boundaries differ, no single grid can describe a bucket,
so the report falls back to the heuristic and says why. Run one type at a time (`TYPES=`) when you
need per-type stage attribution.

Aggregator counts are the sum of positive increments across the consecutive scrapes covering each
stage rather than a plain endpoint subtraction, so a Vector counter reset (process restart mid-run)
is counted from its post-reset value instead of going negative, and a component that briefly
vanishes from a scrape contributes an unknown — not zero — increment for that gap. Both are flagged
per stage as `quality` (`reset` / `gaps`) in the JSON and as a "stage N quality" note in the
Markdown.

## 9. Glossary

- **generator**: one k6 process with one `gen_index`; a fleet is N of them sharing a `run_id`.
- **send / batch**: one iteration delivering `batch_size` events in one request or connection.
- **anchor**: the reference rate a shape's stage multipliers apply to; `knee` (an estimate) or
  `absolute`.
- **knee**: the rate at which the target's latency or failure rate departs from its baseline.
- **structural threshold**: a never-failing threshold that only exists to expose per-type
  sub-metrics; excluded from `thresholds.slo`.
- **validity threshold**: `dropped_iterations count<1`, fixed, cannot be changed by a profile.
