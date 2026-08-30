import { describe, it, expect } from 'vitest';
import { buildSummary } from '../../src/summary/build.ts';
import { renderSummary } from '../../src/summary/render.ts';

const k6Metrics = (overrides: Record<string, unknown> = {}) => ({
  events_sent: { type: 'counter', values: { count: 50000, rate: 5000 } },
  events_attempted: { type: 'counter', values: { count: 50000, rate: 5000 } },
  send_failures: { type: 'rate', values: { rate: 0 }, thresholds: { 'rate<0.001': { ok: true } } },
  send_duration: { type: 'trend', values: { avg: 12, med: 10, 'p(95)': 30, 'p(99)': 44, max: 90 } },
  dropped_iterations: { type: 'counter', values: { count: 0 } },
  ...overrides,
});

const input = (metrics: Record<string, unknown>) => ({
  run_id: 'run-1',
  started_at: '2026-08-29T10:00:00.000Z',
  ended_at: '2026-08-29T10:10:00.000Z',
  k6_version: 'v2.2.0',
  resolved_config: { name: 'p' },
  gen_index: 0,
  gen_count: 1,
  rate: { requested_eps: 5000, achieved_eps: 5000, delta_pct: 0 },
  metrics,
  payload_sample: Array.from({ length: 25 }, (_, i) => ({ seq: i })),
  warnings: [],
});

