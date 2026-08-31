import { VALIDITY_THRESHOLDS, STRUCTURAL_EXPRESSIONS, isStructuralThreshold } from '../metrics/thresholds.ts';

// Bumped from 1: `thresholds` changed shape from a flat map of every
// declared threshold to `{ slo: [...], structural_count }`, and `run` grew
// `active_types`, and this summary grew `types` (the per-type breakdown).
// A consumer written for schema_version 1 that reads `thresholds` as a flat
// map (e.g. `Object.values(thresholds)`) silently computes garbage against
// the new shape rather than erroring — indexRecord (src/storage/keys.ts)
// was exactly that consumer, and did exactly that, until it was fixed to
// read `thresholds.slo`. The version bump lets any OTHER such consumer
// detect the break instead of silently misreading the new shape.
export const SCHEMA_VERSION = 2;
// Exported so a multi-type caller (src/main.ts) can divide this budget
// across active types instead of letting one type's batch fill it entirely.
export const MAX_PAYLOAD_SAMPLE = 10;

/**
 * A sub-metric key k6 produces once a threshold is declared on the tagged
 * form of a metric — e.g. `events_sent{scenario:auditd}` — is the base
 * metric name k6 registered (`events_sent`), followed by a literal
 * `{scenario:<type>}` tag. Parsed in exactly this one place; every call
 * site that needs to know whether a metric name is per-type, and which
 * type, goes through `parseSubMetricKey` rather than re-deriving the shape.
 */
const SUB_METRIC_KEY_RE = /^(?<metric>[^{]+)\{scenario:(?<type>[^}]+)\}$/;

function parseSubMetricKey(name: string): { metric: string; type: string } | null {
  const m = SUB_METRIC_KEY_RE.exec(name);
  if (!m || !m.groups) return null;
  return { metric: m.groups.metric, type: m.groups.type };
}

/**
 * The inverse of `parseSubMetricKey`: builds a tagged sub-metric key from a
 * metric name and a type. Kept next to `SUB_METRIC_KEY_RE` so the
 * `{scenario:<type>}` shape has exactly one source of truth in the whole
 * codebase — a change to the tag format only ever needs updating here and
 * in the regex above, not at each call site that currently needs a tagged
 * key. Exported (rather than re-derived) because src/metrics/thresholds.ts
 * — the module that GENERATES these keys — and any test that needs to
 * build one both used to hand-roll the same template string separately;
 * this is the single source both now go through instead.
 */
export function formatSubMetricKey(metric: string, type: string): string {
  return `${metric}{scenario:${type}}`;
}

/**
 * Per-type breakdown, one field per STRUCTURAL_EXPRESSIONS metric (the same
 * six metrics whose tagged sub-metric a structural threshold forces into
 * `handleSummary` in the first place — see src/metrics/thresholds.ts).
 *
 * `null` means "not measured": no `{scenario:<type>}` sub-metric reached
 * this summary for that metric at all — e.g. a `TYPES=auditd` run against a
 * three-type profile has no `events_sent{scenario:cloudtrail}` key
 * whatsoever. `0` means "measured as none" — an idle scenario's sub-metric
 * IS present, just with zero values. Conflating the two is the same defect
 * `wire_bytes: number | null` (src/transports/types.ts) exists to prevent.
 */
export interface TypeSummary {
  events_attempted: number | null;
  events_sent: number | null;
  send_failures: number | null;
  send_duration: Record<string, number> | null;
  wire_bytes: number | null;
  send_errors: number | null;
}

