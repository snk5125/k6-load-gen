import { describe, it, expect } from 'vitest';
import { resolveScenario } from '../../src/scenarios/resolve.ts';
import { SHAPES } from '../../src/scenarios/shapes.ts';
import type { ShapeDef } from '../../src/scenarios/shapes.ts';

const flat = (mult: number, sec: number): ShapeDef => ({
  executor: 'ramping-arrival-rate',
  start_mult: mult,
  stages: [{ mult, duration_sec: sec }],
});

const base = {
  batch_size: 100,
  gen_count: 1,
  duration_scale: 1,
};

describe('resolveScenario — anchoring', () => {
  it('multiplies by knee_eps in knee mode', () => {
    const r = resolveScenario({ ...base, shape: flat(2, 60), anchor: { mode: 'knee', knee_eps: 5000 } });
    expect(r.requested_peak_eps).toBe(10000);
    expect((r.k6.stages as any[])[0].target).toBe(100); // 10000 eps / 100 batch
  });

  it('multiplies by base_eps in absolute mode', () => {
    const r = resolveScenario({ ...base, shape: flat(1, 60), anchor: { mode: 'absolute', base_eps: 8000 } });
    expect(r.requested_peak_eps).toBe(8000);
    expect(r.achieved_peak_eps).toBe(8000);
  });
});

describe('resolveScenario — rate rounding (spec 2.2 defect 1)', () => {
  it('reports drift when batch size does not divide evenly', () => {
    const r = resolveScenario({ ...base, shape: flat(1, 60), anchor: { mode: 'absolute', base_eps: 250 } });
    expect(r.requested_peak_eps).toBe(250);
    expect(r.achieved_peak_eps).toBe(300); // round(250/100) = 3 -> 300
    expect(r.delta_pct).toBeCloseTo(20, 5);
    expect(r.warnings.join(' ')).toMatch(/drift/i);
  });

  it('reports no drift and no warning when it divides evenly', () => {
    const r = resolveScenario({ ...base, shape: flat(1, 60), anchor: { mode: 'absolute', base_eps: 5000 } });
    expect(r.achieved_peak_eps).toBe(5000);
    expect(r.delta_pct).toBe(0);
    expect(r.warnings).toEqual([]);
  });

  it('never emits a rate below 1', () => {
    const r = resolveScenario({ ...base, shape: flat(1, 60), anchor: { mode: 'absolute', base_eps: 5 } });
    expect((r.k6.stages as any[])[0].target).toBe(1);
  });

  // The committed otlp-grpc profile: sweep, knee 5000, batch 100. Its
  // PEAK (1.5x -> 7500 eps -> 75 iterations/s) divides evenly, so peak-only
  // drift math reported delta_pct 0 and no warning — while the 0.25x stage
  // (1250 eps -> round(12.5) = 13 iterations/s -> 1300 eps) ran 4.0% hot.
  it('measures drift across every stage, not just the peak (reference sweep profile)', () => {
    const r = resolveScenario({
      ...base,
      shape: SHAPES.sweep,
      anchor: { mode: 'knee', knee_eps: 5000 },
    });

    // The peak itself is exactly on rate, which is why this went unnoticed.
    expect(r.requested_peak_eps).toBe(7500);
    expect(r.achieved_peak_eps).toBe(7500);

    expect(r.delta_pct).toBeCloseTo(4, 5);
    const warning = r.warnings.join(' ');
    expect(warning).toMatch(/drift/i);
    expect(warning).toMatch(/0\.25x stage/);
    expect(warning).toMatch(/requested 1250 eps/);
    expect(warning).toMatch(/achievable 1300 eps/);
  });

  it('reports the largest-magnitude stage drift, not the last or the first', () => {
    const shape: ShapeDef = {
      executor: 'ramping-arrival-rate',
      start_mult: 1,
      stages: [
        { mult: 1, duration_sec: 10 },    // 1000 eps -> 10 -> 1000 eps, 0%
        { mult: 0.25, duration_sec: 10 }, // 250 eps -> round(2.5)=3 -> 300 eps, +20%
        { mult: 0.35, duration_sec: 10 }, // 350 eps -> round(3.5)=4 -> 400 eps, +14.3%
      ],
    };
    const r = resolveScenario({ ...base, shape, anchor: { mode: 'absolute', base_eps: 1000 } });
    expect(r.delta_pct).toBeCloseTo(20, 5);
    expect(r.warnings.join(' ')).toMatch(/0\.25x stage/);
  });

  it('warns when requested rate is zero but achievable rate is non-zero', () => {
    const r = resolveScenario({ ...base, shape: flat(1, 60), anchor: { mode: 'absolute', base_eps: 0 } });
    expect(r.requested_peak_eps).toBe(0);
    expect(r.achieved_peak_eps).toBe(100); // toRate(0) floors to 1, 1 * 100 batch = 100 eps
    expect(r.delta_pct).toBe(0);
    expect(r.warnings.join(' ')).toMatch(/requested rate resolved to 0 eps/i);
  });
});

