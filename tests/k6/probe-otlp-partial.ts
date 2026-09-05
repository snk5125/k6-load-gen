// A k6 PROBE, not a vitest suite (vitest only collects tests/**/*.test.ts).
// It exists to prove, against the real k6 runtime and a real HTTP round
// trip, the one thing the exhaustive unit tests in
// tests/transports/otlp-partial.test.ts cannot: that the OTLP/HTTP transport
// actually reaches `classifyOtlpHttpResponse` with the body k6 hands it, and
// reports accepted/rejected instead of a clean 200.
//
// HOW TO RUN IT
//
//   1. Start a stub receiver that answers 200 with a partialSuccess body —
//      any HTTP server will do; this one needs no dependencies:
//
//        python3 -c '
//        import http.server, json
//        class H(http.server.BaseHTTPRequestHandler):
//            def do_POST(self):
//                self.rfile.read(int(self.headers["Content-Length"]))
//                body = json.dumps({"partialSuccess": {
//                    "rejectedLogRecords": "2",
//                    "errorMessage": "stub: index full"}}).encode()
//                self.send_response(200)
//                self.send_header("Content-Type", "application/json")
//                self.send_header("Content-Length", str(len(body)))
//                self.end_headers()
//                self.wfile.write(body)
//            def log_message(self, *a): pass
//        http.server.HTTPServer(("127.0.0.1", 4318), H).serve_forever()' &
//
//   2. k6 run tests/k6/probe-otlp-partial.ts
//
// EXPECT: a line reading
//   OTLP_PARTIAL ok=false accepted=3 rejected=2 error=OTLP partial success: 2 of 5 ...
// A run that prints `ok=true accepted=5 rejected=0` against that stub is the
// regression this whole task exists to prevent: the receiver refused two
// records on a 200 and the generator counted all five as sent.
//
// Set OTLP_PARTIAL_ENDPOINT to point at a real collector instead of the stub.

import { createTransport } from '../../src/transports/registry.ts';
import type { LogEvent } from '../../src/payload/types.ts';

export const options = { vus: 1, iterations: 1 };

const BATCH_SIZE = 5;

// Init context, deliberately: a construction failure must abort the run with
// a non-zero exit code rather than be swallowed as an iteration error (see
// tests/k6/probe-otlp-http.ts for the full reasoning).
const transport = createTransport('otlp-http', {
  endpoint: __ENV.OTLP_PARTIAL_ENDPOINT || 'http://127.0.0.1:4318',
  options: { encoding: 'json' },
});

function event(seq: number): LogEvent {
  return {
    ts_ms: Date.now(),
    severity: 'INFO',
    body: `probe-otlp-partial event ${seq}`,
    fields: { probe: 'otlp-partial' },
    run_id: 'probe-otlp-partial',
    gen_index: 0,
    type: 'probe',
    seq,
  };
}

export default async function (): Promise<void> {
  const batch = Array.from({ length: BATCH_SIZE }, (_, i) => event(i));
  await transport.connect();
  const res = await transport.send(batch, {
    run_id: 'probe-otlp-partial',
    gen_index: 0,
    iteration: 0,
  });
  console.log(
    `OTLP_PARTIAL ok=${res.ok} status=${String(res.status)} ` +
      `batch=${batch.length} accepted=${String(res.accepted)} rejected=${String(res.rejected)} ` +
      `error=${res.error ?? ''} advisory=${res.advisory ?? ''}`,
  );
  await transport.close();
}
