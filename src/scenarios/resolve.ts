import type { ShapeDef } from './shapes.ts';

export type Anchor =
  | { mode: 'knee'; knee_eps: number }
  | { mode: 'absolute'; base_eps: number };

export interface ResolveInput {
  shape: ShapeDef;
  anchor: Anchor;
  batch_size: number;
  gen_count: number;
  duration_scale: number;
  pre_allocated_vus?: number;
  max_vus?: number;
}

export interface ResolvedScenario {
  /** The k6 scenario object. Uses k6's camelCase keys, not our snake_case. */
  k6: Record<string, unknown>;
  /** Requested EPS at the PEAK stage only. */
  requested_peak_eps: number;
  /** Achievable EPS at the PEAK stage only. */
  achieved_peak_eps: number;
  /**
   * The worst rounding drift across ALL stages, signed, in percent — NOT the
   * drift between the two peak fields above. `toRate` rounds every stage
   * independently, so a shape whose peak divides evenly can still be several
   * percent hot at a lower multiplier (spec §2.2 defect 1). Do not assume
   * delta_pct relates requested_peak_eps to achieved_peak_eps; it frequently
   * describes a different stage entirely.
   */
  delta_pct: number;
  abort_on_fail: boolean;
  warnings: string[];
}

const DRIFT_WARN_PCT = 2;

/**
 * Resolves a load shape into a concrete k6 scenario object.
 *
 * Preconditions (validated upstream; function assumes all are satisfied):
 * - `batch_size >= 1` — validated by Task 6 `validateProfile`
 * - `gen_count >= 1` — validated by Task 7 `resolveRun` (throws ConfigError if not)
 * - `anchor.base_eps > 0` or `anchor.knee_eps > 0` — validated by Task 6 `validateAnchor`
 * - `shape.stages` is non-empty — guaranteed by Task 4's static shape data and Task 5 tests
 *
 * If any precondition is violated upstream, the function may produce NaN or -Infinity
 * in the output fields. A caller seeing unexpected values should check which validator
 * was bypassed.
 */
export function resolveScenario(input: ResolveInput): ResolvedScenario {
  const { shape, anchor, batch_size, gen_count, duration_scale } = input;

  if (shape.executor === 'shared-iterations') {
    return {
      k6: {
        executor: 'shared-iterations',
        iterations: shape.iterations,
        vus: shape.vus,
      },
      requested_peak_eps: 0,
      achieved_peak_eps: 0,
      delta_pct: 0,
      abort_on_fail: false,
      warnings: [],
    };
  }

  const base = anchor.mode === 'knee' ? anchor.knee_eps : anchor.base_eps;

  // Fleet slicing: each generator carries its share of the total offered rate.
  const perGenEps = (mult: number) => (mult * base) / gen_count;

  // k6's arrival rate is ITERATIONS per second; each iteration sends a batch.
  const toRate = (eps: number) => Math.max(1, Math.round(eps / batch_size));

  const scaleDuration = (sec: number) =>
    `${Math.max(1, Math.round(sec * duration_scale))}s`;

  const stages = shape.stages.map((s) => ({
    target: toRate(perGenEps(s.mult)),
    duration: scaleDuration(s.duration_sec),
  }));

  // Fleet-wide EPS actually requested / actually achievable at one multiplier.
  const requestedAt = (mult: number) => perGenEps(mult) * gen_count;
  const achievedAt = (mult: number) => toRate(perGenEps(mult)) * batch_size * gen_count;

  const peakMult = Math.max(...shape.stages.map((s) => s.mult));
  const requested = requestedAt(peakMult);
  const achieved = achievedAt(peakMult);

  // Drift is measured PER STAGE, not at the peak. Each stage's target is rounded
  // independently by toRate, so the peak dividing evenly says nothing about the
  // rest of the shape — e.g. sweep at knee 5000 / batch 100 is exactly on rate at
  // its 1.5x peak but 4% hot at 0.25x. Report the worst stage, or the drift the
  // peak happens to hide stays invisible (spec §2.2 defect 1).
  let worst = { mult: peakMult, requested, achieved, delta: 0 };
  for (const s of shape.stages) {
    const req = requestedAt(s.mult);
    const ach = achievedAt(s.mult);
    const d = req === 0 ? 0 : ((ach - req) / req) * 100;
    if (Math.abs(d) > Math.abs(worst.delta)) {
      worst = { mult: s.mult, requested: req, achieved: ach, delta: d };
    }
  }
  const delta = worst.delta;

  const warnings: string[] = [];

  // Catch the case where requested rate resolves to zero but rounding floors to a non-zero achievable rate.
  // This should not occur with validated inputs (base_eps > 0, multipliers > 0), but if it does,
  // report it explicitly rather than silently offering an unintended rate.
  if (requested === 0 && achieved !== 0) {
    warnings.push(
      `requested rate resolved to 0 eps, but achievable rate is ${achieved} eps. ` +
        `This likely indicates an upstream validation was bypassed.`,
    );
  }

  if (Math.abs(delta) > DRIFT_WARN_PCT) {
    warnings.push(
      `rate drift ${delta.toFixed(1)}% at the ${worst.mult}x stage: ` +
        `requested ${worst.requested} eps, achievable ${worst.achieved} eps ` +
        `(batch_size ${batch_size} does not divide that stage's target rate evenly). ` +
        `This is the worst stage of ${shape.stages.length}; other stages may drift less. ` +
        `Adjust batch_size or the anchor to remove the drift.`,
    );
  }

  const pre = input.pre_allocated_vus ?? 200;
  return {
    k6: {
      executor: 'ramping-arrival-rate',
      timeUnit: '1s',
      startRate: toRate(perGenEps(shape.start_mult)),
      preAllocatedVUs: pre,
      maxVUs: input.max_vus ?? pre * 10,
      stages,
    },
    requested_peak_eps: requested,
    achieved_peak_eps: achieved,
    delta_pct: delta,
    abort_on_fail: shape.abort_on_fail === true,
    warnings,
  };
}