describe('resolveScenario — fleet and duration scaling', () => {
  it('divides the rate across generators', () => {
    const one = resolveScenario({ ...base, shape: flat(1, 60), anchor: { mode: 'absolute', base_eps: 10000 } });
    const two = resolveScenario({ ...base, gen_count: 2, shape: flat(1, 60), anchor: { mode: 'absolute', base_eps: 10000 } });
    expect((one.k6.stages as any[])[0].target).toBe(100);
    expect((two.k6.stages as any[])[0].target).toBe(50);
  });

  it('scales durations and floors them at 1s', () => {
    const half = resolveScenario({ ...base, duration_scale: 0.5, shape: flat(1, 600), anchor: { mode: 'absolute', base_eps: 1000 } });
    expect((half.k6.stages as any[])[0].duration).toBe('300s');

    const tiny = resolveScenario({ ...base, duration_scale: 0.001, shape: flat(1, 60), anchor: { mode: 'absolute', base_eps: 1000 } });
    expect((tiny.k6.stages as any[])[0].duration).toBe('1s');
  });
});

describe('resolveScenario — executors', () => {
  it('passes shared-iterations through without rate math', () => {
    const r = resolveScenario({ ...base, shape: SHAPES.smoke, anchor: { mode: 'knee', knee_eps: 5000 } });
    expect(r.k6.executor).toBe('shared-iterations');
    expect(r.k6.iterations).toBe(20);
    expect(r.requested_peak_eps).toBe(0);
    expect(r.warnings).toEqual([]);
  });

  it('emits k6 camelCase option keys for ramping-arrival-rate', () => {
    const r = resolveScenario({ ...base, shape: flat(1, 60), anchor: { mode: 'absolute', base_eps: 1000 } });
    expect(r.k6.executor).toBe('ramping-arrival-rate');
    expect(r.k6.timeUnit).toBe('1s');
    expect(r.k6.preAllocatedVUs).toBe(200);
    expect(r.k6.maxVUs).toBe(2000);
    expect(r.k6.startRate).toBe(10);
  });

  it('honours explicit VU overrides', () => {
    const r = resolveScenario({ ...base, shape: flat(1, 60), anchor: { mode: 'absolute', base_eps: 1000 }, pre_allocated_vus: 50, max_vus: 75 });
    expect(r.k6.preAllocatedVUs).toBe(50);
    expect(r.k6.maxVUs).toBe(75);
  });

  it('propagates abort_on_fail from the shape', () => {
    expect(resolveScenario({ ...base, shape: SHAPES.breakpoint, anchor: { mode: 'knee', knee_eps: 1000 } }).abort_on_fail).toBe(true);
    expect(resolveScenario({ ...base, shape: SHAPES.sweep, anchor: { mode: 'knee', knee_eps: 1000 } }).abort_on_fail).toBe(false);
  });
});
