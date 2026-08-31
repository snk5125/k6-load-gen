import type { LogEvent } from '../payload/types.ts';

// Shared, k6-free OTLP `resourceLogs` payload shape. Both otlp-grpc.ts and
// otlp-http.ts build the wire body from this module so the two transports
// can never drift apart on structure — a divergence between them would be
// invisible until an aggregator parsed one and not the other.

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

function buildResourceAttributes(extra?: Record<string, string>): Array<Record<string, unknown>> {
  const resourceAttrs: Array<Record<string, unknown>> = [
    { key: 'service.name', value: { stringValue: 'k6-load-gen' } },
  ];
  if (extra) {
    for (const k of Object.keys(extra)) {
      resourceAttrs.push({ key: k, value: { stringValue: extra[k] } });
    }
  }
  return resourceAttrs;
}

/**
 * Builds the full OTLP `ExportLogsServiceRequest` JSON shape for a batch of
 * events. `resourceAttributes` are merged onto the resource alongside the
 * fixed `service.name` attribute (extra keys appended in their own
 * enumeration order, same as `otlp-grpc.ts` did before this was extracted).
 */
export function buildResourceLogs(events: LogEvent[], resourceAttributes?: Record<string, string>) {
  return {
    resourceLogs: [
      {
        resource: { attributes: buildResourceAttributes(resourceAttributes) },
        scopeLogs: [{ scope: { name: 'k6-load-gen' }, logRecords: events.map(toLogRecord) }],
      },
    ],
  };
}
