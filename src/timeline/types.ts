export interface K6Sample {
  type: string;
  metric: string;
  data: { time: string; value: number; tags?: Record<string, string> };
}

export interface TimelineBucket {
  bucket_start: string;
  bucket_sec: number;
  events_sent: number;
  events_attempted: number;
  eps: number;
  send_failures: number;
  /** How many send_failures samples `failure_rate` was divided by. Carried
   * so a fleet merge (src/fleet/timeline-merge.ts) can recompute an exact
   * rate across generators instead of averaging rates. */
  send_samples: number;
  failure_rate: number;
  send_duration_p50: number | null;
  send_duration_p95: number | null;
  send_duration_p99: number | null;
  dropped_iterations: number;
}
