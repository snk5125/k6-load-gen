import { MAX_PAYLOAD_SAMPLE, type RunSummary, type TypeSummary } from '../summary/build.ts';
import { maxNullable } from './nullable.ts';

/**
 * Merges N single-generator summaries (one per k6 process of a single-task
 * fleet — see bin/run.sh) into ONE fleet summary.
 *
 * Shape: schema_version stays 2. Every schema-2 field keeps its shape and
 * meaning; the only additions are `generator.gen_index: null` and the
 * `fleet` block, so a schema-2 reader that looks at counts, thresholds or
 * validity reads the fleet exactly as it would read one generator. A
 * consumer that needs to tell the two apart checks `'fleet' in summary`
 * (src/storage/keys.ts's indexRecord does, to keep gen_index null).
 *
 * Aggregation rules — the non-obvious ones are also written into
 * `fleet.aggregation` so the artifact explains itself:
 *  - counts (`count`, `passes`, `fails`, per-type totals) are SUMMED;
 *  - `rate.*` (requested/achieved eps, drift) is already fleet-wide on every
 *    generator (src/scenarios/resolve.ts multiplies the per-generator share
 *    back up) and is TAKEN from one generator, never summed;
 *  - a Rate metric's `rate` is recomputed as Σpasses / (Σpasses + Σfails). For a
 *    k6 Rate, `passes` counts NON-ZERO samples and `fails` counts ZERO samples
 *    (verified live against this project's k6 v2.2.0 — see
 *    tests/fleet/fixtures/k6-rate-metric.json). send_failures is fed
 *    `add(!res.ok)` (src/main.ts), so `passes` there counts FAILED sends and
 *    `fails` counts successful sends — the metric name is the opposite of
 *    what `passes` means;
 *  - trend stats (`avg`, `med`, `p(..)`) are the WORST generator (max) — an
 *    upper bound, not a true fleet percentile, because the samples behind
 *    them are gone by the time a summary exists; `min` is min, `max` is max;
 *  - thresholds: ok only if ok on every generator that reported them;
 *  - validity: AND over reporting generators AND every generator reported.
 *
 * Identity — the merge also decides whether these summaries are one fleet:
 *  - HARD (throws, nothing is written): a run_id or schema_version
 *    disagreement, a summary whose `generator.gen_index` is not its directory
 *    index, a duplicate index, an index outside the fleet. Any of those means
 *    the inputs are not N members of one run, so merging them would invent a
 *    measurement that never happened;
 *  - SOFT (validity.valid = false with a "fleet members disagree on
 *    configuration" reason, evidence still merged): generator.gen_count,
 *    run.active_types or resolved_config disagreement. The fleet ran and its
 *    numbers are real, they just do not describe one configuration.
 *    resolved_config is compared canonically (stableStringify), so key order
 *    never counts as a difference;
 *  - WARNINGS only: k6_version, rate and thresholds.structural_count.
 */
export interface GeneratorInput {
  gen_index: number;
  /** The k6 process's exit code as bin/run.sh recorded it; null if unknown. */
  exit_code: number | null;
  /** null when the generator produced no summary.json (crash, config error). */
  summary: RunSummary | null;
}

export interface FleetGeneratorEntry {
  gen_index: number;
  exit_code: number | null;
  summary_present: boolean;
  started_at: string | null;
  ended_at: string | null;
  duration_sec: number | null;
  rate: RunSummary['rate'] | null;
  events_attempted: number;
  events_sent: number;
  send_failure_rate: number | null;
  send_errors: number;
  dropped_iterations: number;
  send_duration_p99: number | null;
  thresholds_failed: number;
  valid: boolean;
  reasons: string[];
}

/**
 * How much of the fleet the merged timeline.jsonl actually covers. A merged
 * timeline is the SUM of the per-generator timelines that existed, so one
 * missing generator makes every bucket under-count without anything in the
 * file saying so — this block is that statement.
 *
 *  - `expected` — generators that reported a summary, i.e. the ones a
 *    timeline could be expected from; a generator that crashed before
 *    handleSummary is not counted against coverage.
 *  - `present` — every generator index whose timeline was found and merged.
 *  - `missing` — reporting generators with no timeline. `complete` is
 *    `missing` being empty (with at least one generator expected).
 *  - `configured_off` — NO generator had a timeline, which is what
 *    EMIT_TIMELINE=0 or a profile's `emit_timeline: false` looks like after
 *    the fact: not a gap, an intentional absence, so it raises no warning.
 */
