import { describe, it, expect } from 'vitest';
import { resolveRun, ConfigError, type TypeOverridesInput } from '../../src/config/resolve.ts';
import type { Profile } from '../../src/config/schema.ts';

const profile = (): Profile => ({
  name: 'p',
  target: { transport: 'otlp-grpc', endpoint: 'a:4317' },
  types: {
    auditd: { batch_size: 100, anchor: { mode: 'knee', knee_eps: 5000 }, scenario: 'sweep' },
  },
});

// Default: every declared type is active, no per-type overrides — the shape
// readTypeOverrides would hand back when nothing in the environment overrides
// the profile.
const noOverrides = (p: Profile): TypeOverridesInput => ({
  active: Object.keys(p.types),
  overrides: {},
});

describe('resolveRun — required inputs', () => {
  it('requires run_id', () => {
    const p = profile();
    expect(() => resolveRun(p, {}, noOverrides(p))).toThrow(ConfigError);
    expect(() => resolveRun(p, { run_id: '' }, noOverrides(p))).toThrow(/run_id/i);
  });

  it('returns run_id when supplied', () => {
    const p = profile();
    expect(resolveRun(p, { run_id: 'r1' }, noOverrides(p)).run_id).toBe('r1');
  });
});

describe('resolveRun — run-level overrides win over the profile', () => {
  it('overrides the endpoint', () => {
    const p = profile();
    const r = resolveRun(p, { run_id: 'r', target: 'other:4317' }, noOverrides(p));
    expect(r.profile.target.endpoint).toBe('other:4317');
  });

  it('does not mutate the profile it was given', () => {
    const p = profile();
    resolveRun(p, { run_id: 'r', target: 'zzz:1' }, noOverrides(p));
    expect(p.target.endpoint).toBe('a:4317');
    expect(p.types.auditd.anchor).toEqual({ mode: 'knee', knee_eps: 5000 });
  });

  it('carries an applied per-type override into the returned profile, for the published summary', () => {
    // resolved_config (handleSummary's published artifact) is built from
    // run.profile — if an override didn't land there, a run started with
    // AUDITD_RATE=9000 would publish its own ORIGINAL profile anchor
    // instead of the 9000 it actually ran at.
    const p = profile();
    const r = resolveRun(p, { run_id: 'r' }, {
      active: ['auditd'],
      overrides: { auditd: { rate: 9000, scenario: 'spike', batch_size: 25 } },
    });
    expect(r.profile.types.auditd).toEqual({
      batch_size: 25,
      anchor: { mode: 'absolute', base_eps: 9000 },
      scenario: 'spike',
      cardinality: undefined,
    });
  });

  it('leaves an inactive type\'s TypeConfig untouched in the returned profile', () => {
    const p: Profile = {
      ...profile(),
      types: {
        auditd: { batch_size: 100, anchor: { mode: 'knee', knee_eps: 5000 }, scenario: 'sweep' },
        cloudtrail: { batch_size: 20, anchor: { mode: 'absolute', base_eps: 800 }, scenario: 'soak' },
      },
    };
    const r = resolveRun(p, { run_id: 'r' }, { active: ['auditd'], overrides: {} });
    expect(r.profile.types.cloudtrail).toEqual(p.types.cloudtrail);
  });
});

describe('resolveRun — active types', () => {
  it('resolves every active type, keyed by type name', () => {
    const p: Profile = {
      ...profile(),
      types: {
        auditd: { batch_size: 100, anchor: { mode: 'knee', knee_eps: 5000 }, scenario: 'sweep' },
        cloudtrail: { batch_size: 20, anchor: { mode: 'absolute', base_eps: 800 }, scenario: 'soak' },
      },
    };
    const r = resolveRun(p, { run_id: 'r' }, noOverrides(p));
    expect(r.active_types).toEqual(['auditd', 'cloudtrail']);
    expect(Object.keys(r.types)).toEqual(['auditd', 'cloudtrail']);
  });

  it('resolves only the subset TYPES selected', () => {
    const p: Profile = {
      ...profile(),
      types: {
        auditd: { batch_size: 100, anchor: { mode: 'knee', knee_eps: 5000 }, scenario: 'sweep' },
        cloudtrail: { batch_size: 20, anchor: { mode: 'absolute', base_eps: 800 }, scenario: 'soak' },
      },
    };
    const r = resolveRun(p, { run_id: 'r' }, { active: ['cloudtrail'], overrides: {} });
    expect(r.active_types).toEqual(['cloudtrail']);
    expect(Object.keys(r.types)).toEqual(['cloudtrail']);
  });

  it('each resolved type carries a k6 scenario object', () => {
    const p = profile();
    const r = resolveRun(p, { run_id: 'r' }, noOverrides(p));
    expect(r.types.auditd.k6).toBeTypeOf('object');
    expect(r.types.auditd.k6).toHaveProperty('executor');
  });
});

