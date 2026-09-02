import { describe, it, expect } from 'vitest';
import { validateProfile } from '../../src/config/schema.ts';

const base = {
  name: 'otlp-grpc',
  target: { transport: 'otlp-grpc', endpoint: 'collector.example:4317', options: { plaintext: true } },
  types: {
    'json-app': {
      batch_size: 100,
      anchor: { mode: 'knee', knee_eps: 5000 },
      scenario: 'sweep',
    },
  },
  thresholds: { send_failures: 'rate<0.001' },
};

const validTypes = {
  auditd: { batch_size: 100, anchor: { mode: 'absolute', base_eps: 5000 }, scenario: 'soak' },
};

describe('validateProfile', () => {
  it('accepts a well-formed profile', () => {
    const r = validateProfile(base);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('rejects a non-object', () => {
    expect(validateProfile(null).ok).toBe(false);
    expect(validateProfile('nope').ok).toBe(false);
  });

  it('names the offending field in every error', () => {
    const r = validateProfile({ ...base, name: 42 });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/name/);
  });

  it('rejects an unknown transport and lists the valid ones', () => {
    const r = validateProfile({ ...base, target: { transport: 'carrier-pigeon', endpoint: 'x' } });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/otlp-grpc/);
  });

  it('requires an endpoint for every transport except null', () => {
    expect(validateProfile({ ...base, target: { transport: 'otlp-grpc' } }).ok).toBe(false);
    expect(validateProfile({ ...base, target: { transport: 'null' } }).ok).toBe(true);
  });

  it('rejects an unknown scenario name', () => {
    const r = validateProfile({
      ...base,
      types: { 'json-app': { ...base.types['json-app'], scenario: 'hammer' } },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/scenario/);
  });

  it('rejects a malformed anchor', () => {
    const withAnchor = (anchor: unknown) =>
      validateProfile({ ...base, types: { 'json-app': { ...base.types['json-app'], anchor } } });
    expect(withAnchor({ mode: 'knee' }).ok).toBe(false);
    expect(withAnchor({ mode: 'absolute', base_eps: 0 }).ok).toBe(false);
    expect(withAnchor({ mode: 'vibes', knee_eps: 1 }).ok).toBe(false);
  });

  it('accepts absolute anchors', () => {
    const r = validateProfile({
      ...base,
      types: { 'json-app': { ...base.types['json-app'], anchor: { mode: 'absolute', base_eps: 8000 } } },
    });
    expect(r.ok).toBe(true);
  });

  it('rejects non-string threshold expressions', () => {
    const r = validateProfile({ ...base, thresholds: { send_failures: 0.001 } });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/thresholds/);
  });

  it('collects every error rather than stopping at the first', () => {
    const r = validateProfile({ name: 1, target: {}, types: {}, scenario: 'x' });
    expect(r.errors.length).toBeGreaterThan(2);
  });
});

