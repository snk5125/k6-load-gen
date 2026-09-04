import { describe, it, expect } from 'vitest';
import { mergeSummaries, type GeneratorInput } from '../../src/fleet/merge.ts';
import type { RunSummary } from '../../src/summary/build.ts';

/** A schema-2 single-generator summary, shaped like buildSummary's output. */
function gen(i: number, over: Partial<RunSummary> = {}, count = 2): RunSummary {
  return {
    schema_version: 2,
    run: {
      run_id: 'fleet-1',
      started_at: `2026-08-29T10:00:0${i}.000Z`,
      ended_at: `2026-08-29T10:01:0${i}.000Z`,
      duration_sec: 60,
      k6_version: 'v2.2.0',
      active_types: ['json-app'],
    },
    resolved_config: { name: 'local-null', target: { transport: 'null' }, types: { 'json-app': { scenario: 'sweep' } } },
    generator: { gen_index: i, gen_count: count },
    rate: { requested_eps: 5000, achieved_eps: 5000, delta_pct: 0 },
    metrics: {
      events_attempted: { count: 1000 + i, rate: 16 },
      events_sent: { count: 1000, rate: 16 },
      send_failures: { rate: 0, passes: 10, fails: 0 },
      send_errors: { count: 0, rate: 0 },
      dropped_iterations: { count: 0, rate: 0 },
      send_duration: { avg: 5 + i, min: 1, med: 4 + i, max: 20 + i, 'p(90)': 8 + i, 'p(95)': 9 + i, 'p(99)': 12 + i },
    },
    types: {
      'json-app': { events_attempted: 1000 + i, events_sent: 1000, send_failures: 0, send_duration: { 'p(99)': 12 + i }, wire_bytes: 5000, send_errors: 0 },
    },
    thresholds: { slo: [{ ok: true, metric: 'send_failures', expression: 'rate<0.001' }], structural_count: 6 },
    verdict_from: ['send_failures rate<0.001'],
    validity: { dropped_iterations: 0, generator_cpu: null, valid: true, reasons: [] },
    payload_sample: [{ seq: i * 100 }, { seq: i * 100 + 1 }],
    warnings: ['shared warning'],
    ...over,
  };
}

const input = (i: number, summary: RunSummary | null, exit_code: number | null = 0): GeneratorInput => ({
  gen_index: i,
  exit_code,
  summary,
});

describe('mergeSummaries — identity and shape', () => {
  it('keeps schema_version 2 and adds a fleet block with a null gen_index', () => {
    const f = mergeSummaries([input(0, gen(0)), input(1, gen(1))], 2);
    expect(f.schema_version).toBe(2);
    expect(f.generator).toEqual({ gen_index: null, gen_count: 2 });
    expect(f.fleet.generator_count).toBe(2);
    expect(f.fleet.generators_reported).toBe(2);
    expect(f.run.run_id).toBe('fleet-1');
    expect(f.run.active_types).toEqual(['json-app']);
  });

  it('spans the fleet: earliest start, latest end, duration recomputed', () => {
    const f = mergeSummaries([input(0, gen(0)), input(1, gen(1))], 2);
    expect(f.run.started_at).toBe('2026-08-29T10:00:00.000Z');
    expect(f.run.ended_at).toBe('2026-08-29T10:01:01.000Z');
    expect(f.run.duration_sec).toBe(61);
  });

  it('takes the fleet-wide rate from a generator rather than summing it', () => {
    const f = mergeSummaries([input(0, gen(0)), input(1, gen(1))], 2);
    expect(f.rate).toEqual({ requested_eps: 5000, achieved_eps: 5000, delta_pct: 0 });
  });

  it('throws when no generator produced a summary', () => {
    expect(() => mergeSummaries([input(0, null, 107), input(1, null, 107)], 2)).toThrow(/no generator/i);
  });
});

describe('mergeSummaries — counts, rates and trends', () => {
  it('sums counts, passes and fails, and recomputes the failure rate from them', () => {
    const a = gen(0, { metrics: { ...gen(0).metrics, send_failures: { rate: 1, passes: 0, fails: 1 } } });
    const b = gen(1, { metrics: { ...gen(1).metrics, send_failures: { rate: 0, passes: 9, fails: 0 } } });
    const f = mergeSummaries([input(0, a), input(1, b)], 2);
    expect(f.metrics.events_sent.count).toBe(2000);
    expect(f.metrics.events_attempted.count).toBe(2001);
    expect(f.metrics.send_failures.passes).toBe(9);
    expect(f.metrics.send_failures.fails).toBe(1);
    expect(f.metrics.send_failures.rate).toBeCloseTo(0.1, 6);
  });

  it('takes min of min, max of max, and the worst generator for every other trend stat', () => {
    const f = mergeSummaries([input(0, gen(0)), input(1, gen(1))], 2);
    const d = f.metrics.send_duration;
    expect(d.min).toBe(1);
    expect(d.max).toBe(21);
    expect(d.avg).toBe(6);
    expect(d.med).toBe(5);
    expect(d['p(99)']).toBe(13);
    expect(f.fleet.aggregation.send_duration).toMatch(/max/i);
  });

  it('sums the per-type breakdown and keeps a null only when every generator has it null', () => {
    const f = mergeSummaries([input(0, gen(0)), input(1, gen(1))], 2);
    const t = f.types['json-app'];
    expect(t.events_sent).toBe(2000);
    expect(t.events_attempted).toBe(2001);
    expect(t.wire_bytes).toBe(10000);
    expect(t.send_duration?.['p(99)']).toBe(13);

    const nullWire = (i: number) => gen(i, { types: { 'json-app': { ...gen(i).types['json-app'], wire_bytes: null } } });
    expect(mergeSummaries([input(0, nullWire(0)), input(1, nullWire(1))], 2).types['json-app'].wire_bytes).toBeNull();

    const mixed = mergeSummaries([input(0, nullWire(0)), input(1, gen(1))], 2);
    expect(mixed.types['json-app'].wire_bytes).toBe(5000);
    expect(mixed.warnings.join(' ')).toMatch(/wire_bytes/);
  });
});

