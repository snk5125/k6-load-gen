import { isFleetSummary } from '../fleet/merge.ts';

export interface RunRef {
  run_id: string;
  /** null = the merged FLEET artifact of a single-task fleet run (see
   * src/fleet/merge.ts), which lives beside the per-generator `gen-<i>`
   * directories under its own `fleet` stem so it can never collide with one. */
  gen_index: number | null;
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
  const leaf = ref.gen_index === null ? 'fleet' : `gen-${ref.gen_index}`;
  const stem = ref.gen_index === null ? `${ref.run_id}-fleet` : `${ref.run_id}-gen${ref.gen_index}`;
  const runDir = `${p}runs/${ref.run_id}/${leaf}`;

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
  // Since the profile grew a `types` map (Task 6), `resolved_config.scenario`
  // no longer exists — it is REJECTED at validation (schema.ts's legacy-shape
  // check), so every real run now had this column silently reading as null.
  // Same class of defect as the old flat-map read of `thresholds` (see
  // SCHEMA_VERSION above): a shape changed under a reader that kept the old
  // assumption. `scenario` now lives per type on TypeConfig, so this column
  // becomes a comma-joined list of every declared type's scenario — e.g.
  // "soak,sweep,spike" for mixed-estate.json — rather than a single value
  // that no longer has one unambiguous meaning for a multi-type profile.
  const cfgTypes = (cfg.types ?? {}) as Record<string, { scenario?: unknown }>;
  const scenarios = Object.values(cfgTypes)
    .map((t) => (t && typeof t.scenario === 'string' ? t.scenario : null))
    .filter((s): s is string => s !== null);
  const metrics = (summary.metrics ?? {}) as Record<string, Record<string, number>>;
  const validity = (summary.validity ?? {}) as Record<string, unknown>;
  // Since Task 9, summary.thresholds is { slo: [...], structural_count } —
  // NOT a flat map of every declared threshold. Read the `slo` array only:
  // structural thresholds (src/metrics/thresholds.ts STRUCTURAL_EXPRESSIONS)
  // are trivially-true plumbing that can never fail, so counting them here
  // would not just miss failures, it would make this count meaningless in
  // the OTHER direction too (padding it with entries that never contribute).
  const thresholds = (summary.thresholds ?? {}) as { slo?: Array<{ ok?: boolean }> };
  const slo = Array.isArray(thresholds.slo) ? thresholds.slo : [];

  const failed = slo.filter((t) => t && t.ok === false).length;

  // A fleet summary (src/fleet/merge.ts) has no single generator: its
  // gen_index is null and must STAY null here — `num()` would coerce it to
  // 0 and file the fleet row as generator 0 of its own run.
  const isFleet = isFleetSummary(summary);
  const fleetBlock = (isFleet ? summary.fleet : {}) as Record<string, unknown>;

  return {
    schema_version: typeof summary.schema_version === 'number' ? summary.schema_version : null,
    run_id: (run.run_id as string) ?? null,
    started_at: (run.started_at as string) ?? null,
    ended_at: (run.ended_at as string) ?? null,
    duration_sec: typeof run.duration_sec === 'number' ? run.duration_sec : null,
    k6_version: (run.k6_version as string) ?? null,
    gen_index: isFleet ? null : num(gen.gen_index),
    gen_count: num(gen.gen_count),
    is_fleet: isFleet,
    generator_count: isFleet ? num(fleetBlock.generator_count) : null,
    generators_reported: isFleet ? num(fleetBlock.generators_reported) : null,
    profile: (cfg.name as string) ?? null,
    transport: (target.transport as string) ?? null,
    scenario: scenarios.length > 0 ? scenarios.join(',') : null,
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