export interface RunSummary {
  schema_version: number;
  run: {
    run_id: string;
    started_at: string;
    ended_at: string;
    duration_sec: number | null;
    k6_version: string;
    /** Which of the profile's declared types actually ran this invocation —
     * see resolveRun.active_types. Distinguishes a TYPES=-subsetted run from
     * a full one when resolved_config still lists every declared type. */
    active_types: string[];
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
  /** Per active type, the same six metrics broken out from their tagged
   * sub-metrics. Empty when no active_types were supplied. */
  types: Record<string, TypeSummary>;
  thresholds: {
    /** Real SLO/validity verdicts — never includes the never-failing
     * structural thresholds a multi-type run generates just to force
     * sub-metrics into this summary (see STRUCTURAL_EXPRESSIONS). */
    slo: Array<{ ok: boolean; metric: string; expression: string }>;
    /** Count only — eighteen never-failing plumbing thresholds would
     * otherwise swamp this block and obscure the exit-99 gate. */
    structural_count: number;
  };
  /** The expressions that actually determine this run's pass/fail verdict —
   * i.e. every `slo` threshold's expression, and none of the structural
   * ones. Purely informational; k6's own exit code is what actually gates. */
  verdict_from: string[];
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
  /** Which log types ran this invocation. Optional and defaults to none, so
   * a single-type/legacy caller sees an empty per-type breakdown rather than
   * being forced to pass this. See resolveRun.active_types. */
  active_types?: string[];
}

interface K6Metric {
  values?: Record<string, number>;
  thresholds?: Record<string, { ok: boolean }>;
}

// Which top-level metrics values field is the "the number" for a metric of
// that k6 type — count for a Counter, rate for a Rate. Trend metrics (only
// send_duration) have no single scalar, so they are left out here and the
// per-type breakdown carries their full values object instead.
const SCALAR_FIELD: Partial<Record<string, 'count' | 'rate'>> = {
  events_attempted: 'count',
  events_sent: 'count',
  wire_bytes: 'count',
  send_errors: 'count',
  send_failures: 'rate',
};

function buildTypeSummary(metrics: Record<string, unknown>, type: string): TypeSummary {
  const out = {} as Record<string, number | Record<string, number> | null>;
  for (const metric of Object.keys(STRUCTURAL_EXPRESSIONS)) {
    const raw = metrics[formatSubMetricKey(metric, type)] as K6Metric | undefined;
    if (!raw || !raw.values) {
      out[metric] = null;
      continue;
    }
    const scalarKey = SCALAR_FIELD[metric];
    // wire_bytes is special: main.ts only ever calls wireBytes.add() with a
    // non-null, positive byte count (see the res.wire_bytes !== null guard),
    // so this Counter can only ever be incremented by a real observation. A
    // structural threshold (STRUCTURAL_EXPRESSIONS) still materialises the
    // tagged sub-metric even when every send on this type returned
    // wire_bytes: null (otlp-grpc always does; hec does under gzip:true) —
    // it then arrives here PRESENT with count: 0, which looks exactly like
    // "measured as none" but actually means "never observable this run".
    // count === 0 for this one metric can only mean the latter, so report it
    // as null rather than let a real multi-megabyte transfer publish 0 — the
    // exact substitution the `wire_bytes: number | null` contract (see
    // src/transports/types.ts) exists to prevent.
    out[metric] =
      metric === 'wire_bytes' && raw.values.count === 0
        ? null
        : scalarKey
          ? (raw.values[scalarKey] ?? null)
          : { ...raw.values };
  }
  return out as unknown as TypeSummary;
}

export function buildSummary(input: BuildSummaryInput): RunSummary {
  const metrics: Record<string, Record<string, number>> = {};
  const slo: RunSummary['thresholds']['slo'] = [];
  let structuralCount = 0;
  const reasons: string[] = [];
  const warnings = [...input.warnings];

  for (const name of Object.keys(input.metrics)) {
    const m = input.metrics[name] as K6Metric;
    if (m && m.values) metrics[name] = { ...m.values };
    if (m && m.thresholds) {
      for (const expression of Object.keys(m.thresholds)) {
        const ok = m.thresholds[expression].ok === true;
        // Only a TAGGED sub-metric name can ever be structural (see
        // STRUCTURAL_EXPRESSIONS: every generated key is `<metric>{scenario:<type>}`),
        // so an untagged name is always an SLO and never needs to consult
        // isStructuralThreshold — which matters because that guard throws
        // if buildThresholds hasn't run yet in this runtime, and a plain
        // profile/validity threshold must not depend on that having happened.
        const tagged = parseSubMetricKey(name) !== null;
        if (tagged && isStructuralThreshold(name)) {
          structuralCount++;
          continue;
        }
        slo.push({ ok, metric: name, expression });
        // Only VALIDITY thresholds (spec §8.2: always-on, not profile-configurable)
        // bear on whether the run's numbers mean anything. An SLO threshold from
        // the profile is the *measurement*, not a defect in it: a `breakpoint` run
        // exists to break one, and a `sweep` past the knee fails `send_failures` by
        // construction. Folding those into `reasons` marks every such run INVALID
        // and trains readers to ignore the flag. Failed SLO thresholds stay fully
        // visible in `summary.thresholds.slo` and in the rendered output.
        if (!ok && name in VALIDITY_THRESHOLDS) {
          reasons.push(`validity threshold failed: ${name} ${expression}`);
        }
      }
    }
  }

  const activeTypes = input.active_types ?? [];
  const types: Record<string, TypeSummary> = {};
  for (const type of activeTypes) {
    types[type] = buildTypeSummary(input.metrics, type);
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
      active_types: activeTypes,
    },
    resolved_config: input.resolved_config,
    generator: { gen_index: input.gen_index, gen_count: input.gen_count },
    rate: input.rate,
    metrics,
    types,
    thresholds: { slo, structural_count: structuralCount },
    verdict_from: slo.map((t) => t.expression),
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
