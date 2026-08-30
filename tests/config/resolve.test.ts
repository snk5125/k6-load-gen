import { describe, it, expect } from 'vitest';
import { resolveRun, ConfigError } from '../../src/config/resolve.ts';
import type { Profile } from '../../src/config/schema.ts';

const profile = (): Profile => ({
  name: 'p',
  target: { transport: 'otlp-grpc', endpoint: 'a:4317' },
  payload: { template: 'json-app', batch_size: 100, fields: { host: { cardinality: 10 } } },
  anchor: { mode: 'knee', knee_eps: 5000 },
  scenario: 'sweep',
});

describe('resolveRun — required inputs', () => {
  it('requires run_id', () => {
    expect(() => resolveRun(profile(), {})).toThrow(ConfigError);
    expect(() => resolveRun(profile(), { run_id: '' })).toThrow(/run_id/i);
  });

  it('returns run_id when supplied', () => {
    expect(resolveRun(profile(), { run_id: 'r1' }).run_id).toBe('r1');
  });
});

describe('resolveRun — overrides win over the profile', () => {
  it('overrides the endpoint', () => {
    const r = resolveRun(profile(), { run_id: 'r', target: 'other:4317' });
    expect(r.profile.target.endpoint).toBe('other:4317');
  });

  it('overrides the scenario', () => {
    expect(resolveRun(profile(), { run_id: 'r', scenario: 'spike' }).profile.scenario).toBe('spike');
  });

  it('rejects an unknown scenario override', () => {
    expect(() => resolveRun(profile(), { run_id: 'r', scenario: 'hammer' })).toThrow(/scenario/i);
  });

  it('overrides knee_eps while staying in knee mode', () => {
    const r = resolveRun(profile(), { run_id: 'r', knee_eps: 9000 });
    expect(r.profile.anchor).toEqual({ mode: 'knee', knee_eps: 9000 });
  });

  it('rate switches the anchor to absolute mode', () => {
    const r = resolveRun(profile(), { run_id: 'r', rate: 7500 });
    expect(r.profile.anchor).toEqual({ mode: 'absolute', base_eps: 7500 });
  });

  it('rate wins when both rate and knee_eps are supplied', () => {
    const r = resolveRun(profile(), { run_id: 'r', rate: 7500, knee_eps: 100 });
    expect(r.profile.anchor).toEqual({ mode: 'absolute', base_eps: 7500 });
  });

  it('does not mutate the profile it was given', () => {
    const p = profile();
    resolveRun(p, { run_id: 'r', target: 'zzz:1', rate: 1 });
    expect(p.target.endpoint).toBe('a:4317');
    expect(p.anchor).toEqual({ mode: 'knee', knee_eps: 5000 });
  });
});

describe('resolveRun — fleet and duration defaults', () => {
  it('defaults to a single generator at full duration', () => {
    const r = resolveRun(profile(), { run_id: 'r' });
    expect(r.gen_index).toBe(0);
    expect(r.gen_count).toBe(1);
    expect(r.duration_scale).toBe(1);
  });

  it('accepts a valid fleet position', () => {
    const r = resolveRun(profile(), { run_id: 'r', gen_index: 2, gen_count: 4 });
    expect(r.gen_index).toBe(2);
    expect(r.gen_count).toBe(4);
  });

  it('rejects a gen_index outside the fleet', () => {
    expect(() => resolveRun(profile(), { run_id: 'r', gen_index: 4, gen_count: 4 })).toThrow(/gen_index/i);
    expect(() => resolveRun(profile(), { run_id: 'r', gen_index: -1 })).toThrow(/gen_index/i);
  });

  it('rejects a gen_count below 1', () => {
    expect(() => resolveRun(profile(), { run_id: 'r', gen_count: 0 })).toThrow(/gen_count/i);
  });

  it('rejects a non-positive duration_scale', () => {
    expect(() => resolveRun(profile(), { run_id: 'r', duration_scale: 0 })).toThrow(/duration_scale/i);
    expect(() => resolveRun(profile(), { run_id: 'r', duration_scale: -1 })).toThrow(/duration_scale/i);
  });

  it('accepts a fractional duration_scale', () => {
    expect(resolveRun(profile(), { run_id: 'r', duration_scale: 0.01 }).duration_scale).toBe(0.01);
  });
});
