import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { exitCodePrecedence, fleetExitCode, isFleetSummary, mergeSummaries, type GeneratorInput } from '../../src/fleet/merge.ts';
import type { RunSummary } from '../../src/summary/build.ts';

/** Captured live from k6 v2.2.0 (see the fixture's own `_produced_by` note):
 * a Rate metric fed add(true) x1, add(false) x9 -> {passes:1, fails:9, rate:0.1}. */
const rateFixture: { passes: number; fails: number; rate: number } = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'k6-rate-metric.json'), 'utf8'),
);

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
      // Healthy generator: no failed sends. passes = failed sends (0), fails = successful sends (10).
      send_failures: { rate: 0, passes: 0, fails: 10 },
      send_errors: { count: 0, rate: 0 },
      dropped_iterations: { count: 0, rate: 0 },
      send_duration: { avg: 5 + i, min: 1, med: 4 + i, max: 20 + i, 'p(90)': 8 + i, 'p(95)': 9 + i, 'p(99)': 12 + i },
    },
    types: {
      'json-app': { events_attempted: 1000 + i, events_sent: 1000, send_failures: 0, send_duration: { 'p(99)': 12 + i }, wire_bytes: 5000, send_errors: 0, events_rejected: 0 },
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

describe('mergeSummaries — Rate metric semantics (send_failures)', () => {
  // Ground truth captured live from k6 v2.2.0 (tests/fleet/fixtures/k6-rate-metric.json):
  // a Rate fed add(true) x1, add(false) x9 reports {passes:1, fails:9, rate:0.1}. src/main.ts
  // calls sendFailures.add(!res.ok), so `passes` counts FAILED sends and `fails` counts
  // successful sends: rate = passes / (passes + fails), NOT fails / (passes + fails).
  const withSendFailures = (i: number, sf: { rate: number; passes: number; fails: number }) =>
    gen(i, { metrics: { ...gen(i).metrics, send_failures: sf } });

  it('merges two generators matching the captured fixture to the fixture rate (0.1)', () => {
    const a = withSendFailures(0, rateFixture);
    const b = withSendFailures(1, rateFixture);
    const f = mergeSummaries([input(0, a), input(1, b)], 2);
    expect(f.metrics.send_failures.passes).toBe(2);
    expect(f.metrics.send_failures.fails).toBe(18);
    expect(f.metrics.send_failures.rate).toBeCloseTo(0.1, 6);
  });

  it('weights the merged rate by sample count: {1,9} + {0,10} -> 1/20 = 0.05', () => {
    const a = withSendFailures(0, rateFixture); // {passes:1, fails:9, rate:0.1}
    const b = withSendFailures(1, { rate: 0, passes: 0, fails: 10 });
    const f = mergeSummaries([input(0, a), input(1, b)], 2);
    expect(f.metrics.send_failures.passes).toBe(1);
    expect(f.metrics.send_failures.fails).toBe(19);
    expect(f.metrics.send_failures.rate).toBeCloseTo(0.05, 6);
  });

  it('two fully healthy generators ({0,10} each) merge to rate 0', () => {
    const a = withSendFailures(0, { rate: 0, passes: 0, fails: 10 });
    const b = withSendFailures(1, { rate: 0, passes: 0, fails: 10 });
    const f = mergeSummaries([input(0, a), input(1, b)], 2);
    expect(f.metrics.send_failures.rate).toBe(0);
  });

  it('two fully failing generators ({10,0} each) merge to rate 1', () => {
    const a = withSendFailures(0, { rate: 1, passes: 10, fails: 0 });
    const b = withSendFailures(1, { rate: 1, passes: 10, fails: 0 });
    const f = mergeSummaries([input(0, a), input(1, b)], 2);
    expect(f.metrics.send_failures.rate).toBe(1);
  });
});

describe('mergeSummaries — counts, rates and trends', () => {
  it('sums counts, passes and fails, and recomputes the failure rate from them', () => {
    // passes = failed sends, fails = successful sends (see the fixture note above).
    const a = gen(0, { metrics: { ...gen(0).metrics, send_failures: { rate: 1, passes: 1, fails: 0 } } });
    const b = gen(1, { metrics: { ...gen(1).metrics, send_failures: { rate: 0, passes: 0, fails: 9 } } });
    const f = mergeSummaries([input(0, a), input(1, b)], 2);
    expect(f.metrics.events_sent.count).toBe(2000);
    expect(f.metrics.events_attempted.count).toBe(2001);
    expect(f.metrics.send_failures.passes).toBe(1);
    expect(f.metrics.send_failures.fails).toBe(9);
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

  it('still warns (only) about a k6 version disagreement', () => {
    const other = gen(1, { run: { ...gen(1).run, k6_version: 'v2.1.0' } });
    const f = mergeSummaries([input(0, gen(0)), input(1, other)], 2);
    expect(f.run.k6_version).toBe('v2.2.0');
    expect(f.warnings.join(' ')).toMatch(/disagree on run\.k6_version/);
    expect(f.validity.valid).toBe(true);
  });

  it('interleaves payload samples across generators and caps the total', () => {
    const many = (i: number) => gen(i, { payload_sample: Array.from({ length: 8 }, (_, k) => ({ g: i, k })) });
    const f = mergeSummaries([input(0, many(0)), input(1, many(1))], 2);
    expect(f.payload_sample).toHaveLength(10);
    expect(f.payload_sample.slice(0, 4)).toEqual([{ g: 0, k: 0 }, { g: 1, k: 0 }, { g: 0, k: 1 }, { g: 1, k: 1 }]);
  });
});

describe('fleetExitCode — the precedence bin/run.sh applies, available to every consumer', () => {
  const ok = (i: number) => input(i, gen(i, {}, 3), 0);
  it('all clean -> 0', () => expect(fleetExitCode([ok(0), ok(1), ok(2)])).toBe(0));
  it('one threshold breach -> 99', () => expect(fleetExitCode([ok(0), input(1, gen(1, {}, 3), 99), ok(2)])).toBe(99));
  it('a crash beats a threshold breach: 107 + 99 -> 107', () =>
    expect(fleetExitCode([input(0, null, 107), input(1, gen(1, {}, 3), 99), ok(2)])).toBe(107));
  it('among crashes the lowest generator index wins', () =>
    expect(fleetExitCode([input(2, null, 3), input(0, null, 107), ok(1)])).toBe(107));
  it('a claimed success with no summary, or no recorded code, counts as 1', () => {
    expect(fleetExitCode([ok(0), input(1, null, 0)])).toBe(1);
    expect(fleetExitCode([ok(0), input(1, null, null)])).toBe(1);
  });
  it('is carried on the merged summary', () => {
    const f = mergeSummaries([ok(0), input(1, gen(1, {}, 3), 99), ok(2)], 3);
    expect(f.fleet.exit_code).toBe(99);
  });
});

describe('exitCodePrecedence — the rule over bare codes', () => {
  it('crash beats 99 beats 0; unknown counts as 1; lowest index wins among crashes', () => {
    expect(exitCodePrecedence([0, 0])).toBe(0);
    expect(exitCodePrecedence([0, 99, 0])).toBe(99);
    expect(exitCodePrecedence([99, 137, 0])).toBe(137);
    expect(exitCodePrecedence([3, 107])).toBe(3);
    expect(exitCodePrecedence([0, null])).toBe(1);
  });
});

describe('isFleetSummary', () => {
  it('accepts only an object with a non-null object fleet block', () => {
    expect(isFleetSummary(mergeSummaries([input(0, gen(0, {}, 1))], 1))).toBe(true);
    expect(isFleetSummary(gen(0))).toBe(false);
    expect(isFleetSummary({ fleet: null })).toBe(false);
    expect(isFleetSummary({ fleet: 'yes' })).toBe(false);
    expect(isFleetSummary(null)).toBe(false);
  });
});

describe('mergeSummaries — fleet identity (hard errors)', () => {
  // A hard error throws BEFORE anything is written: a fleet whose members are not
  // the same run is not a measurement, and cli.ts writes nothing on a throw.
  it('throws when reporting generators disagree on run_id', () => {
    const other = gen(1, { run: { ...gen(1).run, run_id: 'someone-else' } });
    expect(() => mergeSummaries([input(0, gen(0)), input(1, other)], 2)).toThrow(
      /run\.run_id.*gen-0=.*fleet-1.*gen-1=.*someone-else/,
    );
  });

  it('throws when reporting generators disagree on schema_version', () => {
    expect(() => mergeSummaries([input(0, gen(0)), input(1, gen(1, { schema_version: 3 }))], 2)).toThrow(
      /schema_version/,
    );
  });

  it('throws when a summary carries a gen_index that is not its directory index', () => {
    const mislabelled = gen(1, { generator: { gen_index: 0, gen_count: 2 } });
    expect(() => mergeSummaries([input(0, gen(0)), input(1, mislabelled)], 2)).toThrow(
      /gen-1.*generator\.gen_index 0/,
    );
  });

  it('throws on a duplicate generator index', () => {
    expect(() => mergeSummaries([input(0, gen(0)), input(0, gen(0))], 2)).toThrow(/duplicate generator index.*gen-0/);
  });

  it('throws when a generator index is outside the fleet', () => {
    expect(() => mergeSummaries([input(0, gen(0)), input(3, gen(3))], 2)).toThrow(/gen-3.*fleet of 2/);
    // the check covers a generator that produced nothing, too
    expect(() => mergeSummaries([input(0, gen(0)), input(3, null, 107)], 2)).toThrow(/gen-3.*fleet of 2/);
  });
});

describe('mergeSummaries — fleet identity (soft: invalid, still merged)', () => {
  const reasonsOf = (f: ReturnType<typeof mergeSummaries>) => f.validity.reasons.join(' | ');

  it('marks the fleet invalid when a generator was configured for a different gen_count', () => {
    const f = mergeSummaries([input(0, gen(0)), input(1, gen(1, { generator: { gen_index: 1, gen_count: 3 } }))], 2);
    expect(f.validity.valid).toBe(false);
    expect(reasonsOf(f)).toMatch(/fleet members disagree on configuration: generator\.gen_count/);
    expect(reasonsOf(f)).toMatch(/gen-1=3/);
    // evidence is still merged
    expect(f.metrics.events_sent.count).toBe(2000);
  });

  it('treats generators that all declare a larger fleet than was supplied as an incomplete fleet of that size', () => {
    // Two of five: the merge adopts the declared size and the three unsupplied
    // indexes become generators with no summary — a subset merge, not a fault.
    const f = mergeSummaries([input(0, gen(0, {}, 5)), input(1, gen(1, {}, 5))], 2);
    expect(f.validity.valid).toBe(false);
    expect(f.fleet.generator_count).toBe(5);
    expect(f.fleet.generators_reported).toBe(2);
    expect(reasonsOf(f)).not.toMatch(/generator\.gen_count/);
    for (const i of [2, 3, 4]) expect(reasonsOf(f)).toMatch(new RegExp(`gen-${i} produced no summary`));
  });

  it('marks the fleet invalid when generators disagree on active_types', () => {
    const other = gen(1, { run: { ...gen(1).run, active_types: ['syslog-app'] } });
    const f = mergeSummaries([input(0, gen(0)), input(1, other)], 2);
    expect(f.validity.valid).toBe(false);
    expect(reasonsOf(f)).toMatch(/fleet members disagree on configuration: run\.active_types/);
    expect(reasonsOf(f)).toMatch(/gen-1/);
  });

  it('marks the fleet invalid when generators disagree on resolved_config', () => {
    const f = mergeSummaries([input(0, gen(0)), input(1, gen(1, { resolved_config: { name: 'different' } }))], 2);
    expect(f.validity.valid).toBe(false);
    expect(reasonsOf(f)).toMatch(/fleet members disagree on configuration: resolved_config/);
    expect(reasonsOf(f)).toMatch(/gen-1/);
    expect(f.resolved_config).toEqual(gen(0).resolved_config);
  });

  it('compares resolved_config canonically: key order and nesting order never matter', () => {
    const a = gen(0, { resolved_config: { name: 'p', target: { transport: 'null', tls: false }, types: { a: { scenario: 'sweep' }, b: { scenario: 'smoke' } } } });
    const b = gen(1, { resolved_config: { types: { b: { scenario: 'smoke' }, a: { scenario: 'sweep' } }, target: { tls: false, transport: 'null' }, name: 'p' } });
    const f = mergeSummaries([input(0, a), input(1, b)], 2);
    expect(f.validity.valid).toBe(true);
    expect(reasonsOf(f)).not.toMatch(/resolved_config/);
  });

  it('no longer duplicates the identity checks as warnings', () => {
    const f = mergeSummaries([input(0, gen(0)), input(1, gen(1, { resolved_config: { name: 'different' } }))], 2);
    expect(f.warnings.join(' ')).not.toMatch(/disagree on resolved_config/);
  });
});

describe('mergeSummaries — timeline coverage', () => {
  it('is null when the caller said nothing about timelines', () => {
    expect(mergeSummaries([input(0, gen(0)), input(1, gen(1))], 2).fleet.timeline_coverage).toBeNull();
  });

  it('is complete when every reporting generator shipped a timeline', () => {
    const f = mergeSummaries([input(0, gen(0)), input(1, gen(1))], 2, { 0: true, 1: true });
    expect(f.fleet.timeline_coverage).toEqual({
      expected: 2, present: [0, 1], missing: [], complete: true, configured_off: false,
    });
    expect(f.warnings.join(' ')).not.toMatch(/timeline/);
  });

  it('names the missing generators and warns that the fleet timeline under-counts', () => {
    const f = mergeSummaries([input(0, gen(0, {}, 3)), input(1, gen(1, {}, 3)), input(2, gen(2, {}, 3))], 3, { 0: true, 1: false, 2: true });
    expect(f.fleet.timeline_coverage).toEqual({
      expected: 3, present: [0, 2], missing: [1], complete: false, configured_off: false,
    });
    expect(f.warnings.join(' ')).toMatch(/timeline coverage.*gen-1.*under-counts/);
  });

  it('is configured_off, and silent, when no generator has a timeline at all', () => {
    const f = mergeSummaries([input(0, gen(0)), input(1, gen(1))], 2, { 0: false, 1: false });
    expect(f.fleet.timeline_coverage).toEqual({
      expected: 2, present: [], missing: [0, 1], complete: false, configured_off: true,
    });
    expect(f.warnings.join(' ')).not.toMatch(/timeline coverage/);
  });

  it('expects a timeline only from generators that reported a summary', () => {
    const f = mergeSummaries([input(0, gen(0, {}, 2)), input(1, null, 107)], 2, { 0: true, 1: false });
    expect(f.fleet.timeline_coverage).toMatchObject({ expected: 1, present: [0], missing: [], complete: true });
  });

  it('warns when a complete timeline holds less than 90% of the summary events_sent', () => {
    // each generator sent 1000 -> 2000 in the fleet summary; the timeline holds 1700 (85%)
    const f = mergeSummaries([input(0, gen(0)), input(1, gen(1))], 2, { 0: true, 1: true }, 1700);
    expect(f.warnings.join(' ')).toMatch(/timeline.*1700.*2000/);
    expect(f.validity.valid).toBe(true); // a warning, never an error
  });

  it('does not warn at 90% or above, or when coverage is incomplete', () => {
    expect(mergeSummaries([input(0, gen(0)), input(1, gen(1))], 2, { 0: true, 1: true }, 1900).warnings.join(' '))
      .not.toMatch(/less than 90%|truncated/);
    // incomplete coverage already carries its own warning; the totals cannot be compared
    const partial = mergeSummaries([input(0, gen(0)), input(1, gen(1))], 2, { 0: true, 1: false }, 1000);
    expect(partial.warnings.join(' ')).not.toMatch(/truncated/);
  });
});

describe('mergeSummaries — integration of later work', () => {
  it('sums events_rejected per type like the other counts', () => {
    const withRejected = (i: number) => gen(i, { types: { 'json-app': { ...gen(i).types['json-app'], events_rejected: 5 + i } } });
    const f = mergeSummaries([input(0, withRejected(0)), input(1, withRejected(1))], 2);
    expect(f.types['json-app'].events_rejected).toBe(11);
  });

  it('treats a subset of a declared fleet as an incomplete fleet, not an error', () => {
    // gen-0 and gen-2 of a fleet of 3 (their summaries say gen_count 3); gen-1 was never supplied.
    const f = mergeSummaries([input(0, gen(0, {}, 3)), input(2, gen(2, {}, 3))], 2);
    expect(f.generator.gen_count).toBe(3);
    expect(f.fleet.generator_count).toBe(3);
    expect(f.fleet.generators_reported).toBe(2);
    expect(f.fleet.generators.map((g) => [g.gen_index, g.summary_present])).toEqual([[0, true], [1, false], [2, true]]);
    expect(f.validity.valid).toBe(false);
    expect(f.validity.reasons.join(' ')).toMatch(/gen-1 produced no summary\.json/);
  });
});
