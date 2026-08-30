import type { Overrides } from './resolve.ts';

/**
 * Parses a numeric environment variable.
 *
 * Rejects NaN *and* the infinities: `RATE=Infinity` and `RATE=1e400` both
 * survive `Number()`, then survive the `rate <= 0` check in `resolveRun`, and
 * reach `resolveScenario` — which documents finite positive rates as an
 * upstream-enforced precondition and produces Infinity stage targets and a NaN
 * delta_pct when it is violated. This is where that precondition is enforced.
 *
 * `name` is included in the message so KNEE_EPS=abc and DURATION_SCALE=abc do
 * not produce identical errors.
 */
function num(name: string, v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const parsed = Number(v);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name}: expected a finite number, got "${v}"`);
  }
  return parsed;
}

export function profileName(): string {
  const p = __ENV.PROFILE;
  if (!p) {
    throw new Error('PROFILE is required (e.g. PROFILE=local-null)');
  }
  return p;
}

export function readOverrides(): Overrides {
  return {
    run_id: __ENV.RUN_ID,
    target: __ENV.TARGET,
    scenario: __ENV.SCENARIO,
    knee_eps: num('KNEE_EPS', __ENV.KNEE_EPS),
    rate: num('RATE', __ENV.RATE),
    gen_index: num('GEN_INDEX', __ENV.GEN_INDEX),
    gen_count: num('GEN_COUNT', __ENV.GEN_COUNT),
    duration_scale: num('DURATION_SCALE', __ENV.DURATION_SCALE),
  };
}
