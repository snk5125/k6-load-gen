import { MAX_PAYLOAD_SAMPLE, type RunSummary, type TypeSummary } from '../summary/build.ts';

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
 *  - a Rate metric's `rate` is recomputed as Σfails / (Σpasses + Σfails);
 *  - trend stats (`avg`, `med`, `p(..)`) are the WORST generator (max) — an
 *    upper bound, not a true fleet percentile, because the samples behind
 *    them are gone by the time a summary exists; `min` is min, `max` is max;
 *  - thresholds: ok only if ok on every generator that reported them;
 *  - validity: AND over reporting generators AND every generator reported.
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

export interface FleetSummary extends Omit<RunSummary, 'generator'> {
  generator: { gen_index: null; gen_count: number };
  fleet: {
    generator_count: number;
    generators_reported: number;
    generators: FleetGeneratorEntry[];
    /** Which rule produced each non-obvious field — see the module comment. */
    aggregation: Record<string, string>;
  };
}

export function isFleetSummary(s: unknown): s is FleetSummary {
  return typeof s === 'object' && s !== null && 'fleet' in s && (s as { fleet: unknown }).fleet !== null;
}

const AGGREGATION: Record<string, string> = {
  'rate': 'taken from the first reporting generator (already fleet-wide on every generator); never summed',
  'metrics.count/passes/fails': 'summed across generators',
  'metrics.rate':
    'Rate metrics: Σfails / (Σpasses + Σfails); Counter metrics: summed per-generator rates',
  'send_duration':
    'min = min, max = max; avg/med/p(90)/p(95)/p(99) = max across generators (worst generator, an upper bound)',
  'types.*.send_failures': 'max across generators (per-type failure COUNTS are not reported, only the rate)',
  'thresholds.slo': 'ok only if ok on every generator that reported the threshold',
  'validity.valid': 'AND over reporting generators, AND every generator reported a summary',
  'run.started_at/ended_at': 'earliest start / latest end; duration_sec recomputed from them',
  'payload_sample': `round-robin across generators, capped at ${MAX_PAYLOAD_SAMPLE}`,
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
      out.rate = total === 0 ? 0 : out.fails / total;
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

function maxNullable(xs: Array<number | null | undefined>): number | null {
  const present = xs.filter((x): x is number => typeof x === 'number');
  return present.length === 0 ? null : Math.max(...present);
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
    const field = (k: 'events_attempted' | 'events_sent' | 'wire_bytes' | 'send_errors') =>
      sumNullable(entries.map((e) => e?.[k]), warnings, `types.${name}.${k}`, gens);
    const durations = entries.map((e) => e?.send_duration).filter((d): d is Record<string, number> => !!d);
    out[name] = {
      events_attempted: field('events_attempted'),
      events_sent: field('events_sent'),
      send_failures: maxNullable(entries.map((e) => e?.send_failures)),
      send_duration: durations.length === 0 ? null : mergeValues(durations, warnings, `types.${name}.send_duration`),
      wire_bytes: field('wire_bytes'),
      send_errors: field('send_errors'),
    };
  }
  return out;
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

export function mergeSummaries(inputs: GeneratorInput[], gen_count: number): FleetSummary {
  const sorted = [...inputs].sort((a, b) => a.gen_index - b.gen_index);
  const reporting = sorted
    .filter((i): i is GeneratorInput & { summary: RunSummary } => i.summary !== null)
    .map((i) => ({ gen_index: i.gen_index, summary: i.summary }));
  if (reporting.length === 0) {
    throw new Error(
      `no generator produced a summary.json (exit codes: ${sorted.map((i) => `gen-${i.gen_index}=${i.exit_code ?? 'unknown'}`).join(', ')})`,
    );
  }
  const warnings: string[] = [];
  const first = reporting[0].summary;

  checkAgreement(reporting, 'run.run_id', (s) => s.run.run_id, warnings);
  checkAgreement(reporting, 'run.k6_version', (s) => s.run.k6_version, warnings);
  checkAgreement(reporting, 'run.active_types', (s) => [...s.run.active_types].sort(), warnings);
  checkAgreement(reporting, 'resolved_config', (s) => s.resolved_config, warnings);
  checkAgreement(reporting, 'rate', (s) => s.rate, warnings);
  checkAgreement(reporting, 'generator.gen_count', (s) => s.generator.gen_count, warnings);
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
      generators: sorted.map(entryFor),
      aggregation: { ...AGGREGATION },
    },
  };
}
