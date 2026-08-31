import { describe, it, expect } from 'vitest';
import { buildThresholds, isStructuralThreshold } from '../../src/metrics/thresholds.ts';

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

  it('generates a structural threshold per metric per active type', () => {
    const t = buildThresholds({ abort_on_fail: false, active_types: ['auditd', 'cloudtrail'] });
    expect(t['events_sent{scenario:auditd}']).toEqual(['count>=0']);
    expect(t['events_sent{scenario:cloudtrail}']).toEqual(['count>=0']);
  });

  it('uses rate>=0 for the Rate metric and max>=0 for the Trend', () => {
    // A Trend rejects count>=0 outright — k6 fails at init, not at runtime.
    const t = buildThresholds({ abort_on_fail: false, active_types: ['auditd'] });
    expect(t['send_failures{scenario:auditd}']).toEqual(['rate>=0']);
    expect(t['send_duration{scenario:auditd}']).toEqual(['max>=0']);
  });

  it('generates six structural thresholds per type', () => {
    const t = buildThresholds({ abort_on_fail: false, active_types: ['auditd', 'cloudtrail'] });
    expect(Object.keys(t).filter(isStructuralThreshold)).toHaveLength(12);
  });

  it('classifies a generated threshold as structural and a profile one as not', () => {
    expect(isStructuralThreshold('events_sent{scenario:auditd}')).toBe(true);
    expect(isStructuralThreshold('send_failures')).toBe(false);
  });

  it('does not let a structural threshold overwrite a profile threshold on the same key', () => {
    // If a profile sets a real SLO on a tagged sub-metric, the SLO wins.
    const t = buildThresholds({
      profile_thresholds: { 'send_duration{scenario:auditd}': 'p(99)<250' },
      abort_on_fail: false, active_types: ['auditd'],
    });
    expect(t['send_duration{scenario:auditd}']).toContain('p(99)<250');
  });

  it('still emits the validity thresholds a profile cannot weaken', () => {
    const t = buildThresholds({ abort_on_fail: false, active_types: ['auditd'] });
    expect(t.dropped_iterations).toEqual(['count<1']);
  });
});
