# Why a run is invalid, and what to do about it

`validity.valid: false` means the numbers in that run describe the generator, not the target.
This page covers where the reason is recorded and, for each of the four conditions that can
cause it, the fix and the steps. Failed SLO thresholds do **not** make a run invalid; they are the
measurement and live under `thresholds.slo`.

## Where the reason is recorded

| Place | What you see | When to use it |
|---|---|---|
| CloudWatch Logs (or `run.log`) | a block headed `RUN IS NOT VALID:` with one line per reason, at the end of the report; on a fleet it follows the `[gen-<i>]` lines and is also in `fleet/run.log` | first look, no download |
| `validity.reasons` in `summary.json` | the authoritative list; on a fleet each entry is prefixed `gen-<i>:` | scripts, LLM readers |
| `fleet.generators[]` in the fleet summary | per generator: `exit_code`, `summary_present`, `dropped_iterations`, `valid`, `reasons` | when the fleet reason names one generator |
| `runs/<run_id>/gen-<i>/run.log` | that generator's raw k6 output | the actual error text behind a crash or refusal |

```bash
aws s3 cp s3://<bucket>/runs/<run_id>/fleet/summary.json - | jq '.validity'
```

```bash
aws s3 cp s3://<bucket>/runs/<run_id>/fleet/summary.json - | jq '.fleet.generators[] | {gen_index, exit_code, summary_present, dropped_iterations, valid, reasons}'
```

For a single generator read `runs/<run_id>/gen-0/summary.json` instead.

## Condition 1: dropped iterations

**Reason text:** `generator dropped N iterations — it could not sustain the offered rate, so this
run measured the generator rather than the target`.

**What it means.** k6's arrival-rate executor had an iteration due and no free VU to run it, so
the iteration was skipped. The offered rate was never delivered, so latency and failure figures
describe a generator under strain. Causes, in order of likelihood: the VU pool is too small for
the rate multiplied by the per-send latency; the task is CPU-bound; too many generators share one
task.

**Recommended fix.** Reduce sends per second first (bigger batches), then add capacity, then
enlarge the VU pool. Only the last needs a rebuilt image.

**Steps.**

1. Check the ratio that matters: `rate.requested_eps / batch_size` is the sends per second the
   generator needed, and `metrics.send_duration.p(99)` in seconds times that number is roughly
   how many VUs were busy at the peak. If that product approaches `pre_allocated_vus` (default
   200), the pool was the limit.
2. Raise the batch size at launch, no rebuild: add `<TYPE>_BATCH_SIZE` to the overrides, for
   example `JSON_APP_BATCH_SIZE=500`. Five times the batch is one fifth the sends per second for
   the same EPS.
3. If a single-task fleet, check the CPU warning in the log (`N generators on M CPUs`). Give the
   task more vCPU, or lower `GEN_COUNT`, or move to a multi-task fleet with `GEN_INDEX` per task
   and the same `RUN_ID` and `GEN_COUNT`.
4. If the pool itself must grow, set `pre_allocated_vus` and `max_vus` on the type in the profile
   JSON, rebuild the image, push it to ECR, and register a task-definition revision. There is no
   environment override for these two keys.
5. Rerun with a fresh `RUN_ID`, then confirm `validity.dropped_iterations` is 0 before reading
   anything else.

## Condition 2: zero events attempted

**Reason text:** `this run attempted 0 events — the target may be unreachable, or the connection
failed before any event could be sent`.

**What it means.** Not one batch was tried. The transport could not connect, or every send raised
before k6 counted an attempt. Every other signal (failure rate, dropped iterations) depends on
samples that never existed, so this is the only check that catches a run that transmitted
nothing.

**Recommended fix.** Treat it as a connectivity or profile mismatch, not a load problem. Find the
first error line, then fix the path between the task and the target.

**Steps.**

1. Read the first `send failed #1` line in `run.log`; the `error=` text names the failure:
   connection refused, timeout, DNS, TLS, or an HTTP status.
2. Confirm `TARGET` matches the transport's expected form: `host:port` for `otlp-grpc` and
   `syslog`, a full `http://` or `https://` URL for `otlp-http` and `hec`. Check the port matches
   the aggregator's source (4317 gRPC, 4318 OTLP/HTTP, 8088 HEC).
3. Confirm the generator's security group allows egress to that port and the aggregator's group
   allows ingress from the generator's group. A missing rule shows as a timeout, not a refusal.
4. Confirm the aggregator source accepts the transport's wire format: an `http_server` source
   needs the `hec` transport (newline-delimited JSON), not `otlp-http`.
5. Rerun the wiring check: same overrides, `JSON_APP_SCENARIO=smoke` or `DURATION_SCALE=0.02`,
   fresh `RUN_ID`. Move on only when `events_attempted` equals `events_sent` and both are
   non-zero.

## Condition 3: a fleet member produced no summary