describe('buildSummary', () => {
  it('stamps schema_version and run metadata', () => {
    const s = buildSummary(input(k6Metrics()));
    expect(s.schema_version).toBe(1);
    expect(s.run.run_id).toBe('run-1');
    expect(s.run.duration_sec).toBe(600);
  });

  it('extracts counter and trend values', () => {
    const s = buildSummary(input(k6Metrics()));
    expect(s.metrics.events_sent.count).toBe(50000);
    expect(s.metrics.send_duration['p(99)']).toBe(44);
  });

  it('embeds the resolved config so results are self-describing', () => {
    expect(buildSummary(input(k6Metrics())).resolved_config).toEqual({ name: 'p' });
  });

  it('caps the payload sample at 10 events', () => {
    expect(buildSummary(input(k6Metrics())).payload_sample.length).toBe(10);
  });

  it('marks a clean run valid', () => {
    const s = buildSummary(input(k6Metrics()));
    expect(s.validity.valid).toBe(true);
    expect(s.validity.reasons).toEqual([]);
    expect(s.validity.dropped_iterations).toBe(0);
  });

  it('leaves generator_cpu null as a declared gap', () => {
    expect(buildSummary(input(k6Metrics())).validity.generator_cpu).toBeNull();
  });

  it('invalidates a run that dropped iterations', () => {
    const s = buildSummary(input(k6Metrics({
      dropped_iterations: { type: 'counter', values: { count: 17 } },
    })));
    expect(s.validity.valid).toBe(false);
    expect(s.validity.dropped_iterations).toBe(17);
    expect(s.validity.reasons.join(' ')).toMatch(/dropped 17 iterations/i);
  });

  // Spec 8.2: validity thresholds are always-on and non-configurable; SLO
  // thresholds come from the profile. A breakpoint run exists to break an SLO
  // threshold and a sweep past the knee fails send_failures by construction —
  // neither makes the run's numbers meaningless.
  it('keeps a run valid when only a profile SLO threshold fails, but still shows it', () => {
    const s = buildSummary(input(k6Metrics({
      send_failures: { type: 'rate', values: { rate: 0.4 }, thresholds: { 'rate<0.001': { ok: false } } },
      send_duration: { type: 'trend', values: { avg: 12, med: 10, 'p(95)': 30, 'p(99)': 900, max: 1200 }, thresholds: { 'p(99)<250': { ok: false } } },
    })));
    expect(s.validity.valid).toBe(true);
    expect(s.validity.reasons).toEqual([]);
    expect(s.validity.dropped_iterations).toBe(0);
    // Not hidden — fully visible in the thresholds block and the rendered output.
    expect(s.thresholds['send_failures:rate<0.001'].ok).toBe(false);
    expect(s.thresholds['send_duration:p(99)<250'].ok).toBe(false);
    const out = renderSummary(s);
    expect(out).toMatch(/FAILED THRESHOLDS/);
    expect(out).toMatch(/send_failures rate<0\.001/);
  });

  it('invalidates a run when a VALIDITY threshold fails and names it', () => {
    const s = buildSummary(input(k6Metrics({
      dropped_iterations: { type: 'counter', values: { count: 17 }, thresholds: { 'count<1': { ok: false } } },
    })));
    expect(s.validity.valid).toBe(false);
    expect(s.thresholds['dropped_iterations:count<1'].ok).toBe(false);
    expect(s.validity.reasons.join(' ')).toMatch(/validity threshold failed: dropped_iterations/);
  });

  it('invalidates a run with dropped iterations even without a threshold entry', () => {
    const s = buildSummary(input(k6Metrics({
      dropped_iterations: { type: 'counter', values: { count: 4 } },
    })));
    expect(s.validity.valid).toBe(false);
    expect(s.validity.reasons.join(' ')).toMatch(/dropped 4 iterations/i);
  });

  it('invalidates a run whose metrics have no events_attempted key at all', () => {
    const metrics = k6Metrics();
    delete (metrics as Record<string, unknown>).events_attempted;
    const s = buildSummary(input(metrics));
    expect(s.validity.valid).toBe(false);
    expect(s.validity.reasons.join(' ')).toMatch(/attempted 0 events/i);
  });

  it('invalidates a run whose events_attempted count is 0', () => {
    const s = buildSummary(input(k6Metrics({
      events_attempted: { type: 'counter', values: { count: 0, rate: 0 } },
    })));
    expect(s.validity.valid).toBe(false);
    expect(s.validity.reasons.join(' ')).toMatch(/attempted 0 events/i);
  });

  it('does not invalidate a run whose events_attempted count is non-zero', () => {
    const s = buildSummary(input(k6Metrics({
      events_attempted: { type: 'counter', values: { count: 200, rate: 20 } },
    })));
    expect(s.validity.valid).toBe(true);
    expect(s.validity.reasons).toEqual([]);
  });

  it('carries config warnings through', () => {
    const s = buildSummary({ ...input(k6Metrics()), warnings: ['rate drift 20.0%'] });
    expect(s.warnings).toEqual(['rate drift 20.0%']);
  });

  it('tolerates missing metrics without throwing', () => {
    const s = buildSummary(input({}));
    expect(s.metrics).toEqual({});
    expect(s.validity.dropped_iterations).toBe(0);
  });

  it('computes duration_sec from valid timestamps', () => {
    const s = buildSummary(input(k6Metrics()));
    expect(s.run.duration_sec).toBe(600);
  });

  it('sets duration_sec to null and warns for unparseable timestamps', () => {
    const s = buildSummary({
      ...input(k6Metrics()),
      ended_at: 'invalid-date',
    });
    expect(s.run.duration_sec).toBeNull();
    expect(s.warnings.some((w) => w.includes('run duration could not be computed'))).toBe(true);
    expect(s.warnings.some((w) => w.includes('started_at='))).toBe(true);
    expect(s.warnings.some((w) => w.includes('ended_at="invalid-date"'))).toBe(true);
    expect(s.validity.valid).toBe(true);
  });
});

describe('renderSummary', () => {
  it('shows the run id, rate, and a PASS marker', () => {
    const out = renderSummary(buildSummary(input(k6Metrics())));
    expect(out).toMatch(/run-1/);
    expect(out).toMatch(/5000/);
    // Must not be /VALID/ — that substring also matches "INVALID".
    expect(out).toMatch(/— VALID ===/);
  });

  it('shows an INVALID marker and the reason when the run is void', () => {
    const out = renderSummary(buildSummary(input(k6Metrics({
      dropped_iterations: { type: 'counter', values: { count: 3 } },
    }))));
    expect(out).toMatch(/INVALID/);
    expect(out).toMatch(/dropped 3 iterations/i);
  });
});
