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
