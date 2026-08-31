import type { RunSummary } from './build.ts';

const n = (v: number | undefined, digits = 1): string =>
  v === undefined ? '-' : v.toFixed(digits);

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

  if (Object.keys(s.types).length > 0) {
    lines.push('', 'PER-TYPE BREAKDOWN:');
    for (const type of Object.keys(s.types).sort()) {
      const t = s.types[type];
      const dur = t.send_duration;
      lines.push(
        `  ${type}: attempted=${t.events_attempted ?? 'null'} sent=${t.events_sent ?? 'null'} ` +
          `failure_rate=${t.send_failures === null ? 'null' : n(t.send_failures * 100, 3) + '%'} ` +
          `p99=${dur === null ? 'null' : n(dur['p(99)'])}ms`,
      );
    }
  }

  const failed = s.thresholds.slo.filter((t) => !t.ok);
  if (failed.length > 0) {
    lines.push('', 'FAILED THRESHOLDS (SLO):');
    for (const t of failed) lines.push(`  - ${t.metric} ${t.expression}`);
  }

  if (s.warnings.length > 0) {
    lines.push('', 'WARNINGS:');
    for (const w of s.warnings) lines.push(`  - ${w}`);
  }

  if (!s.validity.valid) {
    lines.push('', 'RUN IS NOT VALID:');
    for (const r of s.validity.reasons) lines.push(`  - ${r}`);
  }

  lines.push('');
  return lines.join('\n');
}