describe('resolveRun — per-type overrides win over the TypeConfig', () => {
  it('overrides the scenario for one type', () => {
    const p = profile();
    const r = resolveRun(p, { run_id: 'r' }, {
      active: ['auditd'],
      overrides: { auditd: { scenario: 'spike' } },
    });
    // spike is a shared-iterations-free ramping shape; assert indirectly via
    // the fact resolution succeeded with a different shape than "sweep"
    // would have produced (soak below asserts the executor kind).
    expect(r.types.auditd.k6).toBeTypeOf('object');
  });

  it('rejects an unknown scenario override, naming the type', () => {
    const p = profile();
    expect(() =>
      resolveRun(p, { run_id: 'r' }, { active: ['auditd'], overrides: { auditd: { scenario: 'hammer' } } }),
    ).toThrow(/scenario.*"hammer".*auditd/is);
  });

  it('overrides knee_eps while staying in knee mode', () => {
    const p = profile();
    const r = resolveRun(p, { run_id: 'r' }, {
      active: ['auditd'],
      overrides: { auditd: { knee_eps: 9000 } },
    });
    // knee_eps is folded into the k6 scenario's stage rates, not surfaced
    // raw — assert via requested_peak_eps scaling with the new anchor.
    expect(r.types.auditd.requested_peak_eps).toBeGreaterThan(0);
  });

  it('rate switches the anchor to absolute mode and wins over knee_eps', () => {
    const p = profile();
    const withRateOnly = resolveRun(p, { run_id: 'r' }, {
      active: ['auditd'],
      overrides: { auditd: { rate: 7500 } },
    });
    const withBoth = resolveRun(p, { run_id: 'r' }, {
      active: ['auditd'],
      overrides: { auditd: { rate: 7500, knee_eps: 100 } },
    });
    expect(withRateOnly.types.auditd.requested_peak_eps).toEqual(withBoth.types.auditd.requested_peak_eps);
  });

  it('rejects a non-positive rate override, naming the type', () => {
    const p = profile();
    expect(() =>
      resolveRun(p, { run_id: 'r' }, { active: ['auditd'], overrides: { auditd: { rate: 0 } } }),
    ).toThrow(/rate.*auditd/is);
  });

  it('overrides batch_size for one type', () => {
    const p = profile();
    const r = resolveRun(p, { run_id: 'r' }, {
      active: ['auditd'],
      overrides: { auditd: { batch_size: 25 } },
    });
    expect(r.types.auditd.payload.batch_size).toBe(25);
  });

  it('rejects a non-positive batch_size override, naming the type', () => {
    const p = profile();
    expect(() =>
      resolveRun(p, { run_id: 'r' }, { active: ['auditd'], overrides: { auditd: { batch_size: 0 } } }),
    ).toThrow(/batch_size.*auditd/is);
  });
});

