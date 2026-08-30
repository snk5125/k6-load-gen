import http from 'k6/http';
import type { SendResult, TransportFactory } from './types.ts';
import { buildResourceLogs } from './otlp-payload.ts';

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
  const resourceAttrs = opts.resource_attributes as Record<string, string> | undefined;

  return {
    name: 'otlp-http',
    async connect() {
      /* HTTP is connectionless from k6's perspective */
    },
    async send(events): Promise<SendResult> {
      try {
        const body = JSON.stringify(buildResourceLogs(events, resourceAttrs));
        const res = http.post(url, body, {
          headers: { 'Content-Type': 'application/json', ...extraHeaders },
        });
        if (res.status >= 200 && res.status < 300) {
          // Unlike gRPC, the HTTP body size IS the wire size we sent.
          return { ok: true, status: res.status, wire_bytes: body.length };
        }
        return {
          ok: false,
          status: res.status,
          wire_bytes: null,
          error: String(res.body ?? '').slice(0, 500),
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
