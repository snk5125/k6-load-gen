import { describe, it, expect } from 'vitest';
import { validateProfile } from '../../src/config/schema.ts';

const valid = {
  name: 'otlp-grpc',
  target: { transport: 'otlp-grpc', endpoint: 'collector.example:4317', options: { plaintext: true } },
  payload: {
    template: 'json-app',
    batch_size: 100,
    fields: {
      host: { cardinality: 500 },
      level: { values: ['INFO', 'WARN'], weights: [0.9, 0.1] },
      trace_id: { cardinality: 'unbounded' },
    },
  },
  anchor: { mode: 'knee', knee_eps: 5000 },
  scenario: 'sweep',
  thresholds: { send_failures: 'rate<0.001' },
};

describe('validateProfile', () => {
  it('accepts a well-formed profile', () => {
    const r = validateProfile(valid);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('rejects a non-object', () => {
    expect(validateProfile(null).ok).toBe(false);
    expect(validateProfile('nope').ok).toBe(false);
  });

  it('names the offending field in every error', () => {
    const r = validateProfile({ ...valid, name: 42 });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/name/);
  });

  it('rejects an unknown transport and lists the valid ones', () => {
    const r = validateProfile({ ...valid, target: { transport: 'carrier-pigeon', endpoint: 'x' } });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/otlp-grpc/);
  });

  it('requires an endpoint for every transport except null', () => {
    expect(validateProfile({ ...valid, target: { transport: 'otlp-grpc' } }).ok).toBe(false);
    expect(validateProfile({ ...valid, target: { transport: 'null' } }).ok).toBe(true);
  });

  it('rejects a non-positive or non-integer batch_size', () => {
    for (const bad of [0, -5, 1.5]) {
      const r = validateProfile({ ...valid, payload: { ...valid.payload, batch_size: bad } });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/batch_size/);
    }
  });

  it('rejects an empty fields map', () => {
    const r = validateProfile({ ...valid, payload: { ...valid.payload, fields: {} } });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/fields/);
  });

  it('rejects a malformed field spec', () => {
    const r = validateProfile({
      ...valid,
      payload: { ...valid.payload, fields: { host: { cardinality: 'lots' } } },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/host/);
  });

  it('rejects weights whose length does not match values', () => {
    const r = validateProfile({
      ...valid,
      payload: { ...valid.payload, fields: { level: { values: ['A', 'B'], weights: [1] } } },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/weights/);
  });

  it('rejects an unknown scenario name', () => {
    const r = validateProfile({ ...valid, scenario: 'hammer' });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/scenario/);
  });

  it('rejects a malformed anchor', () => {
    expect(validateProfile({ ...valid, anchor: { mode: 'knee' } }).ok).toBe(false);
    expect(validateProfile({ ...valid, anchor: { mode: 'absolute', base_eps: 0 } }).ok).toBe(false);
    expect(validateProfile({ ...valid, anchor: { mode: 'vibes', knee_eps: 1 } }).ok).toBe(false);
  });

  it('accepts absolute anchors', () => {
    expect(validateProfile({ ...valid, anchor: { mode: 'absolute', base_eps: 8000 } }).ok).toBe(true);
  });

  it('rejects non-string threshold expressions', () => {
    const r = validateProfile({ ...valid, thresholds: { send_failures: 0.001 } });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/thresholds/);
  });

  it('collects every error rather than stopping at the first', () => {
    const r = validateProfile({ name: 1, target: {}, payload: {}, anchor: {}, scenario: 'x' });
    expect(r.errors.length).toBeGreaterThan(3);
  });

  it('rejects weights on a cardinality spec', () => {
    const r = validateProfile({
      ...valid,
      payload: { ...valid.payload, fields: { host: { cardinality: 500, weights: [0.5, 0.5] } } },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('weights'))).toBe(true);
  });

  it('rejects weights on an unbounded spec', () => {
    const r = validateProfile({
      ...valid,
      payload: { ...valid.payload, fields: { trace_id: { cardinality: 'unbounded', weights: [1] } } },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('weights'))).toBe(true);
  });

  it('rejects pad_to on a values spec', () => {
    const r = validateProfile({
      ...valid,
      payload: { ...valid.payload, fields: { level: { values: ['A', 'B'], pad_to: 512 } } },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('pad_to'))).toBe(true);
  });
});

describe('validateProfile — per-transport option validation', () => {
  it('rejects an option key the transport does not accept', () => {
    // The typo case this exists for: plaintxt silently did nothing before.
    const r = validateProfile({ ...valid, target: { transport: 'otlp-grpc', endpoint: 'a:4317', options: { plaintxt: true } } });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/plaintxt/);
  });

  it('names the accepted keys so the operator can see the typo', () => {
    const r = validateProfile({ ...valid, target: { transport: 'otlp-grpc', endpoint: 'a:4317', options: { plaintxt: true } } });
    expect(r.errors.join(' ')).toMatch(/plaintext/);
  });

  it('rejects a string where a boolean belongs', () => {
    const r = validateProfile({ ...valid, target: { transport: 'otlp-grpc', endpoint: 'a:4317', options: { plaintext: 'true' } } });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/plaintext/);
  });

  it('rejects an out-of-range enum', () => {
    const r = validateProfile({ ...valid, target: { transport: 'syslog', endpoint: 'a:514', options: { rfc: 9999 } } });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/rfc/);
  });

  it('rejects a non-boolean value for syslog tls — this guarantee is load-bearing for run-summary publication', () => {
    // tls must stay a strict boolean: a later task allowlists tls for
    // publication into the run summary specifically because this validator
    // guarantees it can never be an object. If an object like a private key
    // ever slipped through here, it would get published to object storage.
    const r = validateProfile({ ...valid, target: { transport: 'syslog', endpoint: 'a:514', options: { tls: { key: 'x' } } } });
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
      const r = validateProfile({ ...valid, target });
      expect(r.errors, `${transport}: ${r.errors.join('; ')}`).toEqual([]);
    }
  });

  it('rejects an unknown template name and lists the known ones', () => {
    const r = validateProfile({ ...valid, payload: { ...valid.payload, template: 'nope' } });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/template/);
    expect(r.errors.join(' ')).toMatch(/json-app/);
  });

  it('rejects an inherited Object.prototype key as a template name, not just a missing own key', () => {
    // TEMPLATES is a plain object literal, so a naive `in` check would let
    // "constructor", "toString", etc. through as if they were real
    // templates. Assert it is rejected for the right reason: the error
    // names the bogus value as an unknown template, the same way "nope" is.
    const r = validateProfile({ ...valid, payload: { ...valid.payload, template: 'constructor' } });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/payload\.template.*must be one of.*json-app/);
  });

  it('collects an option error alongside other errors rather than short-circuiting', () => {
    const r = validateProfile({ ...valid, name: 42, target: { transport: 'otlp-grpc', endpoint: 'a:4317', options: { plaintxt: true } } });
    expect(r.errors.length).toBeGreaterThan(1);
  });
});
