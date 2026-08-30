export type ThresholdEntry =
  | string
  | { threshold: string; abortOnFail: true; delayAbortEval: string };

export interface ThresholdInput {
  profile_thresholds?: Record<string, string>;
  abort_on_fail: boolean;
}

/**
 * Non-negotiable. If k6 could not sustain the offered rate, the run measured
 * the generator rather than the aggregator and every number in it is void.
 * A profile cannot weaken these.
 */
export const VALIDITY_THRESHOLDS: Record<string, string[]> = {
  dropped_iterations: ['count<1'],
};

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

  // Applied last so they cannot be overwritten.
  for (const [name, exprs] of Object.entries(VALIDITY_THRESHOLDS)) {
    out[name] = [...exprs];
  }

  return out;
}
