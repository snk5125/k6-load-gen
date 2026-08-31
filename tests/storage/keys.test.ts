import { describe, it, expect } from 'vitest';
import { artifactKeys, indexRecord, partitionDate } from '../../src/storage/keys.ts';

const ref = { run_id: 'run-1', gen_index: 0, started_at: '2026-08-29T22:15:00.000Z' };

describe('partitionDate', () => {
  it('uses the UTC date of started_at', () => {
    expect(partitionDate('2026-08-29T22:15:00.000Z')).toBe('2026-08-29');
  });

  it('keeps a run that spans midnight in its START date partition', () => {
    // A 4-hour soak beginning at 22:00 UTC must not split across two partitions.
    expect(partitionDate('2026-08-29T22:00:00.000Z')).toBe('2026-08-29');
  });

  it('does not shift the date by local timezone', () => {
    expect(partitionDate('2026-08-29T01:00:00.000Z')).toBe('2026-08-29');
    expect(partitionDate('2026-08-29T23:59:59.999Z')).toBe('2026-08-29');
  });

  it('throws on an unparseable timestamp rather than emitting a NaN partition', () => {
    expect(() => partitionDate('not-a-date')).toThrow(/started_at/i);
  });
});

describe('artifactKeys', () => {
  it('puts index and timeline in date-partitioned prefixes', () => {
    const k = artifactKeys(ref, 'k6');
    expect(k.index).toBe('k6/index/dt=2026-08-29/run-1-gen0.json');
    expect(k.timeline).toBe('k6/timeline/dt=2026-08-29/run-1-gen0.jsonl');
  });

  it('puts per-run detail objects under runs/, not partitioned', () => {
    const k = artifactKeys(ref, 'k6');
    expect(k.summary).toBe('k6/runs/run-1/gen-0/summary.json');
    expect(k.run_log).toBe('k6/runs/run-1/gen-0/run.log');
    expect(k.raw).toBe('k6/runs/run-1/gen-0/raw.json.gz');
  });

  it('separates generators so a fleet cannot collide', () => {
    const a = artifactKeys({ ...ref, gen_index: 0 }, 'k6');
    const b = artifactKeys({ ...ref, gen_index: 1 }, 'k6');
    expect(a.index).not.toBe(b.index);
    expect(a.summary).not.toBe(b.summary);
  });

  it('handles an empty prefix without a leading slash', () => {
    expect(artifactKeys(ref, '').index).toBe('index/dt=2026-08-29/run-1-gen0.json');
  });

  it('normalises a prefix given with a trailing slash', () => {
    expect(artifactKeys(ref, 'k6/').index).toBe('k6/index/dt=2026-08-29/run-1-gen0.json');
  });

  it('rejects a run_id containing a slash, which would forge a key path', () => {
    expect(() => artifactKeys({ ...ref, run_id: 'a/b' }, 'k6')).toThrow(/run_id/i);
  });

  it('rejects an empty or whitespace-only run_id', () => {
    expect(() => artifactKeys({ ...ref, run_id: '' }, 'k6')).toThrow(/run_id/i);
    expect(() => artifactKeys({ ...ref, run_id: '  ' }, 'k6')).toThrow(/run_id/i);
  });

  it('rejects a run_id carrying a shell injection payload', () => {
    // RUN_ID reaches bin/run.sh's index-cli invocation as an env var. A
    // quote lets attacker text escape any shell-formatted output built from
    // run_id, whether eval'd or sourced — the allowlist must reject it
    // before a key is ever built, not merely fail to quote it correctly.
    expect(() =>
      artifactKeys({ ...ref, run_id: "r1'; touch pwned_marker; echo '" }, 'k6'),
    ).toThrow(/run_id/i);
  });

  it('rejects other shell metacharacters in run_id', () => {
    for (const bad of ['r1;r2', 'r1$(whoami)', 'r1`whoami`', 'r1|r2', 'r1&r2', 'r1 r2']) {
      expect(() => artifactKeys({ ...ref, run_id: bad }, 'k6')).toThrow(/run_id/i);
    }
  });

  it('accepts run ids shaped like the ones this project actually generates', () => {
    for (const ok of ['smoke-1', 'sweep-2.1a', 'wrap-fail', 'run_1', 'RUN.1-2_3']) {
      expect(() => artifactKeys({ ...ref, run_id: ok }, 'k6')).not.toThrow();
    }
  });
});

