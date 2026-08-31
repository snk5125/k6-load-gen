import { describe, it, expect } from 'vitest';
import { buildSummary } from '../../src/summary/build.ts';
import { renderSummary } from '../../src/summary/render.ts';
import { buildThresholds } from '../../src/metrics/thresholds.ts';

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

// Fields common to the per-type tests below, deliberately excluding
// `metrics`/`active_types` so each test supplies its own.
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
    expect(s.thresholds.slo.find((t) => t.metric === 'send_failures')?.ok).toBe(false);
    expect(s.thresholds.slo.find((t) => t.metric === 'send_duration')?.ok).toBe(false);
    const out = renderSummary(s);
    expect(out).toMatch(/FAILED THRESHOLDS/);
    expect(out).toMatch(/send_failures rate<0\.001/);
  });

  it('invalidates a run when a VALIDITY threshold fails and names it', () => {
    const s = buildSummary(input(k6Metrics({
      dropped_iterations: { type: 'counter', values: { count: 17 }, thresholds: { 'count<1': { ok: false } } },
    })));
    expect(s.validity.valid).toBe(false);
    expect(s.thresholds.slo.find((t) => t.metric === 'dropped_iterations')?.ok).toBe(false);
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

describe('buildSummary per-type breakdown', () => {
  it('breaks metrics down per type from the tagged sub-metrics', () => {
    const s = buildSummary({
      ...base,
      active_types: ['auditd', 'cloudtrail'],
      metrics: {
        events_sent: { values: { count: 521 } },
        'events_sent{scenario:auditd}': { values: { count: 500 } },
        'events_sent{scenario:cloudtrail}': { values: { count: 21 } },
      },
    });
    expect(s.types.auditd.events_sent).toBe(500);
    expect(s.types.cloudtrail.events_sent).toBe(21);
  });

  it('keeps the run-wide aggregate alongside the per-type breakdown', () => {
    // Both are needed: the aggregate is what thresholds and validity are judged on.
    const s = buildSummary({
      ...base,
      active_types: ['auditd', 'cloudtrail'],
      metrics: {
        events_sent: { values: { count: 521 } },
        'events_sent{scenario:auditd}': { values: { count: 500 } },
        'events_sent{scenario:cloudtrail}': { values: { count: 21 } },
      },
    });
    expect(s.metrics.events_sent.count).toBe(521);
  });

  it('reports null, not zero, for a type whose sub-metric is absent', () => {
    // Absent is "not measured"; zero is "measured as none". Conflating them
    // is the same defect wire_bytes: number | null exists to prevent.
    const s = buildSummary({
      ...base,
      active_types: ['auditd'],
      metrics: { events_sent: { values: { count: 0 } } },
    });
    expect(s.types.auditd.events_sent).toBeNull();
  });

  it('reports zero, not null, for an idle scenario whose sub-metric is present with zero values', () => {
    const s = buildSummary({
      ...base,
      active_types: ['auditd'],
      metrics: {
        events_sent: { values: { count: 0 } },
        'events_sent{scenario:auditd}': { values: { count: 0 } },
      },
    });
    expect(s.types.auditd.events_sent).toBe(0);
  });

  // CRITICAL: otlp-grpc reports wire_bytes: null on every send (k6 does not
  // expose encoded protobuf size), and hec does the same under gzip: true —
  // yet the structural threshold on wire_bytes{scenario:<type>} still
  // materialises the sub-metric, arriving here PRESENT with count: 0. That
  // is indistinguishable, by shape, from "measured as none" for every other
  // metric — but for wire_bytes specifically, main.ts only ever adds a
  // non-null, positive value (see the res.wire_bytes !== null guard around
  // wireBytes.add), so a real run that transmitted hundreds of megabytes
  // over otlp-grpc must not publish wire_bytes: 0. See src/summary/build.ts.
  it('reports null, not zero, for wire_bytes when the sub-metric is present but genuinely unobservable', () => {
    const s = buildSummary({
      ...base,
      active_types: ['auditd'],
      metrics: {
        'wire_bytes{scenario:auditd}': { values: { count: 0 } },
      },
    });
    expect(s.types.auditd.wire_bytes).toBeNull();
  });

  it('still reports a real zero for every OTHER structural metric, only wire_bytes gets the null override', () => {
    const s = buildSummary({
      ...base,
      active_types: ['auditd'],
      metrics: {
        'events_sent{scenario:auditd}': { values: { count: 0 } },
        'wire_bytes{scenario:auditd}': { values: { count: 0 } },
      },
    });
    expect(s.types.auditd.events_sent).toBe(0);
    expect(s.types.auditd.wire_bytes).toBeNull();
  });

  it('still reports a genuine non-zero wire_bytes count when the transport actually measured it', () => {
    const s = buildSummary({
      ...base,
      active_types: ['auditd'],
      metrics: {
        'wire_bytes{scenario:auditd}': { values: { count: 48213 } },
      },
    });
    expect(s.types.auditd.wire_bytes).toBe(48213);
  });

  it('separates structural thresholds from SLO thresholds', () => {
    // The structural key set is populated as a side effect of buildThresholds;
    // reproduce that here the way the real runtime does before handleSummary runs.
    buildThresholds({ abort_on_fail: false, active_types: ['auditd'] });
    const s = buildSummary({
      ...base,
      active_types: ['auditd'],
      metrics: {
        'events_sent{scenario:auditd}': { thresholds: { 'count>=0': { ok: true } }, values: { count: 5 } },
        send_failures: { thresholds: { 'rate<0.001': { ok: false } }, values: { rate: 0.5 } },
      },
    });
    expect(s.thresholds.slo).toHaveLength(1);
    expect(s.thresholds.slo[0].ok).toBe(false);
    expect(s.thresholds.structural_count).toBe(1);
  });

  it('never lets a structural threshold affect the run verdict', () => {
    buildThresholds({ abort_on_fail: false, active_types: ['auditd'] });
    const s = buildSummary({
      ...base,
      active_types: ['auditd'],
      metrics: {
        'events_sent{scenario:auditd}': { thresholds: { 'count>=0': { ok: true } }, values: { count: 5 } },
        send_failures: { thresholds: { 'rate<0.001': { ok: false } }, values: { rate: 0.5 } },
      },
    });
    expect(s.verdict_from).not.toContain('count>=0');
    expect(s.verdict_from).toContain('rate<0.001');
  });

  it('publishes run.active_types so a subsetted run is distinguishable from a full one', () => {
    const s = buildSummary({ ...base, active_types: ['auditd'], metrics: {} });
    expect(s.run.active_types).toEqual(['auditd']);
  });

  it('defaults to no per-type breakdown when active_types is omitted', () => {
    const s = buildSummary(input(k6Metrics()));
    expect(s.types).toEqual({});
    expect(s.run.active_types).toEqual([]);
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