export interface TimelineCoverage {
  expected: number;
  present: number[];
  missing: number[];
  complete: boolean;
  configured_off: boolean;
}

export interface FleetSummary extends Omit<RunSummary, 'generator'> {
  generator: { gen_index: null; gen_count: number };
  fleet: {
    generator_count: number;
    generators_reported: number;
    /** How many generators the merged timeline actually covers; null when the
     * caller merged summaries without saying anything about timelines. */
    timeline_coverage: TimelineCoverage | null;
    /** The fleet's verdict as a process exit code — see fleetExitCode. This
     * is the code bin/run.sh exits with in single-task fleet mode, and the
     * one a multi-task orchestrator should use after merging downloaded
     * generator directories, so both fleets judge failures the same way. */
    exit_code: number;
    generators: FleetGeneratorEntry[];
    /** Which rule produced each non-obvious field — see the module comment. */
    aggregation: Record<string, string>;
  };
}

/** THE fleet-summary predicate. src/storage/keys.ts and index-cli.ts use it
 * too, so S3 keys, index rows and this module cannot disagree on what a
 * fleet artifact is. */
export function isFleetSummary(s: unknown): s is FleetSummary {
  if (typeof s !== 'object' || s === null) return false;
  const fleet = (s as { fleet?: unknown }).fleet;
  return typeof fleet === 'object' && fleet !== null;
}

/**
 * The fleet's exit code, with an explicit precedence rather than a numeric
 * max: any non-zero code other than 99 (a crash, a config error, a kill)
 * beats 99, because a generator that never ran means the fleet's numbers
 * are not a measurement at all and must not be downgraded to "thresholds
 * failed"; 99 beats 0; among crash codes the lowest generator index wins.
 * A generator with no summary and no recorded code, or a claimed success
 * with no summary, counts as 1 (the same rule bin/run.sh applies).
 */
export function fleetExitCode(inputs: GeneratorInput[]): number {
  return exitCodePrecedence(
    [...inputs]
      .sort((a, b) => a.gen_index - b.gen_index)
      .map((i) => {
        const code = i.exit_code ?? 1;
        return code === 0 && i.summary === null ? 1 : code;
      }),
  );
}

/** The precedence alone, over per-generator codes in generator order (null =
 * unknown, counted as 1). Used by fleetExitCode and by fleet-launch's
 * --no-merge path so both agree. */
export function exitCodePrecedence(codes: Array<number | null>): number {
  let out = 0;
  for (const c of codes) {
    const code = c ?? 1;
    if (code === 0) continue;
    if (code !== 99) {
      if (out === 0 || out === 99) out = code;
    } else if (out === 0) {
      out = 99;
    }
  }
  return out;
}

const AGGREGATION: Record<string, string> = {
  'rate': 'taken from the first reporting generator (already fleet-wide on every generator); never summed',
  'metrics.count/passes/fails': 'summed across generators',
  'metrics.rate':
    'Rate metrics: Σpasses / (Σpasses + Σfails) — passes counts failed sends for send_failures ' +
    "(k6's Rate.add(!res.ok)), so this is the true failure rate, not its complement; Counter metrics: summed per-generator rates",
  'send_duration':
    'min = min, max = max; avg/med/p(90)/p(95)/p(99) = max across generators (worst generator, an upper bound)',
  'types.*.send_failures': 'max across generators (per-type failure COUNTS are not reported, only the rate)',
  'thresholds.slo': 'ok only if ok on every generator that reported the threshold',
  'validity.valid': 'AND over reporting generators, AND every generator reported a summary',
  'run.started_at/ended_at': 'earliest start / latest end; duration_sec recomputed from them',
  'payload_sample': `round-robin across generators, capped at ${MAX_PAYLOAD_SAMPLE}`,
  'fleet.timeline_coverage':
    'which reporting generators had a timeline.jsonl; the merged timeline is the SUM of those, so a missing ' +
    'generator makes every bucket under-count — read it before any per-stage conclusion',
};

type Values = Record<string, number>;

