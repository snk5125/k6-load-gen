export interface RunRef {
  run_id: string;
  gen_index: number;
  started_at: string;
}

export interface ArtifactKeys {
  index: string;
  timeline: string;
  summary: string;
  run_log: string;
  raw: string;
}

/**
 * UTC date of started_at. The ONLY partition key: profile and scenario are
 * columns, because they change over time and would fragment the prefix.
 * Anchoring on the START date keeps a midnight-spanning run whole.
 */
export function partitionDate(started_at: string): string {
  const ms = Date.parse(started_at);
  if (!Number.isFinite(ms)) {
    throw new Error(`started_at is not a parseable timestamp: ${JSON.stringify(started_at)}`);
  }
  return new Date(ms).toISOString().slice(0, 10);
}

function normalisePrefix(prefix: string): string {
  const trimmed = prefix.replace(/^\/+|\/+$/g, '');
  return trimmed.length === 0 ? '' : trimmed + '/';
}

// Conservative allowlist, not a denylist: run_id flows into an S3 key AND
// (via index-cli, invoked from bin/run.sh) into text that used to be
// sourced by a POSIX shell. A denylist of "dangerous" characters is exactly
// the kind of check that misses one metacharacter class and reopens the
// hole; this allowlist rejects everything but what run ids in this project
// actually look like ("smoke-1", "sweep-2.1a", "wrap-fail"), which also
// happens to reject "/" and whitespace, subsuming the two checks this
// replaced.
const RUN_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export function artifactKeys(ref: RunRef, prefix: string): ArtifactKeys {
  if (!RUN_ID_PATTERN.test(ref.run_id)) {
    throw new Error(
      `run_id must contain only letters, digits, "-", "_", or "." : ${JSON.stringify(ref.run_id)}`,
    );
  }
  const p = normalisePrefix(prefix);
  const dt = partitionDate(ref.started_at);
  const stem = `${ref.run_id}-gen${ref.gen_index}`;
  const runDir = `${p}runs/${ref.run_id}/gen-${ref.gen_index}`;

  return {
    // Partitioned, one flat record per line -> future Athena tables.
    index: `${p}index/dt=${dt}/${stem}.json`,
    timeline: `${p}timeline/dt=${dt}/${stem}.jsonl`,
    // Fetched by key, never scanned -> nested JSON is fine.
    summary: `${runDir}/summary.json`,
    run_log: `${runDir}/run.log`,
    raw: `${runDir}/raw.json.gz`,
  };
}

type Scalar = string | number | boolean | null;

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * One flat line per run. This is the table an operator (or an LLM) scans to
 * FIND runs; the full nested summary is then fetched by key for detail.
 */
export function indexRecord(summary: Record<string, unknown>): Record<string, Scalar> {
  const run = (summary.run ?? {}) as Record<string, unknown>;
  const gen = (summary.generator ?? {}) as Record<string, unknown>;
  const rate = (summary.rate ?? {}) as Record<string, unknown>;
  const cfg = (summary.resolved_config ?? {}) as Record<string, unknown>;
  const target = (cfg.target ?? {}) as Record<string, unknown>;
  const metrics = (summary.metrics ?? {}) as Record<string, Record<string, number>>;
  const validity = (summary.validity ?? {}) as Record<string, unknown>;
  const thresholds = (summary.thresholds ?? {}) as Record<string, { ok?: boolean }>;

  const failed = Object.values(thresholds).filter((t) => t && t.ok === false).length;

  return {
    schema_version: typeof summary.schema_version === 'number' ? summary.schema_version : null,
    run_id: (run.run_id as string) ?? null,
    started_at: (run.started_at as string) ?? null,
    ended_at: (run.ended_at as string) ?? null,
    duration_sec: typeof run.duration_sec === 'number' ? run.duration_sec : null,
    k6_version: (run.k6_version as string) ?? null,
    gen_index: num(gen.gen_index),
    gen_count: num(gen.gen_count),
    profile: (cfg.name as string) ?? null,
    transport: (target.transport as string) ?? null,
    scenario: (cfg.scenario as string) ?? null,
    requested_eps: num(rate.requested_eps),
    achieved_eps: num(rate.achieved_eps),
    delta_pct: num(rate.delta_pct),
    events_attempted: num(metrics.events_attempted?.count),
    events_sent: num(metrics.events_sent?.count),
    send_failure_rate: num(metrics.send_failures?.rate),
    dropped_iterations: num(validity.dropped_iterations),
    thresholds_failed: failed,
    valid: typeof validity.valid === 'boolean' ? validity.valid : null,
  };
}