**Reason text:** `gen-<i> produced no summary.json (exit <code>)`. Appears on any merged fleet,
single-task or merged from S3 with `fleet-launch merge`; the fleet's `exit_code` takes that
generator's code under the crash-beats-99 precedence. The code comes from the generator's own
`exit_code` artifact, or from what ECS reported for its container when it never wrote to S3.

**What it means.** That k6 process ended before `handleSummary` ran, so the fleet offered less
load than configured and the merged counts do not describe the intended run. The exit code says
why:

| Exit | Cause | Where the text is |
|---|---|---|
| 107 | k6 refused to start: invalid profile, unknown log type, a legacy global override such as `SCENARIO`, a missing token variable named by `token_env` | first lines of `gen-<i>/run.log` |
| 137 | killed, almost always out of memory | ECS task `stoppedReason`; the log ends abruptly |
| 1 | the wrapper found exit 0 with no summary, or no exit code was recorded | `run.sh:` lines in the log |
| other | k6 crashed | end of `gen-<i>/run.log` |

**Recommended fix.** Fix the named generator's cause; the other generators' artifacts are intact
and were shipped, but rerun the whole fleet afterwards, because a fleet with a missing member is
not a measurement of the configured rate.

**Steps.**

1. Identify the member from `fleet.generators[]` (`summary_present: false`) and its `exit_code`.
2. For 107, read the refusal in `runs/<run_id>/gen-<i>/run.log` and correct the input: remove
   any `SCENARIO`, `RATE` or `KNEE_EPS` global from the task definition or overrides and use the
   `<TYPE>_` form; supply the token variable via the task definition's `secrets` array; fix the
   profile. All generators receive the same environment, so if only one refused, compare its log
   with a sibling's; a 107 on one member usually means a resource limit at start, not config.
3. For 137, raise the task's memory: each generator is a full k6 process with its own VU pool.
   As a rough guide, budget per generator what a single-generator run of the same profile used,
   times N, plus headroom.
4. For any other code, the last lines of that generator's log carry the crash. If it is a
   transport error partway through, treat it as Condition 2 for that member.
5. Rerun with a fresh `RUN_ID` and confirm `fleet.generators_reported` equals
   `fleet.generator_count`.

## Condition 4: fleet members disagree on configuration

**Reason text:** `fleet members disagree on configuration: <field> differs ...`, where `<field>` is
`generator.gen_count`, `run.active_types`, `resolved_config` or `schedule`. Fleet summaries only.

**What it means.** Every generator ran and reported, but they were not all running the same test.
The merged counts are real events that were really sent — they just do not describe one
configuration, so the fleet's EPS, per-type breakdown and thresholds cannot be attributed to the
profile named in `resolved_config` (which is the FIRST reporting generator's). Typical causes:
the task definition was updated between launching two generators; one generator got a different
`TYPES`, `<TYPE>_BATCH_SIZE` or profile through its overrides; a `merge` was run with a `--count`
that does not match the `GEN_COUNT` the generators were launched with. `schedule` can differ while
`resolved_config` agrees: `DURATION_SCALE` and `GEN_COUNT` live in the environment, not the
profile, and either one alone moves every stage boundary — so a `schedule` disagreement means the
merged timeline's buckets mix stages and no per-stage figure describes a schedule any generator
actually ran.

Harder disagreements are not this condition: a differing `run_id` or `schema_version`, a summary
whose `generator.gen_index` is not its directory index, a duplicate index, or an index outside the
fleet make the merge **throw** instead — no fleet summary is written at all, and the merge command
exits 1 with the reason on stderr. `run.k6_version`, `rate` and `thresholds.structural_count`
disagreements are only warnings. See `docs/results-guide.md` §4.2.

**Recommended fix.** Find the odd generator, make the fleet uniform, rerun. Do not reason from the
merged numbers.

**Steps.**

1. Read the reason: `generator.gen_count` names each generator and its value, `run.active_types`
   names the values, `resolved_config` names which generators differ from `gen-0`.
2. Compare the configurations directly, one generator against another:
   `diff <(aws s3 cp s3://<bucket>/runs/<run_id>/gen-0/summary.json - | jq -S .resolved_config) \
        <(aws s3 cp s3://<bucket>/runs/<run_id>/gen-1/summary.json - | jq -S .resolved_config)`
   (`jq -S` sorts keys, which is how the merge compares them — key order is never the difference).
3. For a `generator.gen_count` mismatch, check the launch: every generator must receive the same
   `GEN_COUNT`, and a `fleet-launch merge --count N` must use that same N. A wrong `gen_count` also
   means each generator sized its share of the rate wrongly, so `rate.*` is not the fleet's rate.
4. For `run.active_types`, check `TYPES` in the overrides; for `resolved_config`, check the profile
   baked into the image each task ran (a task-definition revision that changed the image mid-launch
   gives exactly this).
5. Rerun the whole fleet with one configuration and a fresh `RUN_ID`.

## Validity versus exit code

The two are independent. A run can exit 0 and be invalid (iterations dropped, no threshold on
them), or exit 99 and be valid (the target missed an SLO under a delivered load). Gate CI on the
exit code; gate conclusions on `validity.valid`.
