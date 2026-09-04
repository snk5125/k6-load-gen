import type { TimelineBucket } from '../timeline/types.ts';
import { maxNullable } from './nullable.ts';

/**
 * Sums N generators' timelines bucket by bucket into one fleet timeline.
 *
 * Buckets are keyed on `bucket_start`: every generator floors sample times
 * to the same epoch-aligned width (src/timeline/bucket.ts), so generators
 * of one run share bucket boundaries exactly. Counts are summed; `eps` is
 * recomputed from the summed count and the width; `failure_rate` is
 * recomputed from summed failures over summed samples (never averaged —
 * a generator with one failed sample must not count as much as one with
 * nine thousand clean ones); percentiles are the worst (max) non-null
 * value across generators, an upper bound rather than a true fleet
 * percentile, since the per-generator samples are gone by this point.
 */
export function mergeBuckets(inputs: TimelineBucket[][]): TimelineBucket[] {
  const merged = new Map<string, TimelineBucket>();
  let width: number | null = null;

  for (const buckets of inputs) {
    for (const b of buckets) {
      if (width === null) width = b.bucket_sec;
      if (b.bucket_sec !== width) {
        throw new Error(
          `cannot merge timelines bucketed at different widths: bucket_sec ${width} vs ${b.bucket_sec}`,
        );
      }
      const acc = merged.get(b.bucket_start);
      if (!acc) {
        merged.set(b.bucket_start, { ...b });
        continue;
      }
      acc.events_sent += b.events_sent;
      acc.events_attempted += b.events_attempted;
      acc.send_failures += b.send_failures;
      acc.send_samples += b.send_samples;
      acc.dropped_iterations += b.dropped_iterations;
      acc.send_duration_p50 = maxNullable([acc.send_duration_p50, b.send_duration_p50]);
      acc.send_duration_p95 = maxNullable([acc.send_duration_p95, b.send_duration_p95]);
      acc.send_duration_p99 = maxNullable([acc.send_duration_p99, b.send_duration_p99]);
    }
  }

  return [...merged.values()]
    .sort((a, b) => Date.parse(a.bucket_start) - Date.parse(b.bucket_start))
    .map((b) => ({
      ...b,
      eps: b.events_sent / b.bucket_sec,
      failure_rate: b.send_samples === 0 ? 0 : b.send_failures / b.send_samples,
    }));
}
