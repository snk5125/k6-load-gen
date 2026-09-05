import {
  n,
  renderFailedThresholds,
  renderInvalidity,
  renderTypeBreakdown,
  renderWarnings,
} from '../summary/render.ts';
import type { FleetSummary } from './merge.ts';

/** The fleet counterpart of renderSummary: same trailing sections, a fleet
 * header, and a per-generator table so one bad generator is visible. */
export function renderFleetSummary(s: FleetSummary): string {
  const d = s.metrics.send_duration ?? {};
  const durationDisplay = s.run.duration_sec === null ? 'unknown' : `${s.run.duration_sec}s`;
  const lines: string[] = [
    '',
    `=== ${s.run.run_id} — FLEET ${s.fleet.generators_reported}/${s.fleet.generator_count} — ${s.validity.valid ? 'VALID' : 'INVALID'} ===`,
    `fleet duration    : ${durationDisplay}  (${s.fleet.generator_count} generators in one task)`,
    `rate requested    : ${s.rate.requested_eps} eps`,
    `rate achievable   : ${s.rate.achieved_eps} eps  (drift ${n(s.rate.delta_pct)}%)`,
    `events attempted  : ${s.metrics.events_attempted?.count ?? 0}`,
    `events sent       : ${s.metrics.events_sent?.count ?? 0}`,
    `send failure rate : ${n((s.metrics.send_failures?.rate ?? 0) * 100, 3)}%`,
    `send p50/p95/p99  : ${n(d.med)} / ${n(d['p(95)'])} / ${n(d['p(99)'])} ms  (worst generator)`,
    `dropped iterations: ${s.validity.dropped_iterations}   <-- MUST be 0`,
  ];

  // How far apart the fleet actually started: it bounds how sharp any
  // per-stage reading can be, so it belongs beside the coverage line rather
  // than buried in the per-generator table's timestamps.
  const skew = s.fleet.start_skew_sec;
  if (skew !== null) {
    lines.push(`start skew        : ${n(skew)}s across generators`);
  }

  // Coverage before any per-stage reading: the merged timeline is the sum of
  // the timelines that existed, so a missing generator silently under-counts.
  const cov = s.fleet.timeline_coverage;
  if (cov) {
    if (cov.configured_off) {
      lines.push('timeline coverage : none (timeline emission off)');
    } else if (cov.complete) {
      lines.push(`timeline coverage : ${cov.expected}/${cov.expected} generators`);
    } else {
      lines.push(
        `timeline coverage : ${cov.present.length}/${cov.expected} generators ` +
          `(missing ${cov.missing.map((g) => `gen-${g}`).join(', ')}) — fleet timeline under-counts`,
      );
    }
    // A dropped timeline looks nothing like an absent one from the outside:
    // the file is sitting right there in the generator's directory.
    if (cov.orphan_timelines.length > 0) {
      lines.push(
        `timeline orphans  : ${cov.orphan_timelines.map((g) => `gen-${g}`).join(', ')} ` +
          `(timeline but no summary — not merged)`,
      );
    }
  }

  if (s.thresholds.structural_count > 0) {
    lines.push(`structural thresholds : ${s.thresholds.structural_count} (plumbing; never fail — see docs)`);
  }

  lines.push('', 'PER-GENERATOR:');
  for (const g of s.fleet.generators) {
    const exit = `exit=${g.exit_code ?? '?'}`;
    if (!g.summary_present) {
      lines.push(`  gen-${g.gen_index} ${exit} no summary INVALID`);
      continue;
    }
    lines.push(
      `  gen-${g.gen_index} ${exit} sent=${g.events_sent} ` +
        `failure_rate=${g.send_failure_rate === null ? 'null' : n(g.send_failure_rate * 100, 3) + '%'} ` +
        `p99=${g.send_duration_p99 === null ? 'null' : n(g.send_duration_p99)}ms ` +
        `dropped=${g.dropped_iterations} ${g.valid ? 'VALID' : 'INVALID'}`,
    );
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
