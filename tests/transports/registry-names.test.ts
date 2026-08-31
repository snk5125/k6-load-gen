import { describe, it, expect } from 'vitest';
import { TRANSPORT_NAMES } from '../../src/transports/names.ts';
import { TRANSPORT_NAMES as SCHEMA_NAMES } from '../../src/config/schema.ts';

// registry.ts imports `k6/net/grpc` transitively (via otlp-grpc.ts), which does
// not resolve under vitest — so this suite can't import registry.ts directly
// to prove "the schema accepts exactly what the registry implements". Instead
// src/transports/names.ts is the k6-free single source that both registry.ts
// and schema.ts import from; the registry's `FACTORIES` map is typed as
// `Partial<Record<TransportName, TransportFactory>>`, so a typo'd key becomes
// a compile error under `npm run typecheck` rather than a name only the
// schema knows about. See task-2-report.md for the full rationale.
describe('transport names have one source of truth', () => {
  it('schema.ts re-exports the same array names.ts declares (no independent copy)', () => {
    expect(SCHEMA_NAMES).toBe(TRANSPORT_NAMES);
  });

  it('declares every transport the spec names, including ones not yet implemented', () => {
    // Before this task, schema.ts hand-declared this same five-name list
    // independently of registry.ts's FACTORIES map, which implemented only
    // two of them — so a profile naming e.g. "hec" validated clean and then
    // threw at construction. TRANSPORT_NAMES intentionally keeps declaring
    // all five: spec §6.1 names them, and later tasks implement the rest.
    expect([...TRANSPORT_NAMES].sort()).toEqual(
      ['hec', 'null', 'otlp-grpc', 'otlp-http', 'syslog'],
    );
  });

  it('is a plain array of strings', () => {
    expect(TRANSPORT_NAMES.length).toBeGreaterThan(0);
    for (const n of TRANSPORT_NAMES) expect(typeof n).toBe('string');
  });
});
