import type { RunSummary } from './build.ts';

export const n = (v: number | undefined, digits = 1): string =>
  v === undefined ? '-' : v.toFixed(digits);

// The four trailing sections are shared with the fleet report
// (src/fleet/render.ts), which has a different header and a per-generator
// table but must read identically from the per-type breakdown down.

export function renderTypeBreakdown(types: RunSummary['types']): string[] {
  if (Object.keys(types).length === 0) return [];
  const lines = ['', 'PER-TYPE BREAKDOWN:'];
  for (const type of Object.keys(types).sort()) {
    const t = types[type];
    const dur = t.send_duration;
    lines.push(
      `  ${type}: attempted=${t.events_attempted ?? 'null'} sent=${t.events_sent ?? 'null'} ` +
        `failure_rate=${t.send_failures === null ? 'null' : n(t.send_failures * 100, 3) + '%'} ` +
        `p99=${dur === null ? 'null' : n(dur['p(99)'])}ms`,
    );
  }
  return lines;
}

export function renderFailedThresholds(slo: RunSummary['thresholds']['slo']): string[] {
  const failed = slo.filter((t) => !t.ok);
  if (failed.length === 0) return [];
  return ['', 'FAILED THRESHOLDS (SLO):', ...failed.map((t) => `  - ${t.metric} ${t.expression}`)];
}

export function renderWarnings(warnings: string[]): string[] {
  if (warnings.length === 0) return [];
  return ['', 'WARNINGS:', ...warnings.map((w) => `  - ${w}`)];
}

export function renderInvalidity(validity: RunSummary['validity']): string[] {
  if (validity.valid) return [];
  return ['', 'RUN IS NOT VALID:', ...validity.reasons.map((r) => `  - ${r}`)];
}

export function renderSummary(s: RunSummary): string {
  const d = s.metrics.send_duration ?? {};
  const durationDisplay = s.run.duration_sec === null ? 'unknown' : `${s.run.duration_sec}s`;
  const lines: string[] = [
    '',
    `=== ${s.run.run_id} — ${s.validity.valid ? 'VALID' : 'INVALID'} ===`,
    `scenario duration : ${durationDisplay}  (gen ${s.generator.gen_index + 1}/${s.generator.gen_count})`,
    `rate requested    : ${s.rate.requested_eps} eps`,
    `rate achievable   : ${s.rate.achieved_eps} eps  (drift ${n(s.rate.delta_pct)}%)`,
    `events attempted  : ${s.metrics.events_attempted?.count ?? 0}`,
    `events sent       : ${s.metrics.events_sent?.count ?? 0}`,
    `send failure rate : ${n((s.metrics.send_failures?.rate ?? 0) * 100, 3)}%`,
    `send p50/p95/p99  : ${n(d.med)} / ${n(d['p(95)'])} / ${n(d['p(99)'])} ms`,
    `dropped iterations: ${s.validity.dropped_iterations}   <-- MUST be 0`,
  ];

  // Structural thresholds (see src/metrics/thresholds.ts STRUCTURAL_EXPRESSIONS)
  // never fail by construction — they exist only to force a per-type
  // sub-metric into this summary. With three active types that is eighteen
  // never-failing entries; showing a count instead of one line each is what
  // keeps this block from swamping the real SLO verdicts below.
  if (s.thresholds.structural_count > 0) {
    lines.push(`structural thresholds : ${s.thresholds.structural_count} (plumbing; never fail — see docs)`);
  }

  lines.push(
    ...renderTypeBreakdown(s.types),
    ...renderFailedThresholds(s.thresholds.slo),
    ...renderWarnings(s.warnings),
    ...renderInvalidity(s.validity),
    '',
  );
  return lines.join('\n');
}