describe('mergeSummaries — verdicts', () => {
  it('a threshold is ok only when it is ok on every generator', () => {
    const bad = gen(1, { thresholds: { slo: [{ ok: false, metric: 'send_failures', expression: 'rate<0.001' }], structural_count: 6 } });
    const f = mergeSummaries([input(0, gen(0)), input(1, bad)], 2);
    expect(f.thresholds.slo).toEqual([{ ok: false, metric: 'send_failures', expression: 'rate<0.001' }]);
    expect(f.thresholds.structural_count).toBe(6);
    expect(f.verdict_from).toEqual(['send_failures rate<0.001']);
  });

  it('validity is the AND of the generators, with every reason kept and attributed', () => {
    const bad = gen(1, { validity: { dropped_iterations: 4, generator_cpu: null, valid: false, reasons: ['generator dropped 4 iterations'] } });
    const f = mergeSummaries([input(0, gen(0)), input(1, bad)], 2);
    expect(f.validity.valid).toBe(false);
    expect(f.validity.dropped_iterations).toBe(4);
    expect(f.validity.reasons).toEqual(['gen-1: generator dropped 4 iterations']);
    expect(f.validity.generator_cpu).toBeNull();
  });

  it('a generator with no summary invalidates the fleet and is named with its exit code', () => {
    const f = mergeSummaries([input(0, gen(0, {}, 3)), input(1, null, 107), input(2, gen(2, {}, 3))], 3);
    expect(f.fleet.generators_reported).toBe(2);
    expect(f.validity.valid).toBe(false);
    expect(f.validity.reasons.join(' ')).toMatch(/gen-1 produced no summary\.json \(exit 107\)/);
    expect(f.metrics.events_sent.count).toBe(2000);
  });

  it('breaks the fleet down per generator so an unhealthy one stays visible', () => {
    const bad = gen(1, { validity: { dropped_iterations: 4, generator_cpu: null, valid: false, reasons: ['dropped'] } });
    const f = mergeSummaries([input(0, gen(0), 0), input(1, bad, 99), input(2, null, 1)], 3);
    expect(f.fleet.generators.map((g) => [g.gen_index, g.exit_code, g.summary_present, g.valid])).toEqual([
      [0, 0, true, true],
      [1, 99, true, false],
      [2, 1, false, false],
    ]);
    expect(f.fleet.generators[1].dropped_iterations).toBe(4);
    expect(f.fleet.generators[1].events_sent).toBe(1000);
    expect(f.fleet.generators[1].send_duration_p99).toBe(13);
    expect(f.fleet.generators[2].events_sent).toBe(0);
  });
});

describe('mergeSummaries — warnings and samples', () => {
  it('collapses a warning every generator emitted into one line, and attributes the rest', () => {
    const b = gen(1, { warnings: ['shared warning', 'only on one'] });
    const f = mergeSummaries([input(0, gen(0)), input(1, b)], 2);
    expect(f.warnings.filter((w) => w === 'shared warning')).toHaveLength(1);
    expect(f.warnings).toContain('gen-1: only on one');
  });

  it('warns when generators disagree on run identity or configuration', () => {
    const other = gen(1, { run: { ...gen(1).run, run_id: 'someone-else' } });
    const f = mergeSummaries([input(0, gen(0)), input(1, other)], 2);
    expect(f.run.run_id).toBe('fleet-1');
    expect(f.warnings.join(' ')).toMatch(/disagree on run\.run_id/);

    const cfg = gen(1, { resolved_config: { name: 'different' } });
    expect(mergeSummaries([input(0, gen(0)), input(1, cfg)], 2).warnings.join(' ')).toMatch(/resolved_config/);
  });

  it('interleaves payload samples across generators and caps the total', () => {
    const many = (i: number) => gen(i, { payload_sample: Array.from({ length: 8 }, (_, k) => ({ g: i, k })) });
    const f = mergeSummaries([input(0, many(0)), input(1, many(1))], 2);
    expect(f.payload_sample).toHaveLength(10);
    expect(f.payload_sample.slice(0, 4)).toEqual([{ g: 0, k: 0 }, { g: 1, k: 0 }, { g: 0, k: 1 }, { g: 1, k: 1 }]);
  });
});
