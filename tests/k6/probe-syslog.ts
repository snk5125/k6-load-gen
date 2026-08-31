import { createTransport } from '../../src/transports/registry.ts';

export const options = { vus: 1, iterations: 1 };

// Construction happens in init context (module scope), not inside the
// default function: a throw here aborts the run with a non-zero exit code
// (k6 init-context error), whereas a throw inside the default function is
// treated as an iteration error and does NOT fail the run's exit code. A
// probe that can't fail proves nothing.
//
// This probe does not call connect() or send(): neither the factory nor
// connect() constructs a `k6/x/tcp` Socket — send() does, once per batch,
// and destroys it again before returning (see the module comment in
// src/transports/syslog.ts). Verified live that an undestroyed Socket
// hangs the whole k6 process at shutdown even after a fully successful
// connect+write, which is why send() owns the Socket's entire lifecycle
// itself rather than leaving cleanup to a caller — this probe has nothing
// extra to clean up because construction alone (what it exercises) never
// touches k6/x/tcp at all.
const t = createTransport('syslog', {
  endpoint: '127.0.0.1:1',
  options: { rfc: 5424, framing: 'octet-counted', tls: false, app_name: 'k6' },
});
console.log('SYSLOG_INIT_OK ' + t.name);

export default function () {
  /* construction already verified above, in init context */
}
