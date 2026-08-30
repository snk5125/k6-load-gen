import { describe, it, expect } from 'vitest';
import { buildGenerator } from '../../src/payload/generator.ts';
import type { PayloadSpec } from '../../src/payload/types.ts';

const spec: PayloadSpec = {
  template: 'json-app',
  batch_size: 10,
  fields: {
    host: { cardinality: 50 },
    level: { values: ['INFO', 'WARN'], weights: [0.9, 0.1] },
    trace_id: { cardinality: 'unbounded' },
  },
};

describe('buildGenerator', () => {
  it('produces batch_size events per batch', () => {
    const g = buildGenerator(spec, { run_id: 'r1', gen_index: 0 });
    expect(g.batchAt(0, 1000).length).toBe(10);
  });

  it('assigns contiguous, non-overlapping seq across iterations', () => {
    const g = buildGenerator(spec, { run_id: 'r1', gen_index: 0 });
    expect(g.batchAt(0, 1000).map((e) => e.seq)).toEqual([0,1,2,3,4,5,6,7,8,9]);
    expect(g.batchAt(1, 1000).map((e) => e.seq)).toEqual([10,11,12,13,14,15,16,17,18,19]);
  });

  it('stamps run_id and gen_index on every event', () => {
    const g = buildGenerator(spec, { run_id: 'run-abc', gen_index: 3 });
    for (const e of g.batchAt(5, 1000)) {
      expect(e.run_id).toBe('run-abc');
      expect(e.gen_index).toBe(3);
    }
  });

  it('never collides seq across generators in a fleet', () => {
    const g0 = buildGenerator(spec, { run_id: 'r', gen_index: 0 });
    const g1 = buildGenerator(spec, { run_id: 'r', gen_index: 1 });
    const id = (e: { gen_index: number; seq: number }) => `${e.gen_index}:${e.seq}`;
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      for (const e of g0.batchAt(i, 0)) seen.add(id(e));
      for (const e of g1.batchAt(i, 0)) seen.add(id(e));
    }
    expect(seen.size).toBe(2000);
  });

  it('is deterministic in everything except the timestamp', () => {
    const a = buildGenerator(spec, { run_id: 'r', gen_index: 0 });
    const b = buildGenerator(spec, { run_id: 'r', gen_index: 0 });
    const strip = (e: any) => { const { ts_ms, ...rest } = e; return rest; };
    expect(a.batchAt(7, 111).map(strip)).toEqual(b.batchAt(7, 999).map(strip));
  });

  it('expectedAt reconstructs a batch without sending it', () => {
    const g = buildGenerator(spec, { run_id: 'r', gen_index: 0 });
    const strip = (e: any) => { const { ts_ms, ...rest } = e; return rest; };
    expect(g.expectedAt(4)).toEqual(g.batchAt(4, 12345).map(strip));
  });

  it('applies the timestamp given to it', () => {
    const g = buildGenerator(spec, { run_id: 'r', gen_index: 0 });
    expect(g.batchAt(0, 1717171717)[0].ts_ms).toBe(1717171717);
  });

  it('renders the json-app template body as parseable JSON', () => {
    const g = buildGenerator(spec, { run_id: 'r', gen_index: 0 });
    const parsed = JSON.parse(g.batchAt(0, 1000)[0].body);
    expect(parsed.host).toMatch(/^host-\d+$/);
    expect(['INFO', 'WARN']).toContain(parsed.level);
  });

  it('rejects an unknown template name', () => {
    expect(() => buildGenerator({ ...spec, template: 'nope' }, { run_id: 'r', gen_index: 0 }))
      .toThrow(/unknown template/i);
  });
});
