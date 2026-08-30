import { describe, it, expect } from 'vitest';
import { buildField, hash32, seedFromName } from '../../src/payload/fields.ts';

describe('hash32', () => {
  it('is deterministic and well distributed', () => {
    expect(hash32(42, 7)).toBe(hash32(42, 7));
    expect(hash32(42, 7)).not.toBe(hash32(43, 7));
    const buckets = new Array(16).fill(0);
    for (let i = 0; i < 16000; i++) buckets[hash32(i, 1) % 16]++;
    for (const b of buckets) expect(b).toBeGreaterThan(700);
  });
});

describe('seedFromName', () => {
  it('gives different fields different seeds', () => {
    expect(seedFromName('host')).not.toBe(seedFromName('service'));
    expect(seedFromName('host')).toBe(seedFromName('host'));
  });
});

describe('buildField — bounded cardinality', () => {
  it('produces exactly N distinct values', () => {
    const f = buildField('host', { cardinality: 500 });
    const seen = new Set<string>();
    for (let i = 0; i < 200_000; i++) seen.add(f.valueAt(i));
    expect(seen.size).toBe(500);
    expect(f.distinct_count).toBe(500);
  });

  it('is deterministic across independent builds', () => {
    const a = buildField('host', { cardinality: 50 });
    const b = buildField('host', { cardinality: 50 });
    for (let i = 0; i < 1000; i++) expect(a.valueAt(i)).toBe(b.valueAt(i));
  });

  it('decorrelates different field names', () => {
    const host = buildField('host', { cardinality: 100 });
    const svc = buildField('service', { cardinality: 100 });
    let same = 0;
    for (let i = 0; i < 1000; i++) {
      if (host.valueAt(i).split('-')[1] === svc.valueAt(i).split('-')[1]) same++;
    }
    expect(same).toBeLessThan(60); // ~10 expected by chance; lockstep would be 1000
  });

  it('pads values to pad_to bytes', () => {
    const f = buildField('message', { cardinality: 5, pad_to: 512 });
    expect(f.valueAt(0).length).toBe(512);
  });
});

describe('buildField — zipf', () => {
  it('skews heavily toward low ranks', () => {
    const f = buildField('host', { cardinality: 100, distribution: 'zipf' });
    const counts = new Map<string, number>();
    for (let i = 0; i < 100_000; i++) {
      const v = f.valueAt(i);
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    const sorted = [...counts.values()].sort((a, b) => b - a);
    const top10 = sorted.slice(0, 10).reduce((a, b) => a + b, 0);
    expect(top10 / 100_000).toBeGreaterThan(0.35);
    expect(sorted[0]).toBeGreaterThan(sorted[sorted.length - 1] * 5);
  });
});

describe('buildField — unbounded', () => {
  it('never repeats', () => {
    const f = buildField('trace_id', { cardinality: 'unbounded' });
    const seen = new Set<string>();
    for (let i = 0; i < 20_000; i++) seen.add(f.valueAt(i));
    expect(seen.size).toBe(20_000);
    expect(f.distinct_count).toBeNull();
  });
});

describe('buildField — weighted values', () => {
  it('respects declared weights within tolerance', () => {
    const f = buildField('level', {
      values: ['INFO', 'WARN', 'ERROR'],
      weights: [0.8, 0.15, 0.05],
    });
    const counts: Record<string, number> = { INFO: 0, WARN: 0, ERROR: 0 };
    for (let i = 0; i < 100_000; i++) counts[f.valueAt(i)]++;
    expect(counts.INFO / 100_000).toBeCloseTo(0.8, 1);
    expect(counts.WARN / 100_000).toBeCloseTo(0.15, 1);
    expect(counts.ERROR / 100_000).toBeCloseTo(0.05, 1);
  });

  it('defaults to uniform when weights are omitted', () => {
    const f = buildField('region', { values: ['a', 'b', 'c', 'd'] });
    const counts = new Map<string, number>();
    for (let i = 0; i < 40_000; i++) {
      const v = f.valueAt(i);
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    for (const c of counts.values()) expect(c).toBeGreaterThan(9000);
  });
});