function mergeValues(all: Values[], warnings: string[], metric: string): Values {
  const keys = new Set<string>();
  for (const v of all) for (const k of Object.keys(v)) keys.add(k);
  const out: Values = {};
  const pick = (k: string) => all.map((v) => v[k]).filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  for (const k of keys) {
    const xs = pick(k);
    if (xs.length === 0) continue;
    switch (k) {
      case 'count':
      case 'passes':
      case 'fails':
        out[k] = xs.reduce((a, b) => a + b, 0);
        break;
      case 'min':
        out[k] = Math.min(...xs);
        break;
      case 'rate':
        break; // decided below once passes/fails/count are known
      default:
        // max, value (gauge), avg, med, p(..): worst generator
        out[k] = Math.max(...xs);
    }
  }
  if (keys.has('rate')) {
    const rates = pick('rate');
    if (typeof out.passes === 'number' && typeof out.fails === 'number') {
      const total = out.passes + out.fails;
      out.rate = total === 0 ? 0 : out.passes / total;
    } else if (typeof out.count === 'number') {
      out.rate = rates.reduce((a, b) => a + b, 0);
    } else {
      out.rate = Math.max(...rates);
      warnings.push(
        `metrics.${metric}.rate: no passes/fails to recompute from; took the max across generators`,
      );
    }
  }
  return out;
}

function sumNullable(
  xs: Array<number | null | undefined>,
  warnings: string[],
  label: string,
  gens: number[],
): number | null {
  const present = xs.map((x, i) => [x, gens[i]] as const).filter((p): p is readonly [number, number] => typeof p[0] === 'number');
  if (present.length === 0) return null;
  if (present.length < xs.length) {
    const missing = xs.map((x, i) => (typeof x === 'number' ? null : gens[i])).filter((g): g is number => g !== null);
    warnings.push(`${label}: null on ${missing.map((g) => `gen-${g}`).join(', ')}; summed the rest`);
  }
  return present.reduce((a, p) => a + p[0], 0);
}

function mergeTypes(
  reporting: Array<{ gen_index: number; summary: RunSummary }>,
  warnings: string[],
): Record<string, TypeSummary> {
  const names = new Set<string>();
  for (const r of reporting) for (const t of Object.keys(r.summary.types ?? {})) names.add(t);
  const gens = reporting.map((r) => r.gen_index);
  const out: Record<string, TypeSummary> = {};
  for (const name of [...names].sort()) {
    const entries = reporting.map((r) => r.summary.types?.[name]);
    const field = (k: 'events_attempted' | 'events_sent' | 'events_rejected' | 'wire_bytes' | 'send_errors') =>
      sumNullable(entries.map((e) => e?.[k]), warnings, `types.${name}.${k}`, gens);
    const durations = entries.map((e) => e?.send_duration).filter((d): d is Record<string, number> => !!d);
    out[name] = {
      events_attempted: field('events_attempted'),
      events_sent: field('events_sent'),
      events_rejected: field('events_rejected'),
      send_failures: maxNullable(entries.map((e) => e?.send_failures)),
      send_duration: durations.length === 0 ? null : mergeValues(durations, warnings, `types.${name}.send_duration`),
      wire_bytes: field('wire_bytes'),
      send_errors: field('send_errors'),
    };
  }
  return out;
}

