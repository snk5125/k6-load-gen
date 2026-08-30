import { VALIDITY_THRESHOLDS } from '../metrics/thresholds.ts';

export const SCHEMA_VERSION = 1;
const MAX_PAYLOAD_SAMPLE = 10;

export interface RunSummary {
  schema_version: number;
  run: {
    run_id: string;
    started_at: string;
    ended_at: string;
    duration_sec: number | null;
    k6_version: string;
  };
  resolved_config: unknown;
  generator: { gen_index: number; gen_count: number };
  /**
   * requested_eps/achieved_eps are the PEAK stage only. delta_pct is NOT the
   * drift between those two fields — it is the worst rounding drift across
   * ALL stages, signed, in percent, and can describe a different stage
   * entirely (a shape whose peak divides evenly can still be hot at a lower
   * multiplier). See ResolvedScenario.delta_pct in src/scenarios/resolve.ts.
   */
  rate: { requested_eps: number; achieved_eps: number; delta_pct: number };
  metrics: Record<string, Record<string, number>>;
  thresholds: Record<string, { ok: boolean; metric: string; expression: string }>;
  validity: {
    dropped_iterations: number;
    /** k6 cannot observe its own container CPU; sub-project 3 fills this. */
    generator_cpu: number | null;
    valid: boolean;
    reasons: string[];
  };
  payload_sample: unknown[];
  warnings: string[];
}

export interface BuildSummaryInput {
  run_id: string;
  started_at: string;
  ended_at: string;
  k6_version: string;
  resolved_config: unknown;
  gen_index: number;
  gen_count: number;
  rate: { requested_eps: number; achieved_eps: number; delta_pct: number };
  metrics: Record<string, unknown>;
  payload_sample: unknown[];
  warnings: string[];
}

interface K6Metric {
  values?: Record<string, number>;
  thresholds?: Record<string, { ok: boolean }>;
}

export function buildSummary(input: BuildSummaryInput): RunSummary {
  const metrics: Record<string, Record<string, number>> = {};
  const thresholds: RunSummary['thresholds'] = {};
  const reasons: string[] = [];
  const warnings = [...input.warnings];

  for (const name of Object.keys(input.metrics)) {
    const m = input.metrics[name] as K6Metric;
    if (m && m.values) metrics[name] = { ...m.values };
    if (m && m.thresholds) {
      for (const expression of Object.keys(m.thresholds)) {
        const ok = m.thresholds[expression].ok === true;
        thresholds[`${name}:${expression}`] = { ok, metric: name, expression };
        // Only VALIDITY thresholds (spec §8.2: always-on, not profile-configurable)
        // bear on whether the run's numbers mean anything. An SLO threshold from
        // the profile is the *measurement*, not a defect in it: a `breakpoint` run
        // exists to break one, and a `sweep` past the knee fails `send_failures` by
        // construction. Folding those into `reasons` marks every such run INVALID
        // and trains readers to ignore the flag. Failed SLO thresholds stay fully
        // visible in `summary.thresholds` and in the rendered output.
        if (!ok && name in VALIDITY_THRESHOLDS) {
          reasons.push(`validity threshold failed: ${name} ${expression}`);
        }
      }
    }
  }

  const dropped = metrics.dropped_iterations?.count ?? 0;
  if (dropped > 0) {
    reasons.push(
      `generator dropped ${dropped} iterations — it could not sustain the offered rate, ` +
        `so this run measured the generator rather than the target`,
    );
  }

  // k6 omits a metric entirely from data.metrics when it received zero
  // samples. A total outage from iteration one — a wrong target, or a
  // connect() that throws before any send — means events_attempted never
  // receives a sample, so it is either absent here or present with count: 0.
  // Every other validity signal (send_failures' threshold, dropped_iterations)
  // depends on samples that were never produced, so this is the only check
  // that catches a run that transmitted nothing.
  const eventsAttempted = metrics.events_attempted?.count ?? 0;
  if (eventsAttempted === 0) {
    reasons.push(
      `this run attempted 0 events — the target may be unreachable, or the ` +
        `connection failed before any event could be sent`,
    );
  }

  const diff = Date.parse(input.ended_at) - Date.parse(input.started_at);
  let duration_sec: number | null = null;
  if (Number.isFinite(diff)) {
    duration_sec = Math.round(diff / 1000);
  } else {
    warnings.push(
      `run duration could not be computed: started_at="${input.started_at}" ended_at="${input.ended_at}"`,
    );
  }

  return {
    schema_version: SCHEMA_VERSION,
    run: {
      run_id: input.run_id,
      started_at: input.started_at,
      ended_at: input.ended_at,
      duration_sec,
      k6_version: input.k6_version,
    },
    resolved_config: input.resolved_config,
    generator: { gen_index: input.gen_index, gen_count: input.gen_count },
    rate: input.rate,
    metrics,
    thresholds,
    validity: {
      dropped_iterations: dropped,
      generator_cpu: null,
      valid: reasons.length === 0,
      reasons,
    },
    payload_sample: input.payload_sample.slice(0, MAX_PAYLOAD_SAMPLE),
    warnings,
  };
}
