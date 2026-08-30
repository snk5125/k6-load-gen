import { createTransport } from '../../src/transports/registry.ts';

export const options = { vus: 1, iterations: 1 };

// Construction happens in init context (module scope), not inside the
// default function: a throw here aborts the run with a non-zero exit code
// (k6 init-context error), whereas a throw inside the default function is
// treated as an iteration error and does NOT fail the run's exit code. A
// probe that can't fail proves nothing.
//
// This probe deliberately does NOT call connect(): createSyslogTransport's
// factory does not construct a `k6/x/tcp` Socket itself (connect() does,
// lazily) — verified live that a Socket constructed and never connected
// nor destroyed hangs the whole k6 process at shutdown, so a probe that DID
// connect here would need to also close() before the script ends.
const t = createTransport('syslog', {
  endpoint: '127.0.0.1:1',
  options: { rfc: 5424, framing: 'octet-counted', tls: false, app_name: 'k6' },
});
console.log('SYSLOG_INIT_OK ' + t.name);

export default function () {
  /* construction already verified above, in init context */
}
