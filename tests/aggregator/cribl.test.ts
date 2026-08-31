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

  it('keeps eventVersion and eventTime out of the envelope, not just def.fields', () => {
    // Regression for IMPORTANT 2 (whole-branch review): the envelope
    // projection used to walk only def.fields, silently dropping
    // cloudtrail's constant (eventVersion) and its always-derived
    // eventTime — the field Vector's `. = .Records[0]` keeps for free
    // and CloudTrail's canonical timestamp.
    const fns = pipeline('cloudtrail').conf.functions as Array<{
      id: string;
      conf: Record<string, unknown>;
    }>;
    const adds = fns
      .filter((f) => f.id === 'eval' && Array.isArray(f.conf.add))
      .flatMap((f) => f.conf.add as Array<{ name: string; value: string }>);
    expect(adds).toContainEqual({ name: 'eventVersion', value: 'Records[0].eventVersion' });
    expect(adds).toContainEqual({ name: 'eventTime', value: 'Records[0].eventTime' });
  });

  it('regex_extract reads `source`, not `srcField`, with a delimited pattern', () => {
    // Regression for IMPORTANT 1 (whole-branch review): confirmed live
    // against a real Cribl instance that stock regex_extract functions
    // use `source`, and every stored regex is a `/…/`-delimited literal.
    const fns = pipeline('nginx-access').conf.functions as Array<{
      id: string;
      conf: Record<string, unknown>;
    }>;
    const rx = fns.find((f) => f.id === 'regex_extract')!;
    expect(rx.conf.source).toBe('_raw');
    expect(rx.conf.srcField).toBeUndefined();
    expect(typeof rx.conf.regex).toBe('string');
    expect((rx.conf.regex as string).startsWith('/')).toBe(true);
    expect((rx.conf.regex as string).endsWith('/')).toBe(true);
  });

  it('serde keeps `srcField` — the two function types are not symmetric', () => {
    // Confirmed live against the stock cisco_estreamer pipeline, which
    // uses exactly {mode, type: 'kvp', srcField: '_raw'} — do not
    // "fix" this one to `source` too.
    const fns = pipeline('auditd').conf.functions as Array<{
      id: string;
      conf: Record<string, unknown>;
    }>;
    const serde = fns.find((f) => f.id === 'serde')!;
    expect(serde.conf.srcField).toBe('rest');
    expect(serde.conf.source).toBeUndefined();
  });

  it('removes _raw after extraction for every artifact kind', () => {
    // Regression for IMPORTANT 3 (whole-branch review): Cribl never
    // removes _raw by default, unlike every Vector branch, which deletes
    // .message right after parsing — left alone, a Cribl-vs-Vector
    // ingest-byte comparison would double-count Cribl's raw line for
    // reasons attributable entirely to an undocumented config gap.
    for (const name of ['auditd', 'nginx-access', 'json-app', 'cloudtrail']) {
      const fns = pipeline(name).conf.functions as Array<{
        id: string;
        conf: Record<string, unknown>;
      }>;
      const removed = fns
        .filter((f) => f.id === 'eval' && Array.isArray(f.conf.remove))
        .flatMap((f) => f.conf.remove as string[]);
      expect(removed, `${name} should remove _raw`).toContain('_raw');
    }
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
