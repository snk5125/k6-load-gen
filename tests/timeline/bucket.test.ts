import { describe, it, expect } from 'vitest';
import { bucketSamples, createBucketer, percentile } from '../../src/timeline/bucket.ts';

const sample = (metric: string, time: string, value: number) =>
  JSON.stringify({ type: 'Point', metric, data: { time, value } });

describe('percentile', () => {
  it('returns null for an empty set', () => {
    expect(percentile([], 50)).toBeNull();
  });

  it('returns the only value for a single-element set', () => {
    expect(percentile([7], 99)).toBe(7);
  });

  it('picks the nearest-rank value', () => {
    const s = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(s, 50)).toBe(5);
    expect(percentile(s, 90)).toBe(9);
    expect(percentile(s, 100)).toBe(10);
  });

  it('never returns a value outside the input range', () => {
    const s = [10, 20, 30];
    for (const p of [1, 25, 50, 75, 99, 100]) {
      const v = percentile(s, p)!;
      expect(v).toBeGreaterThanOrEqual(10);
      expect(v).toBeLessThanOrEqual(30);
    }
  });
});

describe('bucketSamples', () => {
  it('returns no buckets for no samples', () => {
    expect(bucketSamples([], 15)).toEqual([]);
  });

  it('groups samples into fixed-width buckets aligned to the bucket size', () => {
    const lines = [
      sample('events_sent', '2026-08-29T10:00:03.000Z', 100),
      sample('events_sent', '2026-08-29T10:00:14.999Z', 100),
      sample('events_sent', '2026-08-29T10:00:15.000Z', 100),
    ];
    const b = bucketSamples(lines, 15);
    expect(b.length).toBe(2);
    expect(b[0].bucket_start).toBe('2026-08-29T10:00:00.000Z');
    expect(b[0].events_sent).toBe(200);
    expect(b[1].bucket_start).toBe('2026-08-29T10:00:15.000Z');
    expect(b[1].events_sent).toBe(100);
  });

  it('computes eps from the bucket width, not the sample count', () => {
    const lines = [sample('events_sent', '2026-08-29T10:00:00.000Z', 1500)];
    expect(bucketSamples(lines, 15)[0].eps).toBe(100);
  });

  it('computes send_duration percentiles within each bucket independently', () => {
    const lines = [
      ...[10, 20, 30, 40, 50].map((v) => sample('send_duration', '2026-08-29T10:00:01.000Z', v)),
      ...[100, 200, 300].map((v) => sample('send_duration', '2026-08-29T10:00:20.000Z', v)),
    ];
    const b = bucketSamples(lines, 15);
    expect(b[0].send_duration_p50).toBe(30);
    expect(b[1].send_duration_p50).toBe(200);
  });

  it('reports null percentiles for a bucket with no duration samples', () => {
    const b = bucketSamples([sample('events_sent', '2026-08-29T10:00:00.000Z', 10)], 15);
    expect(b[0].send_duration_p50).toBeNull();
    expect(b[0].send_duration_p99).toBeNull();
  });

  it('counts send_failures and derives failure_rate against the number of failure samples seen', () => {
    const lines = [
      sample('events_attempted', '2026-08-29T10:00:00.000Z', 100),
      sample('send_failures', '2026-08-29T10:00:00.000Z', 1),
      sample('send_failures', '2026-08-29T10:00:01.000Z', 0),
      sample('send_failures', '2026-08-29T10:00:02.000Z', 1),
    ];
    const b = bucketSamples(lines, 15)[0];
    expect(b.send_failures).toBe(2);
    expect(b.failure_rate).toBeCloseTo(2 / 3, 5);
  });

  it('reports failure_rate 0 when no failure samples were seen', () => {
    const b = bucketSamples([sample('events_sent', '2026-08-29T10:00:00.000Z', 10)], 15)[0];
    expect(b.failure_rate).toBe(0);
  });

  it('carries dropped_iterations, the run-validity signal', () => {
    const b = bucketSamples([sample('dropped_iterations', '2026-08-29T10:00:00.000Z', 3)], 15)[0];
    expect(b.dropped_iterations).toBe(3);
  });

  it('emits buckets in chronological order', () => {
    const lines = [
      sample('events_sent', '2026-08-29T10:00:40.000Z', 1),
      sample('events_sent', '2026-08-29T10:00:10.000Z', 1),
      sample('events_sent', '2026-08-29T10:00:25.000Z', 1),
    ];
    const starts = bucketSamples(lines, 15).map((b) => b.bucket_start);
    expect(starts).toEqual([...starts].sort());
  });

  it('ignores blank lines, non-Point records, and unparseable lines', () => {
    const lines = [
      '',
      '   ',
      JSON.stringify({ type: 'Metric', metric: 'events_sent', data: { name: 'events_sent' } }),
      'not json at all',
      sample('events_sent', '2026-08-29T10:00:00.000Z', 5),
    ];
    const b = bucketSamples(lines, 15);
    expect(b.length).toBe(1);
    expect(b[0].events_sent).toBe(5);
  });

  it('ignores metrics it does not track rather than throwing', () => {
    const lines = [
      sample('http_req_duration', '2026-08-29T10:00:00.000Z', 42),
      sample('events_sent', '2026-08-29T10:00:00.000Z', 5),
    ];
    expect(bucketSamples(lines, 15)[0].events_sent).toBe(5);
  });

  it('records the bucket width it used', () => {
    expect(bucketSamples([sample('events_sent', '2026-08-29T10:00:00.000Z', 1)], 30)[0].bucket_sec).toBe(30);
  });

  it('skips Points with non-numeric values', () => {
    const lines = [
      JSON.stringify({ type: 'Point', metric: 'events_sent', data: { time: '2026-08-29T10:00:00.000Z', value: 'not_a_number' } }),
      sample('events_sent', '2026-08-29T10:00:00.000Z', 5),
    ];
    const b = bucketSamples(lines, 15);
    expect(b[0].events_sent).toBe(5);
  });

  it('skips Points with null send_duration values', () => {
    // send_duration is chosen because null coerces to 0 under += (vacuous test),
    // but here null is pushed into the durations array. Without the guard,
    // null sorts to front and shifts all percentiles. With the guard, it is
    // skipped and percentiles are computed over real samples only.
    const lines = [
      sample('send_duration', '2026-08-29T10:00:00.000Z', 10),
      JSON.stringify({ type: 'Point', metric: 'send_duration', data: { time: '2026-08-29T10:00:00.000Z', value: null } }),
      sample('send_duration', '2026-08-29T10:00:00.000Z', 15),
      sample('send_duration', '2026-08-29T10:00:00.000Z', 20),
    ];
    const b = bucketSamples(lines, 15);
    expect(b[0].send_duration_p50).toBe(15);
  });

  it('skips Points with missing value field', () => {
    const lines = [
      JSON.stringify({ type: 'Point', metric: 'events_sent', data: { time: '2026-08-29T10:00:00.000Z' } }),
      sample('events_sent', '2026-08-29T10:00:00.000Z', 5),
    ];
    const b = bucketSamples(lines, 15);
    expect(b[0].events_sent).toBe(5);
  });

  it('throws for bucket_sec of 0', () => {
    expect(() => bucketSamples([], 0)).toThrow('bucket_sec must be a positive finite number (got 0)');
  });

  it('throws for negative bucket_sec', () => {
    expect(() => bucketSamples([], -5)).toThrow('bucket_sec must be a positive finite number (got -5)');
  });

  it('throws for non-finite bucket_sec', () => {
    expect(() => bucketSamples([], Infinity)).toThrow('bucket_sec must be a positive finite number (got Infinity)');
  });
});

