import { describe, it, expect } from 'vitest';
import { buildResourceLogs } from '../../src/transports/otlp-payload.ts';
import type { LogEvent } from '../../src/payload/types.ts';

const ev = (overrides: Partial<LogEvent> = {}): LogEvent => ({
  ts_ms: 1_700_000_000_000,
  severity: 'INFO',
  body: 'hello world',
  fields: { host: 'web-1', region: 'us-east' },
  run_id: 'run-abc',
  gen_index: 2,
  seq: 7,
  ...overrides,
});

describe('buildResourceLogs', () => {
  it('produces the OTLP resourceLogs envelope shape', () => {
    const payload = buildResourceLogs([ev()]);
    expect(payload).toHaveProperty('resourceLogs');
    expect(payload.resourceLogs).toHaveLength(1);
    const rl = payload.resourceLogs[0];
    expect(rl).toHaveProperty('resource.attributes');
    expect(rl.scopeLogs).toHaveLength(1);
    expect(rl.scopeLogs[0].scope).toEqual({ name: 'k6-load-gen' });
    expect(rl.scopeLogs[0].logRecords).toHaveLength(1);
  });

  it('maps one logRecord per event, preserving order', () => {
    const events = [ev({ seq: 1, body: 'a' }), ev({ seq: 2, body: 'b' }), ev({ seq: 3, body: 'c' })];
    const { resourceLogs } = buildResourceLogs(events);
    const records = resourceLogs[0].scopeLogs[0].logRecords;
    expect(records).toHaveLength(3);
    expect(records.map((r) => r.body.stringValue)).toEqual(['a', 'b', 'c']);
  });

  it('sets timeUnixNano from ts_ms and carries body/severityText verbatim', () => {
    const { resourceLogs } = buildResourceLogs([ev({ ts_ms: 42, body: 'payload', severity: 'ERROR' })]);
    const record = resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(record.timeUnixNano).toBe('42000000');
    expect(record.body).toEqual({ stringValue: 'payload' });
    expect(record.severityText).toBe('ERROR');
  });

  describe('severity mapping', () => {
    const cases: Array<[string, number]> = [
      ['TRACE', 1],
      ['DEBUG', 5],
      ['INFO', 9],
      ['WARN', 13],
      ['ERROR', 17],
      ['FATAL', 21],
    ];
    for (const [severity, expected] of cases) {
      it(`maps ${severity} to severityNumber ${expected}`, () => {
        const { resourceLogs } = buildResourceLogs([ev({ severity })]);
        expect(resourceLogs[0].scopeLogs[0].logRecords[0].severityNumber).toBe(expected);
      });
    }

    it('defaults unknown severities to the INFO number (9)', () => {
      const { resourceLogs } = buildResourceLogs([ev({ severity: 'WEIRD' })]);
      expect(resourceLogs[0].scopeLogs[0].logRecords[0].severityNumber).toBe(9);
    });
  });

  it('carries run_id, gen_index, and seq as log record attributes', () => {
    const { resourceLogs } = buildResourceLogs([ev({ run_id: 'run-xyz', gen_index: 5, seq: 99 })]);
    const attrs = resourceLogs[0].scopeLogs[0].logRecords[0].attributes;
    expect(attrs).toEqual([
      { key: 'run_id', value: { stringValue: 'run-xyz' } },
      { key: 'gen_index', value: { intValue: '5' } },
      { key: 'seq', value: { intValue: '99' } },
    ]);
  });

  it('does not put generated fields on the log record attributes (they travel in the body only)', () => {
    const { resourceLogs } = buildResourceLogs([ev({ fields: { host: 'web-1', region: 'us-east' } })]);
    const attrs = resourceLogs[0].scopeLogs[0].logRecords[0].attributes;
    const keys = attrs.map((a) => a.key);
    expect(keys).not.toContain('host');
    expect(keys).not.toContain('region');
    expect(keys).toEqual(['run_id', 'gen_index', 'seq']);
  });

  it('always sets service.name on the resource, even with no extra attributes', () => {
    const { resourceLogs } = buildResourceLogs([ev()]);
    expect(resourceLogs[0].resource.attributes).toEqual([
      { key: 'service.name', value: { stringValue: 'k6-load-gen' } },
    ]);
  });

  it('appends resource_attributes after service.name, in enumeration order', () => {
    const { resourceLogs } = buildResourceLogs([ev()], { env: 'staging', team: 'platform' });
    expect(resourceLogs[0].resource.attributes).toEqual([
      { key: 'service.name', value: { stringValue: 'k6-load-gen' } },
      { key: 'env', value: { stringValue: 'staging' } },
      { key: 'team', value: { stringValue: 'platform' } },
    ]);
  });

  it('handles an empty event batch', () => {
    const { resourceLogs } = buildResourceLogs([]);
    expect(resourceLogs[0].scopeLogs[0].logRecords).toEqual([]);
  });
});
