import { Socket } from 'k6/x/tcp';
import type { TCPError } from 'k6/x/tcp';
import type { SendResult, TransportFactory } from './types.ts';
import { formatRfc5424, formatRfc3164, frame } from './syslog-format.ts';

function isTcpError(err: unknown): err is TCPError {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as TCPError).name === 'string' &&
    typeof (err as TCPError).method === 'string' &&
    typeof (err as TCPError).message === 'string'
  );
}

// Both the 'error' event and a rejected connect() carry a TCPError
// ({name, method, message} — src/k6-x-tcp.d.ts), not a JS Error. `String()`
// on a plain object renders the useless literal "[object Object]" — and
// this is the error text a user actually sees for the most common syslog
// failure mode (refused/timed-out connect, TLS failure). Falls back to
// String(err) for anything that isn't TCPError-shaped (e.g. a write()
// rejection, which xk6-tcp rejects with a raw Go error, or a payload-build
// throw like RangeError/URIError).
function formatSocketError(err: unknown): string {
  return isTcpError(err) ? `${err.name} during ${err.method}: ${err.message}` : String(err);
}

// PER-BATCH connect/write/destroy — deliberately NOT a persistent
// per-VU socket. This was a design change made after a code review found
// the original persistent-socket draft would hang every real run, and it
// was settled by experiment, not by re-reading the source:
//
//   `k6/x/tcp`'s Socket constructor starts a background goroutine
//   (`go s.loop(ctx)`) whose owning taskqueue is only closed by
//   destroy()'s context cancellation. That goroutine keeps the whole k6
//   process alive at shutdown until destroy() runs — and this is true
//   even for a socket that connected and wrote successfully, not just
//   for a failed connect(). Verified live: a throwaway script that
//   constructed a Socket, connected, wrote two messages (both actually
//   received by the listening peer), and returned WITHOUT calling
//   destroy() never printed a summary and was still running when killed
//   after 143+ seconds. The identical script with `s.destroy()` added
//   printed a normal summary and exited in ~0.4s.
//
// src/main.ts calls connect() exactly once per VU and never calls
// close() at all — there is no per-VU teardown hook in k6, and
// handleSummary runs in a fresh runtime that cannot reach a live VU's
// socket. A connect-once, persistent-socket design would therefore hang
// EVERY real run at shutdown, not just a pathological one, since nothing
// in this codebase's calling convention ever destroys it. Full
// experiment transcript (both timings, both exit codes, both commands):
// .superpowers/sdd/2026-08-30-remaining-transports/task-6-report.md,
// "Fix report" section, Critical 1.
//
// The cost of the fix: syslog pays a fresh TCP handshake (and, with
// tls: true, a TLS handshake) on every send() batch. Its achievable
// throughput is therefore NOT comparable to the connectionless HTTP
// transports (hec, otlp-http) or the connect-once otlp-grpc client — it
// is bounded by handshake latency, not by the aggregator's ingest rate.
// A load test using this transport is, in part, measuring TCP/TLS
// handshake cost, not just the syslog receiver's processing throughput.
//
// There is a second, harder ceiling beyond latency: connect-per-batch also
// caps the achievable RATE. Every closed connection sits in TIME_WAIT on
// the generator host for roughly 60 seconds, so a single generator VU pool
// against a single target host:port tops out somewhere around a few
// hundred connections per second, no matter how fast the handshakes
// themselves complete — ephemeral source ports simply run out faster than
// TIME_WAIT clears them. Past that ceiling, connect() itself starts
// failing (surfaced here as status: 'connect-failed'), which looks exactly
// like a receiver-side problem in the run's metrics. Anyone tuning VUs
// upward against this transport should watch for that failure mode before
// concluding the aggregator is the bottleneck.
export const createSyslogTransport: TransportFactory = (cfg) => {
  const endpoint = cfg.endpoint;
  if (!endpoint) throw new Error('syslog transport requires target.endpoint (host:port)');
  const [host, portStr] = endpoint.split(':');
  const port = Number(portStr);
  if (!host || !Number.isFinite(port)) {
    throw new Error(`syslog transport: endpoint must be host:port (got ${JSON.stringify(endpoint)})`);
  }

  const opts = cfg.options ?? {};
  const rfc = (opts.rfc as number | undefined) ?? 5424;
  const framing = (opts.framing as 'octet-counted' | 'lf' | undefined) ?? 'octet-counted';
  const appName = (opts.app_name as string | undefined) ?? 'k6-load-gen';
  const tls = opts.tls === true;
  const format = rfc === 3164 ? formatRfc3164 : formatRfc5424;

  return {
    name: 'syslog',

    async connect(): Promise<void> {
      /* Nothing to do eagerly — see the module comment above: connecting
       * happens per send() batch, not once per VU. */
    },

    async send(events): Promise<SendResult> {
      // MUST NOT throw AND MUST NOT reject (types.ts). Every step below —
      // formatting, the socket lifecycle, the write — is inside try/finally
      // so a failure anywhere becomes a returned SendResult, and the
      // socket is always destroyed exactly once on every exit path.
      let s: Socket | null = null;
      let socketError = '';
      try {
        // Building the payload can throw: formatRfc5424/formatRfc3164 call
        // `new Date(e.ts_ms).toISOString()`, which throws RangeError for a
        // non-finite/out-of-range ts_ms, and frame()'s UTF-8 byte counting
        // uses encodeURIComponent, which throws URIError on a lone
        // surrogate in body. Both are real, reachable throws — this MUST
        // stay inside the try, not run ahead of it.
        const payload = events.map((e) => frame(format(e, appName), framing)).join('');

        s = new Socket();
        s.on('error', (err) => {
          // 'error' fires asynchronously and independently of any write()
          // call — e.g. the socket's background read loop detecting a
          // reset connection while idle. It is not implied by a write()
          // rejection, nor does it imply one; both paths are handled
          // below.
          socketError = formatSocketError(err);
        });

        try {
          await s.connect({ port, host, tls });
        } catch (err) {
          return {
            ok: false,
            status: 'connect-failed',
            wire_bytes: null,
            accepted: null,
            rejected: null,
            error: formatSocketError(err),
          };
        }

        await s.write(payload);
        if (socketError) {
          return {
            ok: false,
            status: 'socket-error',
            wire_bytes: null,
            accepted: null,
            rejected: null,
            error: socketError,
          };
        }
        // Consistent with null.ts/otlp-http.ts/hec.ts: wire_bytes is the
        // formatted string's .length, a metric, not the protocol-correctness
        // byte count that frame() computes internally for octet-counting.
        // Syslog over TCP has no acknowledgement at all, let alone a
        // partial one: a completed write is the only signal there is, so
        // the batch counts as fully accepted (unlike OTLP — see
        // otlp-partial.ts).
        return {
          ok: true,
          status: 'written',
          wire_bytes: payload.length,
          accepted: events.length,
          rejected: 0,
        };
      } catch (err) {
        // write() rejecting, or the payload-build throw noted above — both
        // land here, separate from the 'error'-event path handled above.
        // formatSocketError falls back to String(err) for these (neither
        // is TCPError-shaped per the source reading above) — reused here
        // too so nothing on this path regresses to "[object Object]" if a
        // future xk6-tcp version ever rejects write() with a TCPError.
        return {
          ok: false,
          status: 'exception',
          wire_bytes: null,
          accepted: null,
          rejected: null,
          error: formatSocketError(err),
        };
      } finally {
        // MUST run on every path, including the two early returns above:
        // a Socket left undestroyed hangs the whole k6 process (see the
        // module comment), not just this iteration.
        if (s) {
          try {
            s.destroy();
          } catch {
            /* already closed */
          }
        }
      }
    },

    async close(): Promise<void> {
      /* Nothing persistent to release: send() destroys its own socket on
       * every call, including failures — see the module comment above. */
    },
  };
};
