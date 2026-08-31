import http from 'k6/http';
import type { SendResult, TransportFactory } from './types.ts';
import { buildResourceLogs } from './otlp-payload.ts';
import { classifyHttpResponse } from './http-response.ts';

export const createOtlpHttpTransport: TransportFactory = (cfg) => {
  const endpoint = cfg.endpoint;
  if (!endpoint) throw new Error('otlp-http transport requires target.endpoint (full URL)');

  const opts = cfg.options ?? {};
  const encoding = (opts.encoding as string | undefined) ?? 'json';
  if (encoding !== 'json') {
    // Honest failure over a silent one. k6 can encode protobuf for gRPC via
    // .proto files, but there is no equivalent for an HTTP body — implementing
    // it would mean hand-rolling a protobuf encoder in JS. Reject at
    // construction so it fails in init, not at the first iteration.
    throw new Error(
      `otlp-http: encoding "${encoding}" is not implemented; only "json" is supported`,
    );
  }
  const path = (opts.path as string | undefined) ?? '/v1/logs';
  const url = endpoint.replace(/\/+$/, '') + path;
  const extraHeaders = (opts.headers as Record<string, string> | undefined) ?? {};

  return {
    name: 'otlp-http',
    async connect() {
      /* HTTP is connectionless from k6's perspective */
    },
    async send(events): Promise<SendResult> {
      try {
        // otlp-http has no `resource_attributes` option (TRANSPORT_OPTION_SPECS
        // in src/config/schema.ts does not list it, and unknown keys are
        // rejected at validation time before this factory ever runs) — unlike
        // otlp-grpc, which does. Pass undefined explicitly rather than reading
        // a key that can never be present.
        const body = JSON.stringify(buildResourceLogs(events, undefined));
        const res = http.post(url, body, {
          headers: { 'Content-Type': 'application/json', ...extraHeaders },
        });
        const classification = classifyHttpResponse(res.status, res.body, res.error);
        if (classification.ok) {
          // Unlike gRPC, the HTTP body size is the wire size we sent, as a
          // metric — body.length is UTF-16 code units, not a measured UTF-8
          // byte count (same caveat as syslog.ts's wire_bytes; see there).
          return { ok: true, status: res.status, wire_bytes: body.length };
        }
        return {
          ok: false,
          status: res.status,
          wire_bytes: null,
          error: classification.error,
        };
      } catch (err) {
        return { ok: false, status: 'exception', wire_bytes: null, error: String(err) };
      }
    },
    async close() {
      /* nothing to release */
    },
  };
};
