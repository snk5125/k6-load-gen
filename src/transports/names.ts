// Single source of truth for transport names. Kept free of any import —
// especially no import of `./registry.ts` or any transport implementation
// module — because `registry.ts` imports `otlp-grpc.ts`, which imports
// `k6/net/grpc`. That module does not resolve under vitest, and
// `src/config/schema.ts` (imported heavily by the vitest suite) needs this
// list without dragging that k6 dependency in with it.
//
// TRANSPORT_NAMES intentionally lists all five transports spec §6.1 names,
// not just the ones `registry.ts` currently implements: profile validation
// (schema.ts) must accept a name the registry doesn't implement yet, so that
// failure surfaces as `createTransport`'s clear "not implemented" error
// rather than a validation error that would reject a spec-legal profile.
export type TransportName = 'otlp-grpc' | 'otlp-http' | 'hec' | 'syslog' | 'null';

export const TRANSPORT_NAMES: TransportName[] = [
  'otlp-grpc',
  'otlp-http',
  'hec',
  'syslog',
  'null',
];
