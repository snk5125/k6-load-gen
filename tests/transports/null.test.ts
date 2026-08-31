import { describe, it, expect } from 'vitest';
import { createNullTransport } from '../../src/transports/null.ts';
import type { LogEvent } from '../../src/payload/types.ts';

const ev = (body: string): LogEvent => ({
  ts_ms: 1, severity: 'INFO', body, fields: {},
  run_id: 'r', gen_index: 0, type: 'x', seq: 0,
});

const ctx = { run_id: 'r', gen_index: 0, iteration: 0 };

describe('createNullTransport', () => {
  it('identifies itself and accepts connect/close', async () => {
    const t = createNullTransport({});
    expect(t.name).toBe('null');
    await t.connect();
    await t.close();
  });

  it('always succeeds', async () => {
    const t = createNullTransport({});
    const r = await t.send([ev('abc'), ev('de')], ctx);
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();
  });

  it('counts body bytes by default', async () => {
    const t = createNullTransport({});
    expect((await t.send([ev('abc'), ev('de')], ctx)).wire_bytes).toBe(5);
  });

  it('reports wire_bytes as null (not 0) when counting is disabled', async () => {
    const t = createNullTransport({ options: { count_bytes: false } });
    expect((await t.send([ev('abc')], ctx)).wire_bytes).toBeNull();
  });

  it('handles an empty batch', async () => {
    const t = createNullTransport({});
    const r = await t.send([], ctx);
    expect(r.ok).toBe(true);
    expect(r.wire_bytes).toBe(0);
  });

  it('send() returns a Promise', () => {
    const t = createNullTransport({});
    const result = t.send([ev('abc')], ctx);
    expect(result).toBeInstanceOf(Promise);
  });
});
