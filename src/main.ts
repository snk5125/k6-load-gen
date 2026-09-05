import exec from 'k6/execution';

import { profileName, readOverrides, readTypeOverrides, startAt } from './config/env.ts';
import { validateProfile, type Profile } from './config/schema.ts';
import { resolveRun } from './config/resolve.ts';
import { redactProfile } from './config/redact.ts';
import { buildThresholds, validityThresholdConflicts } from './metrics/thresholds.ts';
import { buildGenerator, type BatchGenerator } from './payload/generator.ts';
import { createTransport } from './transports/registry.ts';
import { buildSummary, MAX_PAYLOAD_SAMPLE } from './summary/build.ts';
import { renderSummary } from './summary/render.ts';
import {
  eventsAttempted,
  eventsRejected,
  eventsSent,
  sendDuration,
  sendErrors,
  sendFailures,
  wireBytes,
} from './metrics/registry.ts';

// ---------------------------------------------------------------- init context

const PROFILE_NAME = profileName();
const PROFILE_PATH = `../profiles/${PROFILE_NAME}.json`;

// open() is deliberately outside the try: a missing file must keep k6's own
// "file not found" error, not be relabelled as a JSON syntax error.
const PROFILE_TEXT = open(PROFILE_PATH);

let raw: unknown;
try {
  raw = JSON.parse(PROFILE_TEXT);
} catch (e) {
  // A native SyntaxError names no file, and a hand-edited profile is the most
  // likely thing to be malformed. Say which file, and keep the parser's message.
  throw new Error(
    `profile "${PROFILE_NAME}" (${PROFILE_PATH}) is not valid JSON: ` +
      `${e instanceof Error ? e.message : String(e)}`,
  );
}

const validation = validateProfile(raw);
if (!validation.ok) {
  throw new Error(
    `profile "${PROFILE_NAME}" is invalid:\n  - ${validation.errors.join('\n  - ')}`,
  );
}

const profile = raw as Profile;
const typeOverrides = readTypeOverrides(Object.keys(profile.types));

// This module is evaluated once per VU (plus once up front and once more in
// the fresh runtime k6 builds for handleSummary), so an unguarded warning
// here prints once per VU — the same line up to 200 times at the default
// preAllocatedVUs. `__VU` is 0 only in the initial and summary evaluations
// (measured against this project's k6: exec.vu.idInTest throws in init
// context, `__VU` is 0 there and N inside VU N), so this prints twice per run.
const LOG_CONFIG_WARNINGS = __VU === 0;
function configWarn(line: string): void {
  if (LOG_CONFIG_WARNINGS) console.warn(`CONFIG WARNING: ${line}`);
}

for (const w of typeOverrides.warnings) configWarn(w);

const run = resolveRun(profile, readOverrides(), typeOverrides);

// When this generator was TOLD to start (bin/run.sh has already slept until
// it by the time k6 runs). Read here, in init context, because handleSummary
// executes in a fresh runtime where re-reading is fine but the value belongs
// next to the rest of the resolved run. See RunSummary.run.start_at.
const START_AT = startAt();

// A profile entry on a validity metric is dropped by buildThresholds; say so.
const thresholdWarnings = validityThresholdConflicts(run.profile.thresholds);
for (const w of thresholdWarnings) configWarn(w);

// One k6 scenario per active log type. The scenario key IS the log type
// name — that is what makes exec.scenario.name a valid dispatch key in the
// default function below, and what makes k6's scenario tag the per-type
// metric split a later task depends on. Do not rename it.
//
// NOTE: buildThresholds still takes a single-run shape
// (profile_thresholds/abort_on_fail) rather than a per-type one, and `rate`/
// `payload_sample` below are aggregated across active types (OR for
// abort_on_fail, sum for eps, worst for delta_pct, concatenation for
// samples/warnings) rather than attributed per type. buildSummary DOES now
// produce a real per-type breakdown (`summary.types`) from the tagged
// sub-metrics k6 reports — see src/summary/build.ts — so events/failures/
// duration numbers ARE per-type; only the rate/threshold/sample shapes above
// remain aggregate-only.
const scenarios: Record<string, unknown> = {};
const GENERATORS: Record<string, BatchGenerator> = {};
for (const type of run.active_types) {
  const resolved = run.types[type];
  scenarios[type] = resolved.k6;
  GENERATORS[type] = buildGenerator(resolved.payload, {
    run_id: run.run_id,
    gen_index: run.gen_index,
  });
}

