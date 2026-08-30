import http from 'k6/http';
import type { SendResult, TransportFactory } from './types.ts';
import type { LogEvent } from '../payload/types.ts';

export const createHecTransport: TransportFactory = (cfg) => {
  const endpoint = cfg.endpoint;
  if (!endpoint) throw new Error('hec transport requires target.endpoint (full URL)');

  const opts = cfg.options ?? {};
  const path = (opts.path as string | undefined) ?? '/services/collector/event';
  const url = endpoint.replace(/\/+$/, '') + path;
  const index = opts.index as string | undefined;
  const sourcetype = opts.sourcetype as string | undefined;
  const gzip = opts.gzip === true;

  // The profile NAMES the variable; the value arrives at runtime. This is what
  // makes profiles safe to commit — see spec section 6.1.
  const tokenEnv = (opts.token_env as string | undefined) ?? 'HEC_TOKEN';
  const token = __ENV[tokenEnv];
  if (!token) {
    // Fail in init with the variable's name, not at the first iteration with a 401.
    throw new Error(
      `hec transport: environment variable ${tokenEnv} is not set (named by target.options.token_env)`,
    );
  }

  function envelope(e: LogEvent): string {
    const ev: Record<string, unknown> = {
      time: e.ts_ms / 1000, // HEC expects epoch SECONDS, not milliseconds
      event: e.body,
      fields: { run_id: e.run_id, gen_index: e.gen_index, seq: e.seq },
    };
    if (index) ev.index = index;
    if (sourcetype) ev.sourcetype = sourcetype;
    return JSON.stringify(ev);
  }

  return {
    name: 'hec',
    async connect() {
      /* connectionless */
    },
    async send(events): Promise<SendResult> {
      try {
        // HEC accepts concatenated JSON objects; newline-delimited is the
        // conventional and most readable form.
        const body = events.map(envelope).join('\n');
        const headers: Record<string, string> = {
          Authorization: `Splunk ${token}`,
          'Content-Type': 'application/json',
        };
        if (gzip) headers['Content-Encoding'] = 'gzip';
        const res = http.post(url, body, { headers, compression: gzip ? 'gzip' : undefined });
        if (res.status >= 200 && res.status < 300) {
          // With gzip on, `body.length` is the UNCOMPRESSED size — k6 compresses
          // after we hand it the string, and does not report the compressed
          // length. Reporting the uncompressed figure as wire size would be
          // exactly the "confident wrong number" this project's SendResult
          // contract exists to prevent, so report null instead.
          return { ok: true, status: res.status, wire_bytes: gzip ? null : body.length };
        }
        return { ok: false, status: res.status, wire_bytes: null, error: String(res.body ?? '').slice(0, 500) };
      } catch (err) {
        return { ok: false, status: 'exception', wire_bytes: null, error: String(err) };
      }
    },
    async close() {
      /* nothing to release */
    },
  };
};
