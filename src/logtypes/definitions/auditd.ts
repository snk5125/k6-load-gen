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
    { name: 'arch', spec: { cardinality: 2 } },
    { name: 'syscall', spec: { cardinality: 40, distribution: 'zipf' } },
    { name: 'success', spec: { values: ['yes', 'no'], weights: [0.95, 0.05] } },
    { name: 'exit', spec: { cardinality: 15, distribution: 'zipf' } },
    { name: 'uid', spec: { cardinality: 800, distribution: 'zipf' } },
    { name: 'gid', spec: { cardinality: 200, distribution: 'zipf' } },
    { name: 'exe', spec: { cardinality: 'unbounded', prefix: '/usr/bin/host-' } },
    { name: 'key', spec: { cardinality: 10 } },
  ],
};
