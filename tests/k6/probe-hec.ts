import { createTransport } from '../../src/transports/registry.ts';

export const options = { vus: 1, iterations: 1 };

export default async function () {
  const t = createTransport('hec', {
    endpoint: 'https://example.com:8088',
    options: {},
  });
  console.log('HEC_INIT_OK ' + t.name);
}
