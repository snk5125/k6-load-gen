import type { Transport, TransportConfig, TransportFactory } from './types.ts';
import { TRANSPORT_NAMES, type TransportName } from './names.ts';
import { createNullTransport } from './null.ts';
import { createOtlpGrpcTransport } from './otlp-grpc.ts';
import { createOtlpHttpTransport } from './otlp-http.ts';
import { createHecTransport } from './hec.ts';
import { createSyslogTransport } from './syslog.ts';

export { TRANSPORT_NAMES, type TransportName };

// Partial, not Record: TRANSPORT_NAMES (src/transports/names.ts) declares
// every transport the spec names, including ones not implemented yet. Typing
// this map against TransportName means a typo'd key is a compile error,
// while a declared-but-unimplemented name stays a clear runtime error from
// createTransport() below — exactly today's behaviour, just no longer able
// to drift from what schema.ts accepts.
const FACTORIES: Partial<Record<TransportName, TransportFactory>> = {
  null: createNullTransport,
  'otlp-grpc': createOtlpGrpcTransport,
  'otlp-http': createOtlpHttpTransport,
  hec: createHecTransport,
  syslog: createSyslogTransport,
};

export function createTransport(name: string, cfg: TransportConfig): Transport {
  const factory = FACTORIES[name as TransportName];
  if (!factory) {
    throw new Error(
      `transport "${name}" is not implemented; available: ${Object.keys(FACTORIES).join(', ')}`,
    );
  }
  return factory(cfg);
}
