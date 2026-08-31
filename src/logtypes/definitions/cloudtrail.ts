import type { LogTypeDef } from '../types.ts';

/**
 * AWS CloudTrail management-event record (spec §3.5): one record per
 * `Records[]` envelope, with `userIdentity` nested one level deep.
 * CloudTrail carries no severity field — every event is emitted at INFO,
 * same reasoning as auditd and nginx-access.
 *
 * PUBLIC REPO CONSTRAINT: `awsRegion`, `userIdentity.arn`, `eventName`, and
 * `sourceIPAddress` are field *names* only — every value they produce comes
 * from the cardinality machinery (synthetic tokens like `region-0`,
 * `arn:synthetic::0:role/r-7`), never a real AWS region, account, ARN, or
 * API action name. This repo is public; that constraint is load-bearing,
 * not cosmetic.
 */
export const cloudtrail: LogTypeDef = {
  name: 'cloudtrail',
  family: 'json-nested',
  constants: { eventVersion: '1.08' },
  severity: { const: 'INFO' },
  fields: [
    {
      name: 'userIdentity.type',
      spec: { values: ['AssumedRole', 'IAMUser', 'Root'], weights: [0.75, 0.22, 0.03] },
      parse: { type: 'string' },
    },
    {
      name: 'userIdentity.arn',
      spec: { cardinality: 'unbounded', prefix: 'arn:synthetic::0:role/r-' },
      parse: { type: 'string', index: true },
    },
    {
      name: 'eventName',
      spec: { cardinality: 40, distribution: 'zipf' },
      parse: { type: 'string', index: true },
    },
    {
      name: 'awsRegion',
      spec: { cardinality: 12, prefix: 'region-' },
      parse: { type: 'string', index: true },
    },
    {
      name: 'sourceIPAddress',
      spec: { cardinality: 5000, distribution: 'zipf' },
      parse: { type: 'ip', index: true },
    },
    { name: 'eventID', spec: { cardinality: 'unbounded' }, parse: { type: 'string' } },
  ],
  envelope: { wrap: 'Records', mode: 'array' },
};
