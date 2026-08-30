import { createTransport } from '../../src/transports/registry.ts';

export const options = { vus: 1, iterations: 1 };

export default async function () {
  const t = createTransport('otlp-http', {
    endpoint: 'http://127.0.0.1:4318',
    options: { encoding: 'json' },
  });
  console.log('OTLP_HTTP_INIT_OK ' + t.name);
}
