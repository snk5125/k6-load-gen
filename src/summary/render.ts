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

  const failed = Object.values(s.thresholds).filter((t) => !t.ok);
  if (failed.length > 0) {
    lines.push('', 'FAILED THRESHOLDS:');
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
