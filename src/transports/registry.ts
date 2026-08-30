import type { Transport, TransportConfig, TransportFactory } from './types.ts';
import { createNullTransport } from './null.ts';
import { createOtlpGrpcTransport } from './otlp-grpc.ts';

const FACTORIES: Record<string, TransportFactory> = {
  null: createNullTransport,
  'otlp-grpc': createOtlpGrpcTransport,
};

export function createTransport(name: string, cfg: TransportConfig): Transport {
  const factory = FACTORIES[name];
  if (!factory) {
    throw new Error(
      `transport "${name}" is not implemented; available: ${Object.keys(FACTORIES).join(', ')}`,
    );
  }
  return factory(cfg);
}