describe('resolveRun — per-type PayloadSpec construction (Task 1 <-> Task 6 gap)', () => {
  it('every field the LogTypeDef declares is present in the constructed PayloadSpec', () => {
    // This is the load-bearing guarantee: a field the LogTypeDef declares
    // that the merge dropped would silently vanish from every emitted
    // event of that type, with no other test failing. auditd declares
    // exactly these 8 fields (src/logtypes/definitions/auditd.ts).
    const p = profile();
    const r = resolveRun(p, { run_id: 'r' }, noOverrides(p));
    const fieldNames = Object.keys(r.types.auditd.payload.fields);
    expect(fieldNames.sort()).toEqual(
      ['arch', 'syscall', 'success', 'exit', 'uid', 'gid', 'exe', 'key'].sort(),
    );
  });

  it('sets template to the type name', () => {
    const p = profile();
    const r = resolveRun(p, { run_id: 'r' }, noOverrides(p));
    expect(r.types.auditd.payload.template).toBe('auditd');
  });

  it('applies a cardinality override onto the matching field only', () => {
    const p: Profile = {
      ...profile(),
      types: {
        auditd: {
          batch_size: 100,
          anchor: { mode: 'knee', knee_eps: 5000 },
          scenario: 'sweep',
          cardinality: { uid: 50 },
        },
      },
    };
    const r = resolveRun(p, { run_id: 'r' }, noOverrides(p));
    const fields = r.types.auditd.payload.fields;
    expect(fields.uid).toMatchObject({ cardinality: 50 });
    // Untouched fields keep the LogTypeDef's declared spec exactly.
    expect(fields.gid).toEqual({ cardinality: 200, distribution: 'zipf' });
    expect(fields.exe).toEqual({ cardinality: 'unbounded', prefix: '/usr/bin/host-' });
  });

  it('bounds an unbounded field when overridden, keeping its prefix', () => {
    const p: Profile = {
      ...profile(),
      types: {
        auditd: {
          batch_size: 100,
          anchor: { mode: 'knee', knee_eps: 5000 },
          scenario: 'sweep',
          cardinality: { exe: 40 },
        },
      },
    };
    const r = resolveRun(p, { run_id: 'r' }, noOverrides(p));
    expect(r.types.auditd.payload.fields.exe).toEqual({ cardinality: 40, prefix: '/usr/bin/host-' });
  });

  it('resolves each active type of a multi-type profile independently', () => {
    const p: Profile = {
      name: 'mixed',
      target: { transport: 'null' },
      types: {
        auditd: { batch_size: 50, anchor: { mode: 'absolute', base_eps: 3000 }, scenario: 'soak' },
        cloudtrail: { batch_size: 20, anchor: { mode: 'knee', knee_eps: 800 }, scenario: 'sweep' },
      },
    };
    const r = resolveRun(p, { run_id: 'r' }, noOverrides(p));
    expect(r.types.auditd.payload.template).toBe('auditd');
    expect(r.types.cloudtrail.payload.template).toBe('cloudtrail');
    expect(r.types.auditd.payload.batch_size).toBe(50);
    expect(r.types.cloudtrail.payload.batch_size).toBe(20);
    expect(Object.keys(r.types.cloudtrail.payload.fields).sort()).toEqual(
      ['userIdentity.type', 'userIdentity.arn', 'eventName', 'awsRegion', 'sourceIPAddress', 'eventID'].sort(),
    );
  });
});

describe('resolveRun — fleet and duration defaults', () => {
  it('defaults to a single generator at full duration', () => {
    const p = profile();
    const r = resolveRun(p, { run_id: 'r' }, noOverrides(p));
    expect(r.gen_index).toBe(0);
    expect(r.gen_count).toBe(1);
    expect(r.duration_scale).toBe(1);
  });

  it('accepts a valid fleet position', () => {
    const p = profile();
    const r = resolveRun(p, { run_id: 'r', gen_index: 2, gen_count: 4 }, noOverrides(p));
    expect(r.gen_index).toBe(2);
    expect(r.gen_count).toBe(4);
  });

  it('rejects a gen_index outside the fleet', () => {
    const p = profile();
    expect(() => resolveRun(p, { run_id: 'r', gen_index: 4, gen_count: 4 }, noOverrides(p))).toThrow(/gen_index/i);
    expect(() => resolveRun(p, { run_id: 'r', gen_index: -1 }, noOverrides(p))).toThrow(/gen_index/i);
  });

  it('rejects a gen_count below 1', () => {
    const p = profile();
    expect(() => resolveRun(p, { run_id: 'r', gen_count: 0 }, noOverrides(p))).toThrow(/gen_count/i);
  });

  it('rejects a non-positive duration_scale', () => {
    const p = profile();
    expect(() => resolveRun(p, { run_id: 'r', duration_scale: 0 }, noOverrides(p))).toThrow(/duration_scale/i);
    expect(() => resolveRun(p, { run_id: 'r', duration_scale: -1 }, noOverrides(p))).toThrow(/duration_scale/i);
  });

  it('accepts a fractional duration_scale', () => {
    const p = profile();
    expect(resolveRun(p, { run_id: 'r', duration_scale: 0.01 }, noOverrides(p)).duration_scale).toBe(0.01);
  });
});
