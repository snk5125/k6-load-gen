import { describe, it, expect } from 'vitest';
import { buildThresholds } from '../../src/metrics/thresholds.ts';

describe('buildThresholds', () => {
  it('always applies the dropped_iterations validity threshold', () => {
    const t = buildThresholds({ abort_on_fail: false });
    expect(t.dropped_iterations).toEqual(['count<1']);
  });

  it('refuses to let a profile weaken a validity threshold', () => {
    const t = buildThresholds({
      profile_thresholds: { dropped_iterations: 'count<999999' },
      abort_on_fail: false,
    });
    expect(t.dropped_iterations).toEqual(['count<1']);
  });

  it('passes profile thresholds through as plain expressions', () => {
    const t = buildThresholds({
      profile_thresholds: { send_failures: 'rate<0.001', send_duration: 'p(99)<250' },
      abort_on_fail: false,
    });
    expect(t.send_failures).toEqual(['rate<0.001']);
    expect(t.send_duration).toEqual(['p(99)<250']);
  });

  it('wraps profile thresholds for abort when the shape requests it', () => {
    const t = buildThresholds({
      profile_thresholds: { send_failures: 'rate<0.001' },
      abort_on_fail: true,
    });
    expect(t.send_failures).toEqual([
      { threshold: 'rate<0.001', abortOnFail: true, delayAbortEval: '30s' },
    ]);
  });

  it('leaves validity thresholds unwrapped even when aborting', () => {
    const t = buildThresholds({ profile_thresholds: {}, abort_on_fail: true });
    expect(t.dropped_iterations).toEqual(['count<1']);
  });

  it('handles an absent profile thresholds map', () => {
    expect(Object.keys(buildThresholds({ abort_on_fail: false }))).toEqual(['dropped_iterations']);
  });
});
