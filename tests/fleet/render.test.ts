import { describe, it, expect } from 'vitest';
import { mergeSummaries } from '../../src/fleet/merge.ts';
import { renderFleetSummary } from '../../src/fleet/render.ts';
import type { RunSummary } from '../../src/summary/build.ts';

function gen(i: number, over: Partial<RunSummary> = {}): RunSummary {
  return {
    schema_version: 2,
    run: { run_id: 'fleet-1', started_at: '2026-08-29T10:00:00.000Z', ended_at: '2026-08-29T10:01:00.000Z', duration_sec: 60, k6_version: 'v2.2.0', active_types: ['json-app'] },
    resolved_config: { name: 'local-null' },
    generator: { gen_index: i, gen_count: 2 },
    rate: { requested_eps: 5000, achieved_eps: 5000, delta_pct: 0 },
    metrics: {
      events_attempted: { count: 1000 }, events_sent: { count: 1000 },
      send_failures: { rate: 0, passes: 0, fails: 10 },
      send_duration: { avg: 5, min: 1, med: 4, max: 20, 'p(90)': 8, 'p(95)': 9, 'p(99)': 12 + i },
    },
    types: { 'json-app': { events_attempted: 1000, events_sent: 1000, send_failures: 0, send_duration: { 'p(99)': 12 + i }, wire_bytes: null, send_errors: 0, events_rejected: 0 } },
    thresholds: { slo: [{ ok: true, metric: 'send_failures', expression: 'rate<0.001' }], structural_count: 6 },
    verdict_from: ['send_failures rate<0.001'],
    validity: { dropped_iterations: 0, generator_cpu: null, valid: true, reasons: [] },
    payload_sample: [],
    warnings: [],
    ...over,
  };
}

describe('renderFleetSummary', () => {
  it('leads with the fleet verdict and how many generators reported', () => {
    const f = mergeSummaries([{ gen_index: 0, exit_code: 0, summary: gen(0) }, { gen_index: 1, exit_code: 0, summary: gen(1) }], 2);
    const out = renderFleetSummary(f);
    expect(out).toMatch(/=== fleet-1 — FLEET 2\/2 — VALID ===/);
    expect(out).toMatch(/events sent\s+: 2000/);
    expect(out).toMatch(/PER-GENERATOR/);
    expect(out).toMatch(/gen-0 .*exit=0/);
    expect(out).toMatch(/gen-1 .*p99=13\.0/);
    expect(out).toMatch(/PER-TYPE BREAKDOWN/);
    expect(out).toMatch(/json-app: attempted=2000/);
  });

  it('shows a missing generator, the failed thresholds and the reasons when the fleet is invalid', () => {
    const bad = gen(0, {
      thresholds: { slo: [{ ok: false, metric: 'send_failures', expression: 'rate<0.001' }], structural_count: 6 },
      validity: { dropped_iterations: 3, generator_cpu: null, valid: false, reasons: ['generator dropped 3 iterations'] },
    });
    const f = mergeSummaries([{ gen_index: 0, exit_code: 99, summary: bad }, { gen_index: 1, exit_code: 107, summary: null }], 2);
    const out = renderFleetSummary(f);
    expect(out).toMatch(/FLEET 1\/2 — INVALID/);
    expect(out).toMatch(/gen-1 .*exit=107 .*no summary/);
    expect(out).toMatch(/FAILED THRESHOLDS \(SLO\):\n\s+- send_failures rate<0\.001/);
    expect(out).toMatch(/RUN IS NOT VALID:/);
    expect(out).toMatch(/gen-0: generator dropped 3 iterations/);
    expect(out).toMatch(/gen-1 produced no summary\.json \(exit 107\)/);
  });
});

describe('renderFleetSummary — timeline coverage', () => {
  const two = (timelines?: Record<number, boolean>, sent?: number | null) =>
    mergeSummaries(
      [{ gen_index: 0, exit_code: 0, summary: gen(0) }, { gen_index: 1, exit_code: 0, summary: gen(1) }],
      2,
      timelines,
      sent,
    );

  it('says nothing when the caller merged without timeline information', () => {
    expect(renderFleetSummary(two())).not.toMatch(/timeline coverage/);
  });

  it('reports complete coverage', () => {
    expect(renderFleetSummary(two({ 0: true, 1: true }))).toMatch(/timeline coverage\s+: 2\/2 generators/);
  });

  it('names the missing generator and says the fleet timeline under-counts', () => {
    const out = renderFleetSummary(two({ 0: true, 1: false }));
    expect(out).toMatch(/timeline coverage\s+: 1\/2 generators \(missing gen-1\) — fleet timeline under-counts/);
  });

  it('says timelines were off rather than missing when no generator had one', () => {
    expect(renderFleetSummary(two({ 0: false, 1: false }))).toMatch(/timeline coverage\s+: none \(timeline emission off\)/);
  });
});
