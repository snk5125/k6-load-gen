import { describe, it, expect } from 'vitest';
import { buildSummary } from '../../src/summary/build.ts';
import { renderSummary } from '../../src/summary/render.ts';
import { buildThresholds, STRUCTURAL_EXPRESSIONS } from '../../src/metrics/thresholds.ts';

const base = {
  run_id: 'run-1',
  started_at: '2026-08-29T10:00:00.000Z',
  ended_at: '2026-08-29T10:10:00.000Z',
  k6_version: 'v2.2.0',
  resolved_config: { name: 'p' },
  gen_index: 0,
  gen_count: 1,
  rate: { requested_eps: 5000, achieved_eps: 5000, delta_pct: 0 },
  payload_sample: [] as unknown[],
  warnings: [] as string[],
};

// Structural thresholds on every STRUCTURAL_EXPRESSIONS metric, tagged for
// one type, mirroring what a real handleSummary run receives once
// buildThresholds has generated them (Task 7).
function structuralMetricsFor(type: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [metric, expr] of Object.entries(STRUCTURAL_EXPRESSIONS)) {
    out[`${metric}{scenario:${type}}`] = {
      thresholds: { [expr]: { ok: true } },
      values: metric === 'send_duration' ? { avg: 5, med: 4, 'p(95)': 9, 'p(99)': 12, max: 20 } : { count: 10, rate: 0 },
    };
  }
  return out;
}

describe('renderSummary — structural thresholds kept out of the verdict block', () => {
  it('reports structural thresholds as a count, not one line per threshold', () => {
    buildThresholds({ abort_on_fail: false, active_types: ['auditd', 'cloudtrail'] });
    const s = buildSummary({
      ...base,
      active_types: ['auditd', 'cloudtrail'],
      metrics: {
        ...structuralMetricsFor('auditd'),
        ...structuralMetricsFor('cloudtrail'),
      },
    });
    expect(s.thresholds.structural_count).toBe(12);
    const out = renderSummary(s);
    expect(out).toMatch(/structural thresholds\s*:\s*12/);
    // Not swamped: the individual structural expressions never appear as
    // their own lines (they would if this fell through to the old
    // one-line-per-threshold rendering).
    expect(out).not.toMatch(/count>=0/);
    expect(out).not.toMatch(/max>=0/);
    expect(out).not.toMatch(/FAILED THRESHOLDS/);
  });

  it('still shows a failed SLO threshold prominently alongside a structural-only count', () => {
    buildThresholds({ abort_on_fail: false, active_types: ['auditd'] });
    const s = buildSummary({
      ...base,
      active_types: ['auditd'],
      metrics: {
        ...structuralMetricsFor('auditd'),
        send_failures: { thresholds: { 'rate<0.001': { ok: false } }, values: { rate: 0.9 } },
      },
    });
    const out = renderSummary(s);
    expect(out).toMatch(/structural thresholds\s*:\s*6/);
    expect(out).toMatch(/FAILED THRESHOLDS/);
    expect(out).toMatch(/send_failures rate<0\.001/);
  });

  it('shows per-type numbers for each active type', () => {
    const s = buildSummary({
      ...base,
      active_types: ['auditd', 'cloudtrail'],
      metrics: {
        'events_sent{scenario:auditd}': { values: { count: 500 } },
        'events_attempted{scenario:auditd}': { values: { count: 500 } },
        'events_sent{scenario:cloudtrail}': { values: { count: 21 } },
        'events_attempted{scenario:cloudtrail}': { values: { count: 21 } },
      },
    });
    const out = renderSummary(s);
    expect(out).toMatch(/PER-TYPE BREAKDOWN/);
    expect(out).toMatch(/auditd:.*sent=500/);
    expect(out).toMatch(/cloudtrail:.*sent=21/);
  });

  it('omits the per-type block entirely when no types are active', () => {
    const s = buildSummary({ ...base, metrics: {} });
    const out = renderSummary(s);
    expect(out).not.toMatch(/PER-TYPE BREAKDOWN/);
  });
});
