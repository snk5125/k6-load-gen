import type { LogTypeDef } from '../types.ts';

/**
 * Structured JSON application log — the common shape for modern services.
 * Field specs mirror profiles/otlp-grpc.json exactly so migrating this
 * definition through the new model changes nothing on the wire.
 */
export const jsonApp: LogTypeDef = {
  name: 'json-app',
  family: 'json-flat',
  severity: { from: 'level' },
  fields: [
    { name: 'host', spec: { cardinality: 500, distribution: 'zipf' } },
    { name: 'level', spec: { values: ['INFO', 'WARN', 'ERROR'], weights: [0.8, 0.15, 0.05] } },
    { name: 'trace_id', spec: { cardinality: 'unbounded' } },
    { name: 'message', spec: { cardinality: 50, pad_to: 512 } },
  ],
};