describe('validateProfile — types map', () => {
  it('accepts a profile with a types map', () => {
    expect(validateProfile({ ...base, types: validTypes }).ok).toBe(true);
  });

  it('rejects the legacy payload shape and names the replacement', () => {
    // Five committed profiles used the old shape; the message is the migration doc.
    const r = validateProfile({ ...base, payload: { template: 'json-app', batch_size: 10, fields: {} } });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/payload.*no longer supported.*types/i);
  });

  it('rejects a leftover top-level anchor even when a valid types map is present', () => {
    // A half-migrated profile — types added, but the old top-level anchor
    // never removed — must not validate silently: everything downstream
    // ignores that stale top-level anchor once "types" exists, so a
    // profile like this would quietly run a different rate than the one
    // still sitting (and readable) at the top level.
    const r = validateProfile({ ...base, anchor: { mode: 'absolute', base_eps: 100 } });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/anchor.*no longer supported.*types/i);
  });

  it('rejects a leftover top-level scenario even when a valid types map is present', () => {
    const r = validateProfile({ ...base, scenario: 'sweep' });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/scenario.*no longer supported.*types/i);
  });

  it('rejects a types map naming an unknown log type', () => {
    const r = validateProfile({ ...base, types: { auditdd: validTypes.auditd } });
    expect(r.errors.join(' ')).toMatch(/auditdd.*available.*auditd/s);
  });

  it('rejects an empty types map', () => {
    // A profile that runs nothing is a configuration error, not an empty run.
    expect(validateProfile({ ...base, types: {} }).ok).toBe(false);
  });

  it('rejects a cardinality override naming a field the type does not declare', () => {
    const r = validateProfile({ ...base, types: {
      auditd: { ...validTypes.auditd, cardinality: { not_a_field: 10 } },
    }});
    expect(r.errors.join(' ')).toMatch(/not_a_field/);
  });

  it('rejects a non-positive cardinality override', () => {
    const r = validateProfile({ ...base, types: {
      auditd: { ...validTypes.auditd, cardinality: { uid: 0 } },
    }});
    expect(r.ok).toBe(false);
  });

  it('collects an error per bad type rather than stopping at the first', () => {
    const r = validateProfile({ ...base, types: {
      auditd: { batch_size: 0, anchor: { mode: 'absolute', base_eps: 1 }, scenario: 'soak' },
      cloudtrail: { batch_size: 10, anchor: { mode: 'absolute', base_eps: 1 }, scenario: 'nope' },
    }});
    expect(r.errors.length).toBeGreaterThanOrEqual(2);
  });

  it('accepts a cardinality override on a field that supports one', () => {
    const r = validateProfile({ ...base, types: {
      auditd: { ...validTypes.auditd, cardinality: { uid: 50 } },
    }});
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('rejects a cardinality override on a field with a fixed values list', () => {
    // auditd's "success" field is { values: ['yes', 'no'] } — no numeric
    // cardinality to override. Silently accepting this would mean the
    // override never actually changes anything, the exact silent-drop
    // failure the merge in resolveRun is built to avoid.
    const r = validateProfile({ ...base, types: {
      auditd: { ...validTypes.auditd, cardinality: { success: 5 } },
    }});
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/success/);
  });

  it('rejects a batch_size that is not a positive integer', () => {
    for (const bad of [0, -5, 1.5]) {
      const r = validateProfile({ ...base, types: {
        auditd: { ...validTypes.auditd, batch_size: bad },
      }});
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/batch_size/);
    }
  });

  it('accepts a multi-type profile exercising several log types at once', () => {
    const r = validateProfile({
      ...base,
      types: {
        auditd: { batch_size: 50, anchor: { mode: 'absolute', base_eps: 3000 }, scenario: 'soak' },
        cloudtrail: { batch_size: 20, anchor: { mode: 'knee', knee_eps: 800 }, scenario: 'sweep' },
        'nginx-access': { batch_size: 100, anchor: { mode: 'absolute', base_eps: 6000 }, scenario: 'spike' },
      },
    });
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

describe('validateProfile — per-transport option validation', () => {
  it('rejects an option key the transport does not accept', () => {
    // The typo case this exists for: plaintxt silently did nothing before.
    const r = validateProfile({ ...base, target: { transport: 'otlp-grpc', endpoint: 'a:4317', options: { plaintxt: true } } });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/plaintxt/);
  });

  it('names the accepted keys so the operator can see the typo', () => {
    const r = validateProfile({ ...base, target: { transport: 'otlp-grpc', endpoint: 'a:4317', options: { plaintxt: true } } });
    expect(r.errors.join(' ')).toMatch(/plaintext/);
  });

  it('rejects a string where a boolean belongs', () => {
    const r = validateProfile({ ...base, target: { transport: 'otlp-grpc', endpoint: 'a:4317', options: { plaintext: 'true' } } });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/plaintext/);
  });

  it('rejects an out-of-range enum', () => {
    const r = validateProfile({ ...base, target: { transport: 'syslog', endpoint: 'a:514', options: { rfc: 9999 } } });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/rfc/);
  });

  it('rejects a non-boolean value for syslog tls — this guarantee is load-bearing for run-summary publication', () => {
    // tls must stay a strict boolean: a later task allowlists tls for
    // publication into the run summary specifically because this validator
    // guarantees it can never be an object. If an object like a private key
    // ever slipped through here, it would get published to object storage.
    const r = validateProfile({ ...base, target: { transport: 'syslog', endpoint: 'a:514', options: { tls: { key: 'x' } } } });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/tls/);
  });

  it('accepts every option the spec documents for each transport', () => {
    const cases: Array<[string, string | undefined, Record<string, unknown>]> = [
      ['otlp-grpc', 'a:4317', { plaintext: true, timeout: '10s', resource_attributes: { 'service.name': 'x' } }],
      ['otlp-http', 'https://a/v1/logs', { path: '/v1/logs', encoding: 'json', headers: { 'X-A': 'b' } }],
      ['hec', 'https://a:8088', { path: '/services/collector/event', token_env: 'HEC_TOKEN', index: 'main', sourcetype: 'x', gzip: true }],
      ['syslog', 'a:514', { rfc: 5424, framing: 'octet-counted', tls: false, app_name: 'k6' }],
      ['null', undefined, { count_bytes: false }],
    ];
    for (const [transport, endpoint, options] of cases) {
      const target: Record<string, unknown> = { transport, options };
      if (endpoint) target.endpoint = endpoint;
      const r = validateProfile({ ...base, target });
      expect(r.errors, `${transport}: ${r.errors.join('; ')}`).toEqual([]);
    }
  });

  it('collects an option error alongside other errors rather than short-circuiting', () => {
    const r = validateProfile({ ...base, name: 42, target: { transport: 'otlp-grpc', endpoint: 'a:4317', options: { plaintxt: true } } });
    expect(r.errors.length).toBeGreaterThan(1);
  });

  it('rejects an inherited Object.prototype key as a transport option, with the unknown-option message', () => {
    // Same class of bug as the LOG_TYPES lookup in schema.ts: an unguarded
    // `spec[key]` walks the prototype chain, so `{"constructor": true}`
    // resolves to Object's constructor function rather than undefined. The
    // profile was still correctly REJECTED either way (optionMatchesSpec
    // fails on a function value) — but with the wrong message: "must be
    // undefined" instead of naming "constructor" as an unknown option.
    // Assert the intended message, not just rejection, so a regression to
    // the misleading message is caught.
    const r = validateProfile({
      ...base,
      target: { transport: 'otlp-grpc', endpoint: 'a:4317', options: { constructor: true } },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/target\.options\.constructor.*unknown option/);
  });

  it('rejects an inherited Object.prototype key as a log type name, with the unknown-type message', () => {
    // Same guard, in the LOG_TYPES lookup instead of the transport-option one.
    const r = validateProfile({ ...base, types: { constructor: validTypes.auditd } });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/types\.constructor.*unknown log type/);
  });
});

