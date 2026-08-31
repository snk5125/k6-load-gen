import type { LogTypeDef } from '../types.ts';

/**
 * Linux auditd SYSCALL record. `type` is fixed by the grammar (every record
 * in this stream is a SYSCALL record), and auditd carries no severity field
 * at all — every event is emitted at INFO.
 */
export const auditd: LogTypeDef = {
  name: 'auditd',
  family: 'kv-audit',
  constants: { type: 'SYSCALL' },
  severity: { const: 'INFO' },
  fields: [
    // arch is a hex token (c000003e), not a number — stays string.
    { name: 'arch', spec: { cardinality: 2 }, parse: { type: 'string' } },
    // prefix: '' — typed int below, so the pool must generate bare digits,
    // not the default `${name}-${i}`. See FieldSpec.prefix in payload/types.ts.
    {
      name: 'syscall',
      spec: { cardinality: 40, distribution: 'zipf', prefix: '' },
      parse: { type: 'int' },
    },
    {
      name: 'success',
      spec: { values: ['yes', 'no'], weights: [0.95, 0.05] },
      parse: { type: 'string', index: true },
    },
    {
      name: 'exit',
      spec: { cardinality: 15, distribution: 'zipf', prefix: '' },
      parse: { type: 'int' },
    },
    {
      name: 'uid',
      spec: { cardinality: 800, distribution: 'zipf', prefix: '' },
      parse: { type: 'int', index: true },
    },
    {
      name: 'gid',
      spec: { cardinality: 200, distribution: 'zipf', prefix: '' },
      parse: { type: 'int' },
    },
    {
      name: 'exe',
      spec: { cardinality: 'unbounded', prefix: '/usr/bin/host-' },
      parse: { type: 'string', index: true },
    },
    { name: 'key', spec: { cardinality: 10 }, parse: { type: 'string', index: true } },
  ],
};
