export type ThresholdEntry =
  | string
  | { threshold: string; abortOnFail: true; delayAbortEval: string };

export interface ThresholdInput {
  profile_thresholds?: Record<string, string>;
  abort_on_fail: boolean;
  /** Which log types run this invocation — see Task 6 `resolveRun.active_types`.
   * One structural threshold per STRUCTURAL_EXPRESSIONS entry is generated for
   * each of these, tagged `{scenario:<type>}`. Optional and defaults to no
   * types (no structural thresholds) so callers that only care about
   * profile/validity thresholds are unaffected. */
  active_types?: string[];
}

/**
 * Non-negotiable. If k6 could not sustain the offered rate, the run measured
 * the generator rather than the aggregator and every number in it is void.
 * A profile cannot weaken these.
 */
export const VALIDITY_THRESHOLDS: Record<string, string[]> = {
  dropped_iterations: ['count<1'],
};

/**
 * Plumbing, not SLOs. k6 only exposes a tagged sub-metric (e.g.
 * `events_sent{scenario:auditd}`) to `handleSummary` when a threshold is
 * declared on it — measured against this project's k6 binary: declaring
 * thresholds on `events_sent{scenario:auditd}` and `{scenario:cloudtrail}`
 * made `handleSummary` receive both sub-metrics plus the aggregate (500, 21,
 * 521 — exactly 5x100 and 3x7); without them only the aggregate appeared.
 * These trivially-true expressions exist solely to force that sub-metric
 * split so a later per-type summary can read real numbers, not to gate a
 * run's pass/fail verdict.
 *
 * The expression differs by k6 metric type; using the wrong one is a hard
 * init error, also measured:
 *   invalid threshold "count>=0" applied on metric t_trend; reason:
 *   unsupported aggregation method count on metric of type trend. supported
 *   aggregation methods for this metric are: avg, min, max, med, p
 */
export const STRUCTURAL_EXPRESSIONS: Record<string, string> = {
  events_attempted: 'count>=0',
  events_sent: 'count>=0',
  wire_bytes: 'count>=0',
  send_errors: 'count>=0',
  send_failures: 'rate>=0',
  send_duration: 'max>=0',
};

/**
 * Which keys the MOST RECENT `buildThresholds` call generated structurally
 * (i.e. actually populated with a STRUCTURAL_EXPRESSIONS value — not a key a
 * profile threshold happened to override on the same tagged name). Reset on
 * every call rather than accumulated, so it always reflects the run
 * currently in scope.
 *
 * This is deliberately an explicitly-tracked Set, not a name-matching
 * heuristic (e.g. "does this key look like `<structural metric>{scenario:x}`?").
 * A heuristic would misclassify a profile's own tagged SLO — e.g.
 * `send_duration{scenario:auditd}: p(99)<250` — as structural purely by
 * shape, and a consumer (Task 9's summary) that uses this to exclude
 * structural plumbing from the run's verdict would then silently drop a real
 * SLO. Tracking the actual generated-and-used keys avoids that: a key a
 * profile overrides is never added here, because its value at that key is no
 * longer ours.
 *
 * Safe under k6's re-evaluation semantics: `buildThresholds` is called
 * exactly once per module evaluation (once in the live init runtime, once
 * again in the fresh runtime k6 constructs to run `handleSummary`, which
 * re-executes this module top to bottom before invoking the handler) — so by
 * the time a consumer reads `isStructuralThreshold`, this set already
 * reflects that same call.
 *
 * Contract for callers (e.g. Task 9's summary, which reads
 * `summary.thresholds`): pass the bare tagged metric name — the same shape
 * `buildThresholds` generates as a key, e.g. `send_duration{scenario:auditd}`
 * — NOT the composite `metric:expression` string `summary.thresholds` itself
 * is keyed by (see `src/summary/build.ts`, `thresholds[`${name}:${expression}`]
 * = { ok, metric: name, expression }`). Pass `entry.metric`, not the map key.
 */
let structuralKeys: Set<string> | null = null;

export function isStructuralThreshold(name: string): boolean {
  if (structuralKeys === null) {
    // A silent wrong answer here is the worst failure mode this function
    // has: every consultation would read as "not structural", so all 18
    // structural keys would be misclassified as real SLOs and pollute the
    // run's verdict without any visible symptom. Fail loudly instead — this
    // only happens if something consults isStructuralThreshold before
    // buildThresholds has run at least once in this runtime (e.g. from
    // another module's top-level code that happens to evaluate first).
    throw new Error(
      'isStructuralThreshold() called before buildThresholds() has run in this runtime; ' +
        'the structural-key set is populated as a side effect of that call, so nothing has ' +
        'classified any threshold yet',
    );
  }
  return structuralKeys.has(name);
}

const ABORT_DELAY = '30s';

export function buildThresholds(input: ThresholdInput): Record<string, ThresholdEntry[]> {
  const out: Record<string, ThresholdEntry[]> = {};

  for (const [name, expr] of Object.entries(input.profile_thresholds ?? {})) {
    // Belt-and-suspenders: skip any validity threshold here. The final loop (below)
    // unconditionally overwrites them anyway, so reordering that loop would still
    // guarantee the invariant. Keep this skip to make that guarantee explicit: a
    // profile *entry* is rejected, not merely shadowed.
    if (name in VALIDITY_THRESHOLDS) continue;
    out[name] = [
      input.abort_on_fail
        ? { threshold: expr, abortOnFail: true, delayAbortEval: ABORT_DELAY }
        : expr,
    ];
  }

  // One structural threshold per metric per active type — see
  // STRUCTURAL_EXPRESSIONS. A profile threshold already occupying this exact
  // tagged key wins (real SLO beats plumbing); such a key is left out of
  // generatedKeys so isStructuralThreshold does not misclassify it.
  const generatedKeys = new Set<string>();
  for (const type of input.active_types ?? []) {
    for (const [metric, expr] of Object.entries(STRUCTURAL_EXPRESSIONS)) {
      const key = `${metric}{scenario:${type}}`;
      if (key in out) continue;
      out[key] = [expr];
      generatedKeys.add(key);
    }
  }
  structuralKeys = generatedKeys;

  // Applied last so they cannot be overwritten.
  for (const [name, exprs] of Object.entries(VALIDITY_THRESHOLDS)) {
    out[name] = [...exprs];
  }

  return out;
}
