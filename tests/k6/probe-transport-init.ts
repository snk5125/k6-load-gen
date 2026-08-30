import { createTransport } from '../../src/transports/registry.ts';

export const options = { vus: 1, iterations: 1 };

export default function () {
  const t = createTransport('otlp-grpc', {
    endpoint: '127.0.0.1:4317',
    options: { plaintext: true },
  });
  console.log('TRANSPORT_INIT_OK ' + t.name);

  const n = createTransport('null', {});
  console.log('NULL_INIT_OK ' + n.name);
}