/**
 * JSON with every object's keys in sorted order, recursively, so two values
 * that differ only in key order stringify identically. Used to compare
 * resolved_config across generators: k6 hands each generator the same
 * configuration, but nothing guarantees the property order survives a
 * round-trip, and an order-sensitive comparison would call a fleet
 * misconfigured for a cosmetic difference. No dependency: the repo has none.
 */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const parts = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${parts.join(',')}}`;
}

/** The generators whose canonical value for `read` differs from the first
 * reporting generator's, with both canonical forms so a caller can name them. */
function compareAcross<T>(
  reporting: Array<{ gen_index: number; summary: RunSummary }>,
  read: (s: RunSummary) => T,
): { first: string; first_gen: number; differing: Array<{ gen_index: number; value: string }> } {
  const first = stableStringify(read(reporting[0].summary));
  const differing: Array<{ gen_index: number; value: string }> = [];
  for (const r of reporting.slice(1)) {
    const value = stableStringify(read(r.summary));
    if (value !== first) differing.push({ gen_index: r.gen_index, value });
  }
  return { first, first_gen: reporting[0].gen_index, differing };
}

function checkAgreement<T>(
  reporting: Array<{ gen_index: number; summary: RunSummary }>,
  label: string,
  read: (s: RunSummary) => T,
  warnings: string[],
): void {
  const first = JSON.stringify(read(reporting[0].summary));
  for (const r of reporting.slice(1)) {
    const v = JSON.stringify(read(r.summary));
    if (v !== first) {
      warnings.push(
        `generators disagree on ${label}: gen-${reporting[0].gen_index}=${first} vs gen-${r.gen_index}=${v}`,
      );
    }
  }
}

function entryFor(input: GeneratorInput): FleetGeneratorEntry {
  const s = input.summary;
  if (!s) {
    return {
      gen_index: input.gen_index,
      exit_code: input.exit_code,
      summary_present: false,
      started_at: null,
      ended_at: null,
      duration_sec: null,
      rate: null,
      events_attempted: 0,
      events_sent: 0,
      send_failure_rate: null,
      send_errors: 0,
      dropped_iterations: 0,
      send_duration_p99: null,
      thresholds_failed: 0,
      valid: false,
      reasons: [`produced no summary.json (exit ${input.exit_code ?? 'unknown'})`],
    };
  }
  return {
    gen_index: input.gen_index,
    exit_code: input.exit_code,
    summary_present: true,
    started_at: s.run.started_at,
    ended_at: s.run.ended_at,
    duration_sec: s.run.duration_sec,
    rate: s.rate,
    events_attempted: s.metrics.events_attempted?.count ?? 0,
    events_sent: s.metrics.events_sent?.count ?? 0,
    send_failure_rate: s.metrics.send_failures?.rate ?? null,
    send_errors: s.metrics.send_errors?.count ?? 0,
    dropped_iterations: s.validity.dropped_iterations,
    send_duration_p99: s.metrics.send_duration?.['p(99)'] ?? null,
    thresholds_failed: s.thresholds.slo.filter((t) => !t.ok).length,
    valid: s.validity.valid,
    reasons: s.validity.reasons,
  };
}

/**
 * @param timelines  which generator indexes had a timeline.jsonl, as the
 *   caller found them on disk (src/fleet/cli.ts's readGeneratorDir knows).
 *   Omit it and `fleet.timeline_coverage` is null — "nobody said".
 * @param timeline_events_sent  Σ events_sent over the MERGED timeline, when
 *   one was produced; compared against metrics.events_sent.count to catch a
 *   truncated timeline (a warning, never an error).
 */
export function mergeSummaries(
  inputs: GeneratorInput[],
  gen_count: number,
  timelines?: Record<number, boolean>,
  timeline_events_sent?: number | null,
): FleetSummary {
  const sorted = [...inputs].sort((a, b) => a.gen_index - b.gen_index);
  // A subset merge — `fleet-cli merge out gen-0 gen-2` by hand, or a
  // multi-task fleet whose gen-1 never wrote anything to S3 — is an
  // INCOMPLETE fleet, not an error. When the reporting generators declare a
  // larger fleet than was supplied, that declared size is the fleet's, and
  // every index nobody supplied becomes a generator with no summary, so it
  // shows up in the breakdown, the reasons and generators_reported.
  // Only when the reporting generators AGREE on a size: if they disagree
  // with each other, that is a configuration fault reported below, and the
  // supplied directory count stays the fleet size.
  const declaredCounts = new Set(sorted.filter((i) => i.summary !== null).map((i) => i.summary!.generator.gen_count));
  if (declaredCounts.size === 1) {
    const declared = [...declaredCounts][0];
    if (declared > gen_count) gen_count = declared;
  }
  for (let i = 0; i < gen_count; i++) {
    if (!sorted.some((s) => s.gen_index === i)) sorted.push({ gen_index: i, exit_code: null, summary: null });
  }
  sorted.sort((a, b) => a.gen_index - b.gen_index);

  // Hard errors first, before any evidence is read: cli.ts writes nothing on a
  // throw, and a fleet whose members are not one run is not a measurement.
  const seen = new Set<number>();
  for (const i of sorted) {
    if (seen.has(i.gen_index)) {
      throw new Error(`duplicate generator index: gen-${i.gen_index} was supplied more than once`);
    }
    seen.add(i.gen_index);
    if (!Number.isInteger(i.gen_index) || i.gen_index < 0 || i.gen_index >= gen_count) {
      throw new Error(
        `gen-${i.gen_index} is outside a fleet of ${gen_count} generators (valid indexes 0..${gen_count - 1})`,
      );
    }
  }

  const reporting = sorted
    .filter((i): i is GeneratorInput & { summary: RunSummary } => i.summary !== null)
    .map((i) => ({ gen_index: i.gen_index, summary: i.summary }));
  if (reporting.length === 0) {
    throw new Error(
      `no generator produced a summary.json (exit codes: ${sorted.map((i) => `gen-${i.gen_index}=${i.exit_code ?? 'unknown'}`).join(', ')})`,
    );
  }
  for (const r of reporting) {
    if (r.summary.generator.gen_index !== r.gen_index) {
      throw new Error(
        `gen-${r.gen_index}'s summary carries generator.gen_index ${r.summary.generator.gen_index}: ` +
          `it is not this generator's summary`,
      );
    }
  }
  for (const label of ['schema_version', 'run.run_id'] as const) {
    const c = compareAcross(reporting, (s) => (label === 'schema_version' ? s.schema_version : s.run.run_id));
    if (c.differing.length > 0) {
      throw new Error(
        `generators disagree on ${label}: gen-${c.first_gen}=${c.first}, ` +
          `${c.differing.map((d) => `gen-${d.gen_index}=${d.value}`).join(', ')} — these are not one run`,
      );
    }
  }

  const warnings: string[] = [];
  const first = reporting[0].summary;

  // Soft: the fleet ran, but its members were not configured alike, so the
  // merged numbers do not describe one configuration. Evidence is still merged.
  const configReasons: string[] = [];
  const disagreesOn = (label: string, read: (s: RunSummary) => unknown, withValues: boolean) => {
    const c = compareAcross(reporting, read);
    if (c.differing.length === 0) return;
    configReasons.push(
      `fleet members disagree on configuration: ${label} differs` +
        (withValues
          ? ` (gen-${c.first_gen}=${c.first}, ${c.differing.map((d) => `gen-${d.gen_index}=${d.value}`).join(', ')})`
          : ` on ${c.differing.map((d) => `gen-${d.gen_index}`).join(', ')} from gen-${c.first_gen}`),
    );
  };
  disagreesOn('run.active_types', (s) => [...s.run.active_types].sort(), true);
  disagreesOn('resolved_config', (s) => s.resolved_config, false);
  const wrongCount = reporting.filter((r) => r.summary.generator.gen_count !== gen_count);
  if (wrongCount.length > 0) {
    configReasons.push(
      `fleet members disagree on configuration: generator.gen_count ` +
        `${wrongCount.map((r) => `gen-${r.gen_index}=${r.summary.generator.gen_count}`).join(', ')} ` +
        `but ${gen_count} generator directories were merged`,
    );
  }

  checkAgreement(reporting, 'run.k6_version', (s) => s.run.k6_version, warnings);
  checkAgreement(reporting, 'rate', (s) => s.rate, warnings);
  checkAgreement(reporting, 'thresholds.structural_count', (s) => s.thresholds.structural_count, warnings);

  // run: span
  const starts = reporting.map((r) => Date.parse(r.summary.run.started_at)).filter(Number.isFinite);
  const ends = reporting.map((r) => Date.parse(r.summary.run.ended_at)).filter(Number.isFinite);
  const started_at = starts.length ? new Date(Math.min(...starts)).toISOString() : first.run.started_at;
  const ended_at = ends.length ? new Date(Math.max(...ends)).toISOString() : first.run.ended_at;
  const span = Date.parse(ended_at) - Date.parse(started_at);
  const duration_sec = Number.isFinite(span) ? Math.round(span / 1000) : null;

  // metrics
  const metricNames = new Set<string>();
  for (const r of reporting) for (const m of Object.keys(r.summary.metrics)) metricNames.add(m);
  const metrics: Record<string, Values> = {};
  for (const m of metricNames) {
    metrics[m] = mergeValues(
      reporting.map((r) => r.summary.metrics[m]).filter((v): v is Values => !!v),
      warnings,
      m,
    );
  }

  // timeline coverage: what the merged timeline.jsonl actually covers
  let timeline_coverage: TimelineCoverage | null = null;
  if (timelines) {
    const present = sorted.filter((i) => timelines[i.gen_index] === true).map((i) => i.gen_index);
    const missing = reporting.filter((r) => timelines[r.gen_index] !== true).map((r) => r.gen_index);
    const expected = reporting.length;
    timeline_coverage = {
      expected,
      present,
      missing,
      complete: expected > 0 && missing.length === 0,
      configured_off: present.length === 0,
    };
    if (!timeline_coverage.complete && !timeline_coverage.configured_off) {
      warnings.push(
        `fleet timeline coverage: ${expected - missing.length} of ${expected} reporting generators shipped a timeline ` +
          `(missing ${missing.map((g) => `gen-${g}`).join(', ')}); the fleet timeline under-counts by whatever they sent`,
      );
    }
    // Truncation: only comparable when every reporting generator is in the merge.
    const summaryTotal = metrics.events_sent?.count;
    if (
      timeline_coverage.complete &&
      typeof timeline_events_sent === 'number' &&
      typeof summaryTotal === 'number' &&
      summaryTotal > 0 &&
      timeline_events_sent < 0.9 * summaryTotal
    ) {
      warnings.push(
        `fleet timeline holds ${timeline_events_sent} of the summary's ${summaryTotal} events_sent ` +
          `(${((timeline_events_sent / summaryTotal) * 100).toFixed(1)}%, less than 90%): the timeline looks truncated, ` +
          `so per-stage figures under-count even though coverage is complete`,
      );
    }
  }

  // thresholds: AND per (metric, expression)
  const slo = new Map<string, { ok: boolean; metric: string; expression: string; seen: number }>();
  for (const r of reporting) {
    for (const t of r.summary.thresholds.slo) {
      const key = `${t.metric} ${t.expression}`;
      const cur = slo.get(key);
      if (cur) {
        cur.ok = cur.ok && t.ok;
        cur.seen++;
      } else {
        slo.set(key, { ok: t.ok, metric: t.metric, expression: t.expression, seen: 1 });
      }
    }
  }
  for (const [key, t] of slo) {
    if (t.seen < reporting.length) {
      warnings.push(`threshold "${key}" was reported by ${t.seen} of ${reporting.length} generators`);
    }
  }
  const verdict_from: string[] = [];
  for (const r of reporting) for (const v of r.summary.verdict_from) if (!verdict_from.includes(v)) verdict_from.push(v);

  // validity
  const reasons: string[] = [];
  let valid = reporting.length === sorted.length;
  for (const r of reporting) {
    if (!r.summary.validity.valid) valid = false;
    for (const reason of r.summary.validity.reasons) reasons.push(`gen-${r.gen_index}: ${reason}`);
  }
  for (const i of sorted) {
    if (i.summary === null) {
      reasons.push(`gen-${i.gen_index} produced no summary.json (exit ${i.exit_code ?? 'unknown'})`);
    }
  }
  if (configReasons.length > 0) {
    valid = false;
    reasons.push(...configReasons);
  }
  const dropped = reporting.reduce((a, r) => a + r.summary.validity.dropped_iterations, 0);

  // warnings: one line when every generator said the same thing
  const counts = new Map<string, number>();
  for (const r of reporting) for (const w of new Set(r.summary.warnings)) counts.set(w, (counts.get(w) ?? 0) + 1);
  const shared: string[] = [];
  const attributed: string[] = [];
  for (const r of reporting) {
    for (const w of r.summary.warnings) {
      if (counts.get(w) === reporting.length) {
        if (!shared.includes(w)) shared.push(w);
      } else {
        attributed.push(`gen-${r.gen_index}: ${w}`);
      }
    }
  }

  // payload sample: round-robin
  const payload_sample: unknown[] = [];
  const samples = reporting.map((r) => r.summary.payload_sample);
  for (let k = 0; payload_sample.length < MAX_PAYLOAD_SAMPLE; k++) {
    let any = false;
    for (const s of samples) {
      if (k < s.length) {
        any = true;
        if (payload_sample.length < MAX_PAYLOAD_SAMPLE) payload_sample.push(s[k]);
      }
    }
    if (!any) break;
  }

  return {
    schema_version: first.schema_version,
    run: {
      run_id: first.run.run_id,
      started_at,
      ended_at,
      duration_sec,
      k6_version: first.run.k6_version,
      active_types: first.run.active_types,
    },
    resolved_config: first.resolved_config,
    generator: { gen_index: null, gen_count },
    rate: first.rate,
    metrics,
    types: mergeTypes(reporting, warnings),
    thresholds: {
      slo: [...slo.values()].map(({ ok, metric, expression }) => ({ ok, metric, expression })),
      structural_count: first.thresholds.structural_count,
    },
    verdict_from,
    validity: { dropped_iterations: dropped, generator_cpu: null, valid, reasons },
    payload_sample,
    warnings: [...shared, ...attributed, ...warnings],
    fleet: {
      generator_count: gen_count,
      generators_reported: reporting.length,
      timeline_coverage,
      exit_code: fleetExitCode(sorted),
      generators: sorted.map(entryFor),
      aggregation: { ...AGGREGATION },
    },
  };
}
