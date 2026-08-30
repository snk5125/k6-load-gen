import { describe, it, expect, afterEach } from 'vitest';
import { profileName, readOverrides } from '../../src/config/env.ts';

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
    setEnv({ RUN_ID: 'r1', KNEE_EPS: '5000', DURATION_SCALE: '0.25' });
    const o = readOverrides();
    expect(o.run_id).toBe('r1');
    expect(o.knee_eps).toBe(5000);
    expect(o.duration_scale).toBe(0.25);
    expect(o.rate).toBeUndefined();
    expect(o.gen_index).toBeUndefined();
  });

  it('treats an empty string as unset', () => {
    setEnv({ KNEE_EPS: '' });
    expect(readOverrides().knee_eps).toBeUndefined();
  });

  // RATE=Infinity used to pass num(), pass resolveRun's `rate <= 0` check, and
  // reach resolveScenario — whose doc comment claims finite rates are enforced
  // upstream — producing Infinity stage targets and a NaN delta_pct.
  it('rejects Infinity', () => {
    setEnv({ RATE: 'Infinity' });
    expect(() => readOverrides()).toThrow(/RATE: expected a finite number, got "Infinity"/);
  });

  it('rejects -Infinity', () => {
    setEnv({ RATE: '-Infinity' });
    expect(() => readOverrides()).toThrow(/RATE: expected a finite number/);
  });

  it('rejects an overflowing literal that Number() turns into Infinity', () => {
    setEnv({ KNEE_EPS: '1e400' });
    expect(() => readOverrides()).toThrow(/KNEE_EPS: expected a finite number, got "1e400"/);
  });

  it('rejects non-numeric input', () => {
    setEnv({ KNEE_EPS: 'abc' });
    expect(() => readOverrides()).toThrow(/KNEE_EPS: expected a finite number, got "abc"/);
  });

  it('names the offending variable, so identical bad values differ', () => {
    setEnv({ DURATION_SCALE: 'abc' });
    expect(() => readOverrides()).toThrow(/DURATION_SCALE: expected a finite number, got "abc"/);
  });
});
