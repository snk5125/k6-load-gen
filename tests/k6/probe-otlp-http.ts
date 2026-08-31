import { createTransport } from '../../src/transports/registry.ts';

export const options = { vus: 1, iterations: 1 };

// Construction happens in init context (module scope), not inside the
// default function: a throw here aborts the run with a non-zero exit code
// (k6 init-context error), whereas a throw inside the default function is
// treated as an iteration error and does NOT fail the run's exit code. A
// probe that can't fail proves nothing.
const t = createTransport('otlp-http', {
  endpoint: 'http://127.0.0.1:4318',
  options: { encoding: 'json' },
});
console.log('OTLP_HTTP_INIT_OK ' + t.name);

export default function () {
  /* construction already verified above, in init context */
}
