import { describe, it, expect } from 'vitest';
import type { FieldSpec, LogEvent } from '../src/payload/types.ts';

describe('scaffolding', () => {
  it('resolves .ts import specifiers and typed shapes', () => {
    const spec: FieldSpec = { cardinality: 10, distribution: 'zipf' };
    const event: LogEvent = {
      ts_ms: 0, severity: 'INFO', body: 'x', fields: {},
      run_id: 'r', gen_index: 0, seq: 0,
    };
    expect(spec).toBeDefined();
    expect(event.seq).toBe(0);
  });
});
