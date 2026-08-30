import grpc from 'k6/net/grpc';
import type { SendResult, TransportFactory } from './types.ts';
import type { LogEvent } from '../payload/types.ts';

const PROTO_ROOT = __ENV.PROTO_ROOT || '/protos';
const EXPORT_METHOD = 'opentelemetry.proto.collector.logs.v1.LogsService/Export';

// Init context only. Throws here if the protos are missing — which is the
// failure we want loud and immediate, not at the first iteration.
// One client per VU: createOtlpGrpcTransport() shares this module-scope
// client across every transport instance built in the same VU, so building
// more than one otlp-grpc transport per VU would have them collide on it.
const client = new grpc.Client();
client.load([PROTO_ROOT], 'opentelemetry/proto/collector/logs/v1/logs_service.proto');

const SEVERITY_NUMBER: Record<string, number> = {
  TRACE: 1, DEBUG: 5, INFO: 9, WARN: 13, ERROR: 17, FATAL: 21,
};

function toLogRecord(e: LogEvent) {
  const attributes: Array<Record<string, unknown>> = [
    { key: 'run_id', value: { stringValue: e.run_id } },
    { key: 'gen_index', value: { intValue: String(e.gen_index) } },
    { key: 'seq', value: { intValue: String(e.seq) } },
  ];
  // Attributes carry IDENTITY ONLY; the generated fields travel in the body.
  //
  // Copying every field into attributes as well would put each value on the
  // wire twice — once here, once inside the JSON body — roughly doubling event
  // size and making `pad_to` mean half what it says. It would also make this
  // transport incomparable with HEC and syslog, which have no attributes
  // sidecar: the same profile would produce materially different wire volume
  // per transport, so a knee measured over gRPC could not be compared with one
  // measured over HEC.
  //
  // Making the aggregator parse the body to see the fields is the point — that
  // parse cost is what the payload cardinality controls exist to exercise.
  //
  // run_id/gen_index/seq stay as attributes because the delivery-correctness
  // layer needs to match events without parsing every body.
  return {
    timeUnixNano: String(e.ts_ms) + '000000',
    severityNumber: SEVERITY_NUMBER[e.severity] ?? 9,
    severityText: e.severity,
    body: { stringValue: e.body },
    attributes,
  };
}

export const createOtlpGrpcTransport: TransportFactory = (cfg) => {
  const endpoint = cfg.endpoint;
  if (!endpoint) throw new Error('otlp-grpc transport requires target.endpoint (host:port, no scheme)');

  const opts = cfg.options ?? {};
  const plaintext = opts.plaintext !== false;
  const timeout = (opts.timeout as string | undefined) ?? '10s';

  const resourceAttrs: Array<Record<string, unknown>> = [
    { key: 'service.name', value: { stringValue: 'k6-load-gen' } },
  ];
  const extra = (opts.resource_attributes as Record<string, string> | undefined) ?? {};
  for (const k of Object.keys(extra)) {
    resourceAttrs.push({ key: k, value: { stringValue: extra[k] } });
  }

  function closeClient() {
    try {
      client.close();
    } catch {
      /* already closed */
    }
  }

  return {
    name: 'otlp-grpc',

    connect() {
      // One connection per VU: an NLB pins flows per connection.
      client.connect(endpoint, { plaintext, timeout });
    },

    send(events, _ctx): SendResult {
      try {
        const payload = {
          resourceLogs: [
            {
              resource: { attributes: resourceAttrs },
              scopeLogs: [{ scope: { name: 'k6-load-gen' }, logRecords: events.map(toLogRecord) }],
            },
          ],
        };

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

    close() {
      closeClient();
    },
  };
};
