import { describe, it, expect } from 'vitest';
import { renderCriblPipeline } from '../../src/aggregator/cribl.ts';
import { LOG_TYPES } from '../../src/logtypes/registry.ts';
import { FAMILIES } from '../../src/logtypes/families/index.ts';

const pipeline = (name: string) => JSON.parse(renderCriblPipeline(LOG_TYPES[name]).content);

describe('renderCriblPipeline', () => {
  it('names the file and emits a pipeline with a functions array', () => {
    const r = renderCriblPipeline(LOG_TYPES.auditd);
    expect(r.filename).toBe('pipeline.json');
    expect(Array.isArray(pipeline('auditd').conf.functions)).toBe(true);
  });

  it('ids the pipeline after the log type', () => {
    expect(pipeline('auditd').id).toBe('auditd');
  });

  it('uses regex_extract carrying the family pattern for a regex format', () => {
    const fns = pipeline('nginx-access').conf.functions;
    const rx = fns.find((f: { id: string }) => f.id === 'regex_extract');
    expect(rx).toBeDefined();
    expect(JSON.stringify(rx)).toContain('remote_addr');
  });

  it('uses a kvp serde for a kv format and a json serde for a json format', () => {
    expect(JSON.stringify(pipeline('auditd').conf.functions)).toContain('kvp');
    expect(JSON.stringify(pipeline('json-app').conf.functions)).toContain('json');
  });

  it('unrolls the envelope for cloudtrail', () => {
    expect(JSON.stringify(pipeline('cloudtrail').conf.functions)).toContain('Records');
  });

  it('emits a coercion only for int-typed fields', () => {
    const s = JSON.stringify(pipeline('auditd').conf.functions);
    expect(s).toContain('uid');
    expect(s).not.toMatch(/Number\(\s*arch\s*\)/);
  });

  it('throws naming the family when one has no renderer case', () => {
    const bogus = { ...LOG_TYPES.auditd, family: 'not-a-family' } as never;
    expect(() => renderCriblPipeline(bogus)).toThrow(/not-a-family/);
  });

  it('throws from its own switch when the artifact kind itself is unhandled', () => {
    // The test above only exercises the FAMILIES Proxy's guard (an
    // unregistered family name) — it never reaches renderCriblPipeline's
    // own switch. Register a real (stub) family whose parseArtifact
    // returns a kind the switch has no case for, so the `default` arm is
    // what actually fires this time.
    const STUB = 'stub-unhandled-kind' as never;
    const registry = FAMILIES as unknown as Record<string, unknown>;
    registry[STUB] = {
      serialize: () => '',
      parseArtifact: () => ({ kind: 'not-a-real-kind' }),
    };
    try {
      const bogus = { ...LOG_TYPES.auditd, family: STUB } as never;
      expect(() => renderCriblPipeline(bogus)).toThrow(/not-a-real-kind/);
    } finally {
      delete registry[STUB];
    }
  });

  it('is deterministic', () => {
    expect(renderCriblPipeline(LOG_TYPES.auditd).content)
      .toBe(renderCriblPipeline(LOG_TYPES.auditd).content);
  });
});
