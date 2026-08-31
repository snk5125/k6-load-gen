import { describe, it, expect, afterEach } from 'vitest';
import { profileName, readOverrides, envPrefixFor, readTypeOverrides } from '../../src/config/env.ts';

// env.ts reads k6's `__ENV` init-context global as a free variable. Under
// vitest that resolves through globalThis, so the module is testable as-is by
// installing a stub — no indirection added to the module for the test's sake.
const setEnv = (env: Record<string, string | undefined>): void => {
  (globalThis as Record<string, unknown>).__ENV = env;
};

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__ENV;
});

describe('profileName', () => {
  it('returns PROFILE when set', () => {
    setEnv({ PROFILE: 'local-null' });
    expect(profileName()).toBe('local-null');
  });

  it('throws when PROFILE is missing', () => {
    setEnv({});
    expect(() => profileName()).toThrow(/PROFILE is required/);
  });
});

describe('readOverrides — numeric parsing', () => {
  it('parses finite numbers and leaves unset variables undefined', () => {
    setEnv({ RUN_ID: 'r1', DURATION_SCALE: '0.25' });
    const o = readOverrides();
    expect(o.run_id).toBe('r1');
    expect(o.duration_scale).toBe(0.25);
    expect(o.gen_index).toBeUndefined();
  });

  it('treats an empty string as unset', () => {
    setEnv({ GEN_COUNT: '' });
    expect(readOverrides().gen_count).toBeUndefined();
  });

  it('rejects Infinity', () => {
    setEnv({ DURATION_SCALE: 'Infinity' });
    expect(() => readOverrides()).toThrow(/DURATION_SCALE: expected a finite number, got "Infinity"/);
  });

  it('rejects -Infinity', () => {
    setEnv({ GEN_INDEX: '-Infinity' });
    expect(() => readOverrides()).toThrow(/GEN_INDEX: expected a finite number/);
  });

  it('rejects an overflowing literal that Number() turns into Infinity', () => {
    setEnv({ GEN_COUNT: '1e400' });
    expect(() => readOverrides()).toThrow(/GEN_COUNT: expected a finite number, got "1e400"/);
  });

  it('rejects non-numeric input', () => {
    setEnv({ DURATION_SCALE: 'abc' });
    expect(() => readOverrides()).toThrow(/DURATION_SCALE: expected a finite number, got "abc"/);
  });

  it('names the offending variable, so identical bad values differ', () => {
    setEnv({ GEN_INDEX: 'abc' });
    expect(() => readOverrides()).toThrow(/GEN_INDEX: expected a finite number, got "abc"/);
  });
});

describe('readOverrides — legacy global scenario/rate overrides are rejected', () => {
  // anchor and scenario now live per type (TypeConfig), so a bare SCENARIO,
  // RATE or KNEE_EPS no longer names an unambiguous target. Silently
  // ignoring them would be exactly the "mistyped variable does nothing"
  // failure class the <TYPE>_* surface exists to avoid.
  it('rejects a global SCENARIO override, naming the per-type replacement', () => {
    setEnv({ SCENARIO: 'spike' });
    expect(() => readOverrides()).toThrow(/SCENARIO.*no longer supported.*<TYPE>_SCENARIO/s);
  });

  it('rejects a global RATE override, naming the per-type replacement', () => {
    setEnv({ RATE: '5000' });
    expect(() => readOverrides()).toThrow(/RATE.*no longer supported.*<TYPE>_RATE/s);
  });

  it('rejects a global KNEE_EPS override, naming the per-type replacement', () => {
    setEnv({ KNEE_EPS: '5000' });
    expect(() => readOverrides()).toThrow(/KNEE_EPS.*no longer supported.*<TYPE>_KNEE_EPS/s);
  });

  it('does not throw when SCENARIO/RATE/KNEE_EPS are simply unset', () => {
    setEnv({ RUN_ID: 'r1' });
    expect(() => readOverrides()).not.toThrow();
  });
});

describe('envPrefixFor', () => {
  it('uppercases and replaces hyphens', () => {
    expect(envPrefixFor('nginx-access')).toBe('NGINX_ACCESS');
    expect(envPrefixFor('auditd')).toBe('AUDITD');
  });
});

