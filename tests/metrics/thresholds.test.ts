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
    // Must call buildThresholds itself: isStructuralThreshold is backed by
    // the most recent call's tracked set, not a name heuristic, so this
    // test cannot rely on state a *previous* test happened to leave behind
    // (that would pass only by luck of test ordering — see the throw added
    // to isStructuralThreshold for what happens when nothing has run yet).
    buildThresholds({ abort_on_fail: false, active_types: ['auditd', 'cloudtrail'] });
    expect(isStructuralThreshold('events_sent{scenario:auditd}')).toBe(true);
    expect(isStructuralThreshold('send_failures')).toBe(false);
  });

  it('does not let a structural threshold overwrite a profile threshold on the same key', () => {
    // If a profile sets a real SLO on a tagged sub-metric, the SLO wins.
    const t = buildThresholds({
      profile_thresholds: { 'send_duration{scenario:auditd}': 'p(99)<250' },
      abort_on_fail: false, active_types: ['auditd'],
    });
    expect(t['send_duration{scenario:auditd}']).toEqual(['p(99)<250']);
    // The whole reason isStructuralThreshold is a tracked set rather than a
    // name heuristic: this key LOOKS structural (metric + {scenario:x}) but
    // its value here is the profile's own SLO, not ours — so it must not be
    // classified as structural, or a later consumer would silently exclude
    // a real SLO from the run's verdict.
    expect(isStructuralThreshold('send_duration{scenario:auditd}')).toBe(false);
  });

  it('still emits the validity thresholds a profile cannot weaken', () => {
    const t = buildThresholds({ abort_on_fail: false, active_types: ['auditd'] });
    expect(t.dropped_iterations).toEqual(['count<1']);
  });
});
