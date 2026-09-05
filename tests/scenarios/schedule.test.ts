import { describe, it, expect } from 'vitest';
import { parseK6DurationSec, scheduleForType } from '../../src/scenarios/schedule.ts';
import { resolveScenario } from '../../src/scenarios/resolve.ts';
import { SHAPES } from '../../src/scenarios/shapes.ts';

describe('parseK6DurationSec', () => {
  it('parses the plain seconds form resolveScenario emits', () => {
    expect(parseK6DurationSec('165s')).toBe(165);
    expect(parseK6DurationSec('1s')).toBe(1);
  });

  it('parses compound and sub-second forms', () => {
    expect(parseK6DurationSec('1m30s')).toBe(90);
    expect(parseK6DurationSec('2h')).toBe(7200);
    expect(parseK6DurationSec('500ms')).toBe(0.5);
  });

  it('throws on a value it cannot read rather than inventing a duration', () => {
    expect(() => parseK6DurationSec('soon')).toThrow(/duration/);
    expect(() => parseK6DurationSec('')).toThrow(/duration/);
  });
});

describe('scheduleForType — ramping-arrival-rate', () => {
  const ctx = { batch_size: 100, gen_count: 4, duration_scale: 1 };

  it('carries the executor, the context and the start rate', () => {
    const k6 = resolveScenario({
      shape: SHAPES.sweep,
      anchor: { mode: 'knee', knee_eps: 5000 },
      batch_size: 100,
      gen_count: 4,
      duration_scale: 1,
    }).k6;
    const s = scheduleForType(k6, ctx);
    expect(s.executor).toBe('ramping-arrival-rate');
    expect(s.batch_size).toBe(100);
    expect(s.gen_count).toBe(4);
    expect(s.duration_scale).toBe(1);
    // start_mult 0.1 -> 0.1 * 5000 / 4 gen = 125 eps -> round(125/100) = 1 it/s
    expect(s.start_rate_per_sec).toBe(1);
    expect(s.iterations).toBeUndefined();
    expect(s.vus).toBeUndefined();
  });

  it('turns every k6 stage into target iterations/s, fleet eps and seconds', () => {
    const k6 = resolveScenario({
      shape: SHAPES.sweep,
      anchor: { mode: 'knee', knee_eps: 5000 },
      batch_size: 100,
      gen_count: 4,
      duration_scale: 1,
    }).k6;
    const s = scheduleForType(k6, ctx);
    // sweep is 7 multipliers x (ramp, hold) = 14 stages.
    expect(s.stages).toHaveLength(14);
    expect(s.stages.map((x) => x.duration_sec)).toEqual([
      15, 165, 15, 165, 15, 165, 15, 165, 15, 165, 15, 165, 15, 165,
    ]);
    // 1.0x: 5000 eps fleet-wide / 4 generators = 1250 eps each / batch 100
    // = 13 iterations/s (rounded), so the fleet offers 13 * 100 * 4 = 5200 eps.
    const oneX = s.stages[8];
    expect(oneX.target_iterations_per_sec).toBe(13);
    expect(oneX.target_eps_fleet).toBe(5200);
    expect(oneX.duration_sec).toBe(15);
    // 1.5x peak: 7500/4 = 1875 / 100 = 19 it/s -> 19 * 100 * 4 = 7600.
    expect(s.stages[13].target_eps_fleet).toBe(7600);
  });

  it('reports the SCALED durations when DURATION_SCALE was applied', () => {
    const k6 = resolveScenario({
      shape: SHAPES.sweep,
      anchor: { mode: 'absolute', base_eps: 1000 },
      batch_size: 10,
      gen_count: 1,
      duration_scale: 0.2,
    }).k6;
    const s = scheduleForType(k6, { batch_size: 10, gen_count: 1, duration_scale: 0.2 });
    expect(s.duration_scale).toBe(0.2);
    // 15s ramp -> 3s, 165s hold -> 33s.
    expect(s.stages[0].duration_sec).toBe(3);
    expect(s.stages[1].duration_sec).toBe(33);
  });
});

describe('scheduleForType — shared-iterations', () => {
  it('records iterations and vus and leaves stages empty', () => {
    const k6 = resolveScenario({
      shape: SHAPES.smoke,
      anchor: { mode: 'absolute', base_eps: 100 },
      batch_size: 5,
      gen_count: 1,
      duration_scale: 1,
    }).k6;
    const s = scheduleForType(k6, { batch_size: 5, gen_count: 1, duration_scale: 1 });
    expect(s.executor).toBe('shared-iterations');
    expect(s.iterations).toBe(20);
    expect(s.vus).toBe(1);
    expect(s.stages).toEqual([]);
    expect(s.start_rate_per_sec).toBeUndefined();
  });
});