describe('validateProfile — VU sizing (follow-up)', () => {
  const withVus = (extra: Record<string, unknown>) => ({
    ...base,
    types: { auditd: { ...validTypes.auditd, ...extra } },
  });

  it('accepts pre_allocated_vus and max_vus as positive integers', () => {
    expect(validateProfile(withVus({ pre_allocated_vus: 50, max_vus: 500 })).ok).toBe(true);
    expect(validateProfile(withVus({ pre_allocated_vus: 50 })).ok).toBe(true);
    expect(validateProfile(withVus({ max_vus: 500 })).ok).toBe(true);
  });

  it('rejects a non-positive-integer pre_allocated_vus or max_vus', () => {
    for (const bad of [0, -1, 1.5, '50']) {
      const r = validateProfile(withVus({ pre_allocated_vus: bad }));
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/types\.auditd\.pre_allocated_vus/);
      const m = validateProfile(withVus({ max_vus: bad }));
      expect(m.ok).toBe(false);
      expect(m.errors.join(' ')).toMatch(/types\.auditd\.max_vus/);
    }
  });

  it('rejects max_vus below pre_allocated_vus', () => {
    const r = validateProfile(withVus({ pre_allocated_vus: 100, max_vus: 50 }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/max_vus.*pre_allocated_vus/);
  });
});
