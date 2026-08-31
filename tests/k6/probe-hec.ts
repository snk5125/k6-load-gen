import { createTransport } from '../../src/transports/registry.ts';

export const options = { vus: 1, iterations: 1 };

// Construction happens in init context (module scope), not inside the
// default function: a throw here aborts the run with a non-zero exit code
// (k6 init-context error), whereas a throw inside the default function is
// treated as an iteration error and does NOT fail the run's exit code. A
// probe that can't fail proves nothing — and that matters here specifically,
// because the whole point of this probe is to prove that a missing
// HEC_TOKEN fails loudly.
const t = createTransport('hec', {
  endpoint: 'https://example.com:8088',
  options: {},
});
console.log('HEC_INIT_OK ' + t.name);

export default function () {
  /* construction already verified above, in init context */
}
