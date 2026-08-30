import { Socket } from 'k6/x/tcp';
import type { SendResult, TransportFactory } from './types.ts';
import { formatRfc5424, formatRfc3164, frame } from './syslog-format.ts';

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

  let socket: Socket | null = null;
  let lastError = '';

  // Closure-scoped, not a method reached via `this`: send() below needs to
  // reach this without relying on `this` binding, which is exactly the
  // fragility the plan warns about — `this` is not reliably bound when a
  // Transport's methods are destructured or invoked through the interface
  // rather than as `transport.close()`. Same pattern as otlp-grpc.ts's
  // closeClient().
  function closeSocket(): void {
    try {
      if (socket) socket.destroy();
    } catch {
      /* already closed */
    }
    socket = null;
  }

  return {
    name: 'syslog',

    async connect(): Promise<void> {
      // MUST NOT reject: a rejected connect() aborts the iteration before
      // send() can report the failure through the normal counters, leaving
      // every metric with zero samples on a total outage.
      //
      // Defensive, not required by src/main.ts's own call pattern (it only
      // re-calls connect() after a send() failure, which already closed the
      // prior socket): if some other caller invokes connect() twice while a
      // socket is still live, this closes it first rather than leaking an
      // undestroyed Socket's background goroutine.
      closeSocket();
      const s = new Socket();
      s.on('error', (err) => {
        // 'error' fires asynchronously and independently of any write()
        // call — e.g. the socket's background read loop detecting a reset
        // connection while idle. It is not implied by a write() rejection,
        // nor does it imply one; both paths are handled (see send() below).
        lastError = `${err.name} during ${err.method}: ${err.message}`;
      });
      try {
        await s.connect({ port, host, tls });
        socket = s;
        lastError = '';
      } catch (err) {
        // MUST destroy here even though nothing else references `s`:
        // verified live against xk6-tcp v0.3.1 that a Socket left
        // undestroyed after connect() rejects hangs the ENTIRE k6 process at
        // shutdown (not just this iteration) — its background event-loop
        // goroutine never exits. The plan's draft code skipped this and
        // would have hung on every connection failure. See src/k6-x-tcp.d.ts.
        try {
          s.destroy();
        } catch {
          /* already closed */
        }
        socket = null;
        lastError = String(err);
      }
    },

    async send(events): Promise<SendResult> {
      if (!socket) {
        return { ok: false, status: 'not-connected', wire_bytes: null, error: lastError || 'connect failed' };
      }
      // One write per batch: the framing delimits individual messages, so
      // concatenating them is correct and far cheaper than a write per event.
      const payload = events.map((e) => frame(format(e, appName), framing)).join('');
      try {
        await socket.write(payload);
        if (lastError) {
          // An async 'error' event landed (see the handler above) without
          // write() itself rejecting — surface it as this send's failure.
          const err = lastError;
          lastError = '';
          closeSocket();
          return { ok: false, status: 'socket-error', wire_bytes: null, error: err };
        }
        // Consistent with null.ts/otlp-http.ts/hec.ts: wire_bytes is the
        // formatted string's .length, a metric, not the protocol-correctness
        // byte count that frame() computes internally for octet-counting.
        return { ok: true, status: 'written', wire_bytes: payload.length };
      } catch (err) {
        // write() rejecting is the other failure path — a raw write error
        // (e.g. the connection was already gone), separate from the
        // 'error'-event path above. Both are handled; neither implies the
        // other.
        closeSocket();
        return { ok: false, status: 'exception', wire_bytes: null, error: String(err) };
      }
    },

    async close(): Promise<void> {
      closeSocket();
    },
  };
};
