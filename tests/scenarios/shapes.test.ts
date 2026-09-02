import { describe, it, expect } from 'vitest';
import { SHAPES, SHAPE_NAMES } from '../../src/scenarios/shapes.ts';

describe('SHAPES', () => {
  it('defines exactly the 12 named shapes', () => {
    expect(SHAPE_NAMES.length).toBe(12);
    for (const n of SHAPE_NAMES) expect(SHAPES[n]).toBeDefined();
  });

  it('gives every ramping shape positive multipliers and durations', () => {
    for (const name of SHAPE_NAMES) {
      const s = SHAPES[name];
      if (s.executor !== 'ramping-arrival-rate') continue;
      expect(s.stages.length).toBeGreaterThan(0);
      expect(s.start_mult).toBeGreaterThan(0);
      for (const st of s.stages) {
        expect(st.mult).toBeGreaterThan(0);
        expect(st.duration_sec).toBeGreaterThan(0);
      }
    }
  });

  it('uses shared-iterations for smoke only', () => {
    expect(SHAPES.smoke.executor).toBe('shared-iterations');
    for (const n of SHAPE_NAMES) {
      if (n !== 'smoke') expect(SHAPES[n].executor).toBe('ramping-arrival-rate');
    }
  });

  it('peaks where each shape is documented to peak', () => {
    const peak = (n: typeof SHAPE_NAMES[number]) => {
      const s = SHAPES[n];
      if (s.executor !== 'ramping-arrival-rate') return 0;
      return Math.max(...s.stages.map((x) => x.mult));
    };
    expect(peak('sweep')).toBe(1.5);
    expect(peak('staircase')).toBe(3.0);
    expect(peak('spike')).toBe(4.0);
    expect(peak('plateau')).toBe(2.0);
  });

  it('marks only breakpoint as abort_on_fail', () => {
    for (const n of SHAPE_NAMES) {
      const s = SHAPES[n];
      const flag = s.executor === 'ramping-arrival-rate' ? s.abort_on_fail === true : false;
      expect(flag).toBe(n === 'breakpoint');
    }
  });

  it('makes soak the longest shape', () => {
    const total = (n: typeof SHAPE_NAMES[number]) => {
      const s = SHAPES[n];
      if (s.executor !== 'ramping-arrival-rate') return 0;
      return s.stages.reduce((a, b) => a + b.duration_sec, 0);
    };
    for (const n of SHAPE_NAMES) {
      if (n !== 'soak') expect(total('soak')).toBeGreaterThan(total(n));
    }
  });

  it('gives recovery a trailing near-idle stage so drain is observable', () => {
    const s = SHAPES.recovery;
    if (s.executor !== 'ramping-arrival-rate') throw new Error('expected ramping');
    expect(s.stages[s.stages.length - 1].mult).toBeLessThan(0.2);
  });
});
