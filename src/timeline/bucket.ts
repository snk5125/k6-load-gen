import type { K6Sample, TimelineBucket } from './types.ts';

/** Nearest-rank percentile. Returns null for an empty set rather than a fabricated 0. */
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx];
}

interface Acc {
  events_sent: number;
  events_attempted: number;
  send_failures: number;
  failure_samples: number;
  dropped_iterations: number;
  durations: number[];
}

const emptyAcc = (): Acc => ({
  events_sent: 0,
  events_attempted: 0,
  send_failures: 0,
  failure_samples: 0,
  dropped_iterations: 0,
  durations: [],
});

/** Incremental bucketer for streaming memory-efficient processing of sample lines. */
export interface Bucketer {
  /** Process one line. Skips invalid, malformed, or non-Point samples silently. */
  add(line: string): void;
  /** Return all accumulated buckets, sorted by time. */
  finish(): TimelineBucket[];
}

/**
 * Create an incremental bucketer for memory-efficient streaming.
 * Validates bucket_sec exactly as bucketSamples does.
 */
export function createBucketer(bucket_sec: number): Bucketer {
  if (!Number.isFinite(bucket_sec) || bucket_sec <= 0) {
    throw new Error(`bucket_sec must be a positive finite number (got ${bucket_sec})`);
  }

  const width = bucket_sec * 1000;
  const buckets = new Map<number, Acc>();

  return {
    add(line: string): void {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;

      let s: K6Sample;
      try {
        s = JSON.parse(trimmed) as K6Sample;
      } catch {
        return; // a truncated or non-JSON line must not abort the whole run's timeline
      }
      if (s.type !== 'Point' || !s.data || typeof s.data.time !== 'string') return;

      const ms = Date.parse(s.data.time);
      if (!Number.isFinite(ms)) return;

      // A truncated line may have a missing, null, or non-numeric value.
      // Skip it rather than accumulating NaN or concatenating strings.
      if (typeof s.data.value !== 'number' || !Number.isFinite(s.data.value)) return;

      const key = Math.floor(ms / width) * width;
      let acc = buckets.get(key);
      if (!acc) {
        acc = emptyAcc();
        buckets.set(key, acc);
      }

      switch (s.metric) {
        case 'events_sent':
          acc.events_sent += s.data.value;
          break;
        case 'events_attempted':
          acc.events_attempted += s.data.value;
          break;
        case 'send_failures':
          acc.failure_samples += 1;
          if (s.data.value > 0) acc.send_failures += 1;
          break;
        case 'send_duration':
          acc.durations.push(s.data.value);
          break;
        case 'dropped_iterations':
          acc.dropped_iterations += s.data.value;
          break;
        default:
          break; // untracked metric — not an error
      }
    },

    finish(): TimelineBucket[] {
      return [...buckets.keys()]
        .sort((a, b) => a - b)
        .map((key) => {
          const acc = buckets.get(key)!;
          const sorted = acc.durations.slice().sort((a, b) => a - b);
          return {
            bucket_start: new Date(key).toISOString(),
            bucket_sec,
            events_sent: acc.events_sent,
            events_attempted: acc.events_attempted,
            eps: acc.events_sent / bucket_sec,
            send_failures: acc.send_failures,
            send_samples: acc.failure_samples,
            failure_rate: acc.failure_samples === 0 ? 0 : acc.send_failures / acc.failure_samples,
            send_duration_p50: percentile(sorted, 50),
            send_duration_p95: percentile(sorted, 95),
            send_duration_p99: percentile(sorted, 99),
            dropped_iterations: acc.dropped_iterations,
          };
        });
    },
  };
}

export function bucketSamples(
  lines: Iterable<string>,
  bucket_sec: number,
): TimelineBucket[] {
  const b = createBucketer(bucket_sec);
  for (const line of lines) b.add(line);
  return b.finish();
}
