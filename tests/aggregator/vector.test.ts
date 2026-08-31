import { describe, it, expect } from 'vitest';
import { renderVectorTransform } from '../../src/aggregator/vector.ts';
import { LOG_TYPES } from '../../src/logtypes/registry.ts';
import { FAMILIES } from '../../src/logtypes/families/index.ts';

const parse = (def: (typeof LOG_TYPES)[string]) =>
  JSON.parse(renderVectorTransform(def).content);

describe('renderVectorTransform', () => {
  it('names the file for the vendor and emits parseable JSON', () => {
    const r = renderVectorTransform(LOG_TYPES.auditd);
    expect(r.filename).toBe('transform.json');
    expect(() => JSON.parse(r.content)).not.toThrow();
  });

  it('uses parse_regex with the family pattern for a regex format', () => {
    // The pattern must be the artifact's, not a copy — that is the whole point.
    const src = parse(LOG_TYPES['nginx-access']);
    const vrl = JSON.stringify(src.transforms);
    expect(vrl).toContain('parse_regex');
    expect(vrl).toContain('remote_addr');
  });

  it('carries the artifact pattern verbatim, not a paraphrase', () => {
    const { pattern } = FAMILIES['regex-clf'].parseArtifact(LOG_TYPES['nginx-access']) as {
      kind: 'regex'; pattern: string;
    };
    expect(JSON.stringify(parse(LOG_TYPES['nginx-access']))).toContain(JSON.stringify(pattern).slice(1, -1));
  });

  it('unrolls the envelope for a json format that declares one', () => {
    const vrl = JSON.stringify(parse(LOG_TYPES.cloudtrail).transforms);
    expect(vrl).toContain('Records');
  });

  it('does not unroll for a json format with no envelope', () => {
    expect(JSON.stringify(parse(LOG_TYPES['json-app']).transforms)).not.toContain('Records');
  });

  it('coerces int fields and leaves string fields alone', () => {
    const vrl = JSON.stringify(parse(LOG_TYPES.auditd).transforms);
    expect(vrl).toContain('to_int');
    // arch is a hex token, must not be coerced
    expect(vrl).not.toMatch(/to_int!?\(\.arch\)/);
  });

  it('throws naming the family when one has no renderer case', () => {
    // Spec 6.3: a silently-dropped field looks like a slow parser, not a broken one.
    const bogus = { ...LOG_TYPES.auditd, family: 'not-a-family' } as never;
    expect(() => renderVectorTransform(bogus)).toThrow(/not-a-family/);
  });

  it('throws from its own switch when the artifact kind itself is unhandled', () => {
    // The test above only exercises the FAMILIES Proxy's guard (an
    // unregistered family name) — it never reaches renderVectorTransform's
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
      expect(() => renderVectorTransform(bogus)).toThrow(/not-a-real-kind/);
    } finally {
      delete registry[STUB];
    }
  });

  it('pins numeric_groups on the kv parse_regex_all call', () => {
    // PAIR_REGEX (kv-audit.ts) uses unnamed capture groups; without
    // numeric_groups: true, parse_regex_all! returns only named captures
    // and every pair comes back empty — confirmed live against a real
    // auditd line (see task-2-3-report.md). Losing this flag silently
    // breaks every kv-family transform.
    const vrl = JSON.stringify(parse(LOG_TYPES.auditd).transforms);
    expect(vrl).toContain('numeric_groups');
  });

  it('unquotes a kv value the way parseWithArtifact does, not left quoted', () => {
    // formatKvValue (kv-audit.ts) quotes a value containing a space, `"`,
    // or `=`, escaping an embedded `"` as `\"`. Cribl's kvp serde
    // unquotes automatically; the Vector branch must do the inverse
    // itself or the two renderers silently disagree on the same input.
    const vrl = JSON.stringify(parse(LOG_TYPES.auditd).transforms);
    expect(vrl).toContain('starts_with');
    expect(vrl).toContain('slice');
    expect(vrl).toContain('replace');
  });

  it('is deterministic — same definition renders byte-identical output', () => {
    // The CI drift gate depends on this; a Set or Object.keys ordering wobble
    // would make the gate fail on unrelated commits.
    expect(renderVectorTransform(LOG_TYPES.auditd).content)
      .toBe(renderVectorTransform(LOG_TYPES.auditd).content);
  });
});
