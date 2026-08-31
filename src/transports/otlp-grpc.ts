import grpc from 'k6/net/grpc';
import type { SendResult, TransportFactory } from './types.ts';
import { buildResourceLogs } from './otlp-payload.ts';

const PROTO_ROOT = __ENV.PROTO_ROOT || '/protos';
const EXPORT_METHOD = 'opentelemetry.proto.collector.logs.v1.LogsService/Export';

// Init context only. Throws here if the protos are missing — which is the
// failure we want loud and immediate, not at the first iteration.
// One client per VU: createOtlpGrpcTransport() shares this module-scope
// client across every transport instance built in the same VU, so building
// more than one otlp-grpc transport per VU would have them collide on it.
const client = new grpc.Client();
client.load([PROTO_ROOT], 'opentelemetry/proto/collector/logs/v1/logs_service.proto');

export const createOtlpGrpcTransport: TransportFactory = (cfg) => {
  const endpoint = cfg.endpoint;
  if (!endpoint) throw new Error('otlp-grpc transport requires target.endpoint (host:port, no scheme)');

  const opts = cfg.options ?? {};
  const plaintext = opts.plaintext !== false;
  const timeout = (opts.timeout as string | undefined) ?? '10s';
  const resourceAttributes = opts.resource_attributes as Record<string, string> | undefined;

  function closeClient() {
    try {
      client.close();
    } catch {
      /* already closed */
    }
  }

  let connectFailed = false;
  let connectError = '';

  return {
    name: 'otlp-grpc',

    async connect() {
      // One connection per VU: an NLB pins flows per connection.
      try {
        client.connect(endpoint, { plaintext, timeout });
        connectFailed = false;
      } catch (err) {
        // Recorded, not thrown: an unguarded throw here aborts the iteration
        // before send() can report the failure through the normal counters.
        connectFailed = true;
        connectError = String(err);
      }
    },

    async send(events, _ctx): Promise<SendResult> {
      if (connectFailed) {
        return { ok: false, status: 'connect-failed', wire_bytes: null, error: connectError };
      }
      try {
        const payload = buildResourceLogs(events, resourceAttributes);
        const res = client.invoke(EXPORT_METHOD, payload, { timeout });
        if (res && res.status === grpc.StatusOK) {
          // k6 does not expose the encoded protobuf size; reporting a
          // JSON-side length here would be a wrong number, not an approximate one.
          return { ok: true, status: res.status, wire_bytes: null };
        }
        closeClient();
        return {
          ok: false,
          status: res ? res.status : 'no-response',
          wire_bytes: null,
          // Response.error is an object (the error protobuf serialized to
          // JSON), not a string — String() on it collapses every failure to
          // the useless literal "[object Object]". JSON.stringify preserves
          // the actual diagnostic.
          error: res && res.error ? JSON.stringify(res.error) : 'non-OK gRPC status',
        };
      } catch (err) {
        closeClient();
        return { ok: false, status: 'exception', wire_bytes: null, error: String(err) };
      }
    },

    async close() {
      closeClient();
    },
  };
};