describe('createBucketer', () => {
  it('fed lines one at a time produces identical output to bucketSamples', () => {
    const lines = [
      sample('events_sent', '2026-08-29T10:00:03.000Z', 100),
      sample('events_sent', '2026-08-29T10:00:14.999Z', 100),
      sample('events_sent', '2026-08-29T10:00:15.000Z', 100),
      sample('send_duration', '2026-08-29T10:00:05.000Z', 42),
      sample('send_duration', '2026-08-29T10:00:16.000Z', 50),
    ];

    const expected = bucketSamples(lines, 15);

    const bucketer = createBucketer(15);
    for (const line of lines) {
      bucketer.add(line);
    }
    const actual = bucketer.finish();

    expect(actual).toEqual(expected);
  });

  it('throws with the same message as bucketSamples for bucket_sec of 0', () => {
    expect(() => createBucketer(0)).toThrow('bucket_sec must be a positive finite number (got 0)');
  });

  it('returns an empty array from finish() when no lines are added', () => {
    const bucketer = createBucketer(15);
    expect(bucketer.finish()).toEqual([]);
  });
});

describe('bucketSamples — send_samples (fleet merge denominator)', () => {
  it('reports how many send_failures samples the failure_rate was divided by', () => {
    const lines = [
      sample('send_failures', '2026-08-29T10:00:00.000Z', 1),
      sample('send_failures', '2026-08-29T10:00:01.000Z', 0),
      sample('send_failures', '2026-08-29T10:00:02.000Z', 0),
    ];
    const b = bucketSamples(lines, 15)[0];
    expect(b.send_samples).toBe(3);
    expect(b.failure_rate).toBeCloseTo(1 / 3, 5);
  });

  it('reports 0 send_samples for a bucket with no failure samples', () => {
    const b = bucketSamples([sample('events_sent', '2026-08-29T10:00:00.000Z', 10)], 15)[0];
    expect(b.send_samples).toBe(0);
  });
});