describe('readTypeOverrides', () => {
  it('runs every profile type when TYPES is unset', () => {
    setEnv({});
    const r = readTypeOverrides(['auditd', 'cloudtrail']); // no __ENV.TYPES
    expect(r.active).toEqual(['auditd', 'cloudtrail']);
  });

  it('subsets to TYPES when it is set', () => {
    setEnv({ TYPES: 'auditd' });
    expect(readTypeOverrides(['auditd', 'cloudtrail']).active).toEqual(['auditd']);
  });

  it('throws naming the profile types when TYPES names an unknown one', () => {
    setEnv({ TYPES: 'auditdd' });
    expect(() => readTypeOverrides(['auditd'])).toThrow(/auditdd.*auditd/s);
  });

  it('reads a per-type rate through the prefix mapping', () => {
    setEnv({ NGINX_ACCESS_RATE: '20000' });
    expect(readTypeOverrides(['nginx-access']).overrides['nginx-access'].rate).toBe(20000);
  });

  it('warns when a TYPE_ variable is set for a type that is not active', () => {
    setEnv({ TYPES: 'auditd', CLOUDTRAIL_RATE: '500' });
    // A mistyped variable that silently does nothing is a known failure class here.
    const r = readTypeOverrides(['auditd', 'cloudtrail']);
    expect(r.warnings.join(' ')).toMatch(/CLOUDTRAIL_RATE.*not active/i);
  });

  it('throws on a non-numeric rate, naming the variable', () => {
    setEnv({ AUDITD_RATE: 'fast' });
    expect(() => readTypeOverrides(['auditd'])).toThrow(/AUDITD_RATE/);
  });

  it('throws when two profile types map to the same env prefix', () => {
    setEnv({});
    // 'a-b' and 'a_b' both map to A_B — ambiguous, and silently wrong if allowed.
    expect(() => readTypeOverrides(['a-b', 'a_b'])).toThrow(/A_B/);
  });

  it('reads a per-type scenario and batch_size override', () => {
    setEnv({ AUDITD_SCENARIO: 'spike', AUDITD_BATCH_SIZE: '25' });
    const r = readTypeOverrides(['auditd']);
    expect(r.overrides.auditd.scenario).toBe('spike');
    expect(r.overrides.auditd.batch_size).toBe(25);
  });

  it('reads a per-type knee_eps override', () => {
    setEnv({ AUDITD_KNEE_EPS: '3000' });
    expect(readTypeOverrides(['auditd']).overrides.auditd.knee_eps).toBe(3000);
  });

  it('produces no warnings and empty overrides when nothing is set', () => {
    setEnv({});
    const r = readTypeOverrides(['auditd', 'cloudtrail']);
    expect(r.warnings).toEqual([]);
    expect(r.overrides).toEqual({});
  });

  it('ignores an empty TYPES string the same as unset', () => {
    setEnv({ TYPES: '' });
    expect(readTypeOverrides(['auditd', 'cloudtrail']).active).toEqual(['auditd', 'cloudtrail']);
  });

  it('throws when TYPES is set but names nothing (e.g. a bare comma)', () => {
    // A profile that runs nothing is a configuration error, not an empty
    // run — same rule schema.ts enforces on an empty "types" map. TYPES=","
    // passes the "is it the empty string" check but resolves to zero names.
    setEnv({ TYPES: ',' });
    expect(() => readTypeOverrides(['auditd', 'cloudtrail'])).toThrow(/TYPES/);
  });

  it('throws when TYPES names the same type twice', () => {
    // A duplicate would resolve into one k6 scenario (the map key can only
    // appear once) while every EPS/sample aggregate in main.ts would
    // double-count it — a silent, wrong number rather than a loud error.
    setEnv({ TYPES: 'auditd,auditd' });
    expect(() => readTypeOverrides(['auditd', 'cloudtrail'])).toThrow(/auditd/);
  });

  it('warns on a typo in a per-type prefix that matches no declared type', () => {
    // CLOUDTRAILL_RATE (double L) — the not-active check above only covers
    // a KNOWN type's prefix while inactive; this is the other half: a
    // prefix that matches no declared type at all, which is the likelier
    // typo to actually make.
    setEnv({ CLOUDTRAILL_RATE: '500' });
    const r = readTypeOverrides(['cloudtrail']);
    expect(r.warnings.join(' ')).toMatch(/CLOUDTRAILL_RATE/);
  });

  it('does not warn about a variable whose prefix legitimately matches a declared type', () => {
    setEnv({ AUDITD_RATE: '5000' });
    const r = readTypeOverrides(['auditd']);
    expect(r.warnings).toEqual([]);
  });
});
