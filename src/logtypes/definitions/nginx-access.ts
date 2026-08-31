import type { LogTypeDef } from '../types.ts';

/**
 * nginx access log, Combined Log Format. Access logs carry no severity
 * field — every event is emitted at INFO, same reasoning as auditd.
 *
 * remote_user, server_protocol, and http_referer are near-constant in
 * practice ('-', 'HTTP/1.1', '-') but modeled as low-cardinality fields
 * rather than `constants` on the def, since a real deployment does see
 * occasional variation (an authenticated user, an HTTP/1.0 client, a
 * referrer header) that a fixed constant couldn't represent.
 */
export const nginxAccess: LogTypeDef = {
  name: 'nginx-access',
  family: 'regex-clf',
  severity: { const: 'INFO' },
  fields: [
    { name: 'remote_addr', spec: { cardinality: 2000, distribution: 'zipf' } },
    { name: 'remote_user', spec: { values: ['-'] } },
    {
      name: 'request_method',
      spec: { values: ['GET', 'POST', 'PUT', 'DELETE'], weights: [0.7, 0.2, 0.07, 0.03] },
    },
    { name: 'request_uri', spec: { cardinality: 'unbounded', prefix: '/api/v2/items?id=' } },
    { name: 'server_protocol', spec: { values: ['HTTP/1.1'] } },
    {
      name: 'status',
      spec: { values: ['200', '301', '404', '500'], weights: [0.85, 0.05, 0.07, 0.03] },
    },
    // prefix: '' — the pattern requires \d+ here; the default `${name}-${i}`
    // naming scheme is not digits. See FieldSpec.prefix in payload/types.ts.
    { name: 'body_bytes_sent', spec: { cardinality: 800, distribution: 'zipf', prefix: '' } },
    { name: 'http_referer', spec: { values: ['-'] } },
    { name: 'http_user_agent', spec: { cardinality: 50 } },
  ],
};
