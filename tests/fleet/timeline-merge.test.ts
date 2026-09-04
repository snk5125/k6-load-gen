import { describe, it, expect } from 'vitest';
import { mergeBuckets } from '../../src/fleet/timeline-merge.ts';
import type { TimelineBucket } from '../../src/timeline/types.ts';

const bucket = (start: string, over: Partial<TimelineBucket> = {}): TimelineBucket => ({
  bucket_start: start,
  bucket_sec: 15,
  events_sent: 0,
  events_attempted: 0,
  eps: 0,
  send_failures: 0,
  send_samples: 0,
  failure_rate: 0,
  send_duration_p50: null,
  send_duration_p95: null,
  send_duration_p99: null,
  dropped_iterations: 0,
  ...over,
});

const T0 = '2026-08-29T10:00:00.000Z';
const T1 = '2026-08-29T10:00:15.000Z';

describe('mergeBuckets', () => {
  it('returns no buckets for no inputs', () => {
    expect(mergeBuckets([])).toEqual([]);
    expect(mergeBuckets([[], []])).toEqual([]);
  });

  it('sums counts bucket by bucket and recomputes eps from the width', () => {
    const a = [bucket(T0, { events_sent: 1500, events_attempted: 1500, dropped_iterations: 1 })];
    const b = [bucket(T0, { events_sent: 3000, events_attempted: 3100, dropped_iterations: 2 })];
    const [m] = mergeBuckets([a, b]);
    expect(m.events_sent).toBe(4500);
    expect(m.events_attempted).toBe(4600);
    expect(m.dropped_iterations).toBe(3);
    expect(m.eps).toBe(300);
    expect(m.bucket_sec).toBe(15);
  });

  it('recomputes failure_rate from summed failures and samples, not from averaged rates', () => {
    // gen A: 1 failure in 1 sample (100%); gen B: 0 in 9 (0%). Fleet: 1/10 = 10%, not 50%.
    const a = [bucket(T0, { send_failures: 1, send_samples: 1, failure_rate: 1 })];
    const b = [bucket(T0, { send_failures: 0, send_samples: 9, failure_rate: 0 })];
    const [m] = mergeBuckets([a, b]);
    expect(m.send_failures).toBe(1);
    expect(m.send_samples).toBe(10);
    expect(m.failure_rate).toBeCloseTo(0.1, 6);
  });

  it('reports failure_rate 0 when no generator saw a failure sample', () => {
    expect(mergeBuckets([[bucket(T0)], [bucket(T0)]])[0].failure_rate).toBe(0);
  });

  it('takes the worst (max) percentile across generators, ignoring nulls', () => {
    const a = [bucket(T0, { send_duration_p50: 10, send_duration_p95: 40, send_duration_p99: null })];
    const b = [bucket(T0, { send_duration_p50: 12, send_duration_p95: 35, send_duration_p99: 90 })];
    const [m] = mergeBuckets([a, b]);
    expect(m.send_duration_p50).toBe(12);
    expect(m.send_duration_p95).toBe(40);
    expect(m.send_duration_p99).toBe(90);
  });

  it('keeps a percentile null when every generator has it null', () => {
    expect(mergeBuckets([[bucket(T0)], [bucket(T0)]])[0].send_duration_p99).toBeNull();
  });

  it('keeps buckets only one generator produced, in chronological order', () => {
    const a = [bucket(T1, { events_sent: 5 })];
    const b = [bucket(T0, { events_sent: 7 })];
    const m = mergeBuckets([a, b]);
    expect(m.map((x) => x.bucket_start)).toEqual([T0, T1]);
    expect(m.map((x) => x.events_sent)).toEqual([7, 5]);
  });

  it('rejects generators bucketed at different widths', () => {
    const a = [bucket(T0)];
    const b = [bucket(T0, { bucket_sec: 30 })];
    expect(() => mergeBuckets([a, b])).toThrow(/bucket_sec/);
  });
});