for (const type of run.active_types) {
  for (const w of run.types[type].warnings) configWarn(`[${type}] ${w}`);
}

const abortOnFail = run.active_types.some((t) => run.types[t].abort_on_fail);
const aggregateRate = run.active_types.reduce(
  (acc, t) => {
    const r = run.types[t];
    return {
      requested_eps: acc.requested_eps + r.requested_peak_eps,
      achieved_eps: acc.achieved_eps + r.achieved_peak_eps,
      delta_pct: Math.abs(r.delta_pct) > Math.abs(acc.delta_pct) ? r.delta_pct : acc.delta_pct,
    };
  },
  { requested_eps: 0, achieved_eps: 0, delta_pct: 0 },
);

export const options = {
  scenarios,
  thresholds: buildThresholds({
    profile_thresholds: run.profile.thresholds,
    abort_on_fail: abortOnFail,
    active_types: run.active_types,
  }),
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

const transport = createTransport(run.profile.target.transport, {
  endpoint: run.profile.target.endpoint,
  options: run.profile.target.options,
});

// Split the MAX_PAYLOAD_SAMPLE budget roughly evenly across active types
// instead of concatenating whole batches — a concatenation would let
// whichever type happens first (e.g. the largest batch_size) fill the
// entire published sample, leaving the other active types with zero
// evidence of what they emitted in the run's own summary.
const SAMPLE_PER_TYPE = Math.max(1, Math.ceil(MAX_PAYLOAD_SAMPLE / Math.max(1, run.active_types.length)));
const PAYLOAD_SAMPLE = run.active_types.flatMap((type) =>
  GENERATORS[type].expectedAt(0).slice(0, SAMPLE_PER_TYPE),
);

// Bounded error logging: an unbounded console.warn against a failing target
// floods the log tier and slows the generator enough to corrupt the run.
//
// errorCount is module-scope init-context state, and k6 gives each VU its
// own copy of that state — so this bound is PER-VU, not per-run. At the
// default preAllocatedVUs: 200, a total outage produces roughly 2,000
// initial log lines (200 VUs x LOG_FIRST), not 10. This is accepted (still
// four orders of magnitude below unbounded), but do not read LOG_FIRST as a
// run-wide cap.
//
// It must also NEVER be read from handleSummary: k6 evaluates handleSummary in
// a fresh runtime that re-runs this module top to bottom, so errorCount is 0
// there regardless of how many sends failed. The run-wide total comes from the
// send_errors metric instead — metrics cross the runtime boundary, module state
// does not.
const LOG_FIRST = 10;
const LOG_EVERY = 1000;
let errorCount = 0;
// Advisories (an OTLP receiver that accepted everything but still said
// something — see src/transports/otlp-partial.ts) are bounded SEPARATELY
// from failures, and by the same LOG_FIRST/LOG_EVERY rule. A shared counter
// would let a chatty-but-healthy receiver consume the whole failure budget
// and hide the first real error behind ten deprecation notices.
let advisoryCount = 0;
let connected = false;

// ------------------------------------------------------------------ VU context

export default async function (): Promise<void> {
  if (!connected) {
    await transport.connect();
    connected = true;
  }

  const type = exec.scenario.name;
  const generator = GENERATORS[type];
  if (!generator) {
    // Cannot happen if `scenarios` and `GENERATORS` above are built from the
    // same list — but if it ever does, fail loudly rather than sending nothing.
    throw new Error(`no generator for scenario "${type}"`);
  }

  const iteration = exec.scenario.iterationInTest;
  const batch = generator.batchAt(iteration, Date.now());

  const started = Date.now();
  const res = await transport.send(batch, {
    run_id: run.run_id,
    gen_index: run.gen_index,
    iteration,
  });
  sendDuration.add(Date.now() - started);

  eventsAttempted.add(batch.length);
  sendFailures.add(!res.ok);

  // events_sent counts what the target ACCEPTED, not what we handed it. For
  // every transport but OTLP those are the same number on a successful
  // send; OTLP can accept a request and refuse part of its records on a
  // 200/StatusOK (src/transports/otlp-partial.ts), and counting those as
  // sent published a 100%-delivery run against a collector dropping half of
  // every batch. `null` means the counts are not attributable (the batch
  // failed as a whole, or the response was malformed) — never zero.
  if (res.accepted !== null && res.accepted > 0) eventsSent.add(res.accepted);
  if (res.rejected !== null && res.rejected > 0) eventsRejected.add(res.rejected);
  // Counted whenever it was observed, INCLUDING on a partial rejection:
  // those bytes really did leave this generator, and dropping them would
  // under-report the load actually offered. Failures still report null.
  if (res.wire_bytes !== null) wireBytes.add(res.wire_bytes);

  if (res.ok) {
    if (res.advisory) {
      advisoryCount++;
      if (advisoryCount <= LOG_FIRST || advisoryCount % LOG_EVERY === 0) {
        console.warn(`send advisory #${advisoryCount} (batch accepted in full): ${res.advisory}`);
      }
    }
    return;
  }

  // A PARTIAL rejection is a receiver-side verdict on the records, not a
  // broken connection: the request completed. Forcing a reconnect here
  // would turn a collector's ingest limit into a reconnect storm — and for
  // otlp-grpc, connect() on an already-connected client is exactly the
  // wrong response to a healthy RPC.
  const partiallyRejected = res.rejected !== null && res.rejected > 0;
  if (!partiallyRejected) connected = false; // force a reconnect on the next iteration
  sendErrors.add(1);
  errorCount++;
  if (errorCount <= LOG_FIRST || errorCount % LOG_EVERY === 0) {
    console.warn(
      `send failed #${errorCount} seq=${batch.length > 0 ? batch[0].seq : -1} ` +
        `status=${String(res.status)} error=${res.error ?? ''}`,
    );
  }
}

// -------------------------------------------------------------------- teardown

interface K6SummaryData {
  metrics: Record<string, unknown>;
  /** k6 fills this in; `testRunDurationMs` is the wall-clock length of the run. */
  state?: { testRunDurationMs?: number };
}

export function handleSummary(data: K6SummaryData) {
  const summaryWarnings: string[] = [];

  // handleSummary runs in a FRESH runtime: every module-scope constant in this
  // file is re-evaluated here, so a `new Date()` captured at init would read as
  // the summary time and make duration_sec 0 on every run. k6's own
  // state.testRunDurationMs is the only trustworthy source of elapsed time.
  const endedAt = new Date();
  const durationMs = data.state?.testRunDurationMs;
  let startedAtIso: string;
  if (typeof durationMs === 'number' && Number.isFinite(durationMs)) {
    startedAtIso = new Date(endedAt.getTime() - durationMs).toISOString();
  } else {
    // Do not invent a start time. An unparseable value makes buildSummary leave
    // duration_sec null, which is recoverable; a fabricated number is not.
    startedAtIso = 'unknown';
    summaryWarnings.push(
      'k6 did not report state.testRunDurationMs; run start time and duration are unknown',
    );
  }

  // Read the failure total from the metric, never from the module-scope
  // errorCount — see the note on errorCount above.
  const sendErrorTotal =
    (data.metrics.send_errors as { values?: { count?: number } } | undefined)?.values?.count ?? 0;

  const summary = buildSummary({
    run_id: run.run_id,
    started_at: startedAtIso,
    ended_at: endedAt.toISOString(),
    k6_version: __ENV.K6_VERSION || 'unknown',
    // Redacted: the summary is written to disk and uploaded to S3, so anything
    // left in resolved_config is published. See src/config/redact.ts.
    resolved_config: redactProfile(run.profile),
    gen_index: run.gen_index,
    gen_count: run.gen_count,
    rate: aggregateRate,
    // What this run intended to offer, stage by stage — published so a
    // timeline is read against the schedule that produced it rather than
    // having its stage boundaries inferred from the delivered rate.
    schedule: run.schedule,
    start_at: START_AT,
    metrics: data.metrics,
    active_types: run.active_types,
    payload_sample: PAYLOAD_SAMPLE,
    warnings: [
      ...run.active_types.flatMap((t) => run.types[t].warnings),
      ...typeOverrides.warnings,
      ...thresholdWarnings,
      ...summaryWarnings,
      ...(sendErrorTotal > LOG_FIRST
        ? [
            `${sendErrorTotal} send failures occurred (run-wide total); console ` +
              `logging is capped at ${LOG_FIRST} per VU, so the console may not show them all`,
          ]
        : []),
    ],
  });

  return {
    'summary.json': JSON.stringify(summary, null, 2),
    stdout: renderSummary(summary),
  };
}