describe('indexRecord', () => {
  // A real post-branch resolved_config: `scenario` is no longer a top-level
  // key at all (schema.ts's validateProfile now REJECTS it — see the
  // legacy-shape check) — it lives per type under `types`. The old fixture
  // here (`resolved_config: { ..., scenario: 'sweep' }`) was a shape
  // validateProfile can no longer produce, which is exactly why the
  // `cfg.resolved_config.scenario` regression this fixture should have
  // caught went uncaught.
  const summary = {
    schema_version: 2,
    run: { run_id: 'run-1', started_at: '2026-08-29T22:15:00.000Z', ended_at: '2026-08-29T22:25:00.000Z', duration_sec: 600, k6_version: 'v2.2.0' },
    generator: { gen_index: 0, gen_count: 1 },
    rate: { requested_eps: 5000, achieved_eps: 5000, delta_pct: 0 },
    resolved_config: {
      name: 'otlp-grpc',
      target: { transport: 'otlp-grpc' },
      types: { auditd: { batch_size: 50, anchor: { mode: 'absolute', base_eps: 3000 }, scenario: 'sweep' } },
    },
    metrics: { events_sent: { count: 300000 }, events_attempted: { count: 300000 }, send_failures: { rate: 0 } },
    thresholds: {
      slo: [{ ok: true, metric: 'send_failures', expression: 'rate<0.001' }],
      structural_count: 6,
    },
    validity: { dropped_iterations: 0, generator_cpu: null, valid: true, reasons: [] },
  };

  it('is entirely flat — Athena cannot read a nested value here', () => {
    for (const v of Object.values(indexRecord(summary))) {
      expect(v === null || ['number', 'string', 'boolean'].includes(typeof v)).toBe(true);
    }
  });

  it('lifts the fields you would filter or sort a run list by', () => {
    const r = indexRecord(summary);
    expect(r.run_id).toBe('run-1');
    expect(r.profile).toBe('otlp-grpc');
    expect(r.transport).toBe('otlp-grpc');
    expect(r.scenario).toBe('sweep');
    expect(r.valid).toBe(true);
    expect(r.achieved_eps).toBe(5000);
    expect(r.events_sent).toBe(300000);
    expect(r.dropped_iterations).toBe(0);
    expect(r.schema_version).toBe(2);
  });

  // The regression this fixture used to hide: resolved_config.scenario is
  // no longer produced by any real profile (validateProfile rejects a
  // top-level `scenario` outright — see schema.ts), so the pre-fix reader
  // (`cfg.scenario as string`) read `undefined` on every real run and
  // reported `scenario: null` for every record in the operator-facing
  // index/ prefix. This fixture's `resolved_config.types.auditd.scenario`
  // is the only shape validateProfile can actually produce.
  it('reads scenario from resolved_config.types, not the no-longer-existent resolved_config.scenario', () => {
    const legacyShaped = {
      ...summary,
      resolved_config: { ...summary.resolved_config, scenario: 'sweep', types: undefined },
    };
    expect(indexRecord(legacyShaped).scenario).toBeNull();
  });

  it('joins every active type\'s scenario for a multi-type run, comma-separated', () => {
    const multiType = {
      ...summary,
      resolved_config: {
        ...summary.resolved_config,
        types: {
          auditd: { batch_size: 50, anchor: { mode: 'absolute', base_eps: 3000 }, scenario: 'soak' },
          cloudtrail: { batch_size: 20, anchor: { mode: 'knee', knee_eps: 800 }, scenario: 'sweep' },
          'nginx-access': { batch_size: 100, anchor: { mode: 'absolute', base_eps: 6000 }, scenario: 'spike' },
        },
      },
    };
    expect(indexRecord(multiType).scenario).toBe('soak,sweep,spike');
  });

  it('records whether any threshold failed, so a run list can filter on it', () => {
    expect(indexRecord(summary).thresholds_failed).toBe(0);
    const failed = {
      ...summary,
      thresholds: {
        slo: [{ ok: false, metric: 'a', expression: 'x<1' }, { ok: true, metric: 'b', expression: 'y<2' }],
        structural_count: 0,
      },
    };
    expect(indexRecord(failed).thresholds_failed).toBe(1);
  });

  // This is the regression Task 9 introduced and left uncaught: the old
  // fixture literal above never exercised a REAL failing summary.thresholds.slo
  // entry, so a `thresholds` reader still written for the pre-Task-9 flat
  // shape (`Object.values(thresholds).filter(t => t.ok === false)`) passed
  // every existing test here while silently reading `[sloArray, structural_count]`
  // off the new shape and always computing 0 failures.
  it('counts a failing SLO threshold even when structural thresholds are also present', () => {
    const withStructural = {
      ...summary,
      thresholds: {
        slo: [{ ok: false, metric: 'send_failures', expression: 'rate<0.001' }],
        // A real multi-type run's structural_count (never itself a failure)
        // must not be folded into thresholds_failed in either direction.
        structural_count: 18,
      },
    };
    expect(indexRecord(withStructural).thresholds_failed).toBe(1);
  });

  it('reads dropped_iterations from validity, not metrics', () => {
    // Fixture where validity and metrics sources differ
    const diffSources = {
      run: { run_id: 'x' },
      validity: { dropped_iterations: 3 },
      // Note: no metrics.dropped_iterations — test ensures it reads from validity
    };
    expect(indexRecord(diffSources).dropped_iterations).toBe(3);
  });

  it('keeps duration_sec as null when unparseable rather than coercing to 0', () => {
    const r = indexRecord({ run: { run_id: 'x', duration_sec: null } });
    expect(r.duration_sec).toBeNull();
  });

  it('survives a summary with missing sections rather than throwing', () => {
    const r = indexRecord({ run: { run_id: 'x' } });
    expect(r.run_id).toBe('x');
    expect(r.events_sent).toBe(0);
    expect(r.valid).toBeNull();
  });
});
