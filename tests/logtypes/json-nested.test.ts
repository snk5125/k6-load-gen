import { describe, it, expect } from 'vitest';
import { jsonNested } from '../../src/logtypes/families/json-nested.ts';
import { cloudtrail } from '../../src/logtypes/definitions/cloudtrail.ts';
import { parseWithArtifact } from './parse-with-artifact.ts';
import { buildField } from '../../src/payload/fields.ts';

const vals = {
  eventName: 'Action0', awsRegion: 'region-3', sourceIPAddress: '10.0.4.31',
  'userIdentity.type': 'AssumedRole', 'userIdentity.arn': 'arn:synthetic::0:role/r-7',
};

describe('json-nested', () => {
  it('wraps the record in the declared envelope', () => {
    const body = JSON.parse(jsonNested.serialize(cloudtrail, vals, 1000, 1));
    expect(Array.isArray(body.Records)).toBe(true);
    expect(body.Records).toHaveLength(1);
  });

  it('places dotted-path fields at their nested position, not as flat keys', () => {
    const rec = JSON.parse(jsonNested.serialize(cloudtrail, vals, 1000, 1)).Records[0];
    expect(rec.userIdentity.arn).toBe('arn:synthetic::0:role/r-7');
    expect(rec['userIdentity.arn']).toBeUndefined();
  });

  it('emits eventTime as an ISO-8601 timestamp derived from ts_ms', () => {
    const rec = JSON.parse(jsonNested.serialize(cloudtrail, vals, 1788130943000, 1)).Records[0];
    // Computed directly rather than copied from the brief: new
    // Date(1788130943000).toISOString() === '2026-08-30T23:02:23.000Z'.
    expect(rec.eventTime).toBe('2026-08-30T23:02:23.000Z');
  });

  it('carries the constants declared by the definition', () => {
    const rec = JSON.parse(jsonNested.serialize(cloudtrail, vals, 1000, 1)).Records[0];
    expect(rec.eventVersion).toBe('1.08');
  });

  it('produces valid JSON when a value contains a quote or a newline', () => {
    // JSON.stringify handles this, but the test pins that we never hand-build JSON.
    const body = jsonNested.serialize(cloudtrail, { ...vals, eventName: 'a"b\nc' }, 1000, 1);
    expect(() => JSON.parse(body)).not.toThrow();
    expect(body).not.toMatch(/\n/);
  });

  it('reports a nested json parse artifact naming the envelope', () => {
    expect(jsonNested.parseArtifact(cloudtrail)).toEqual({
      kind: 'json', nested: true, envelope: { wrap: 'Records' },
    });
  });
});

describe('json-nested round trip via parseWithArtifact', () => {
  it('recovers the record (envelope-unwrapped) from a serialized event', () => {
    const body = jsonNested.serialize(cloudtrail, vals, 1000, 1);
    const artifact = jsonNested.parseArtifact(cloudtrail);
    const rec = parseWithArtifact(artifact, body) as Record<string, any>;
    expect(rec.eventName).toBe('Action0');
    expect(rec.awsRegion).toBe('region-3');
    expect(rec.sourceIPAddress).toBe('10.0.4.31');
    expect(rec.userIdentity).toEqual({ type: 'AssumedRole', arn: 'arn:synthetic::0:role/r-7' });
  });
});

describe('json-nested round trip using the real generator', () => {
  // Every test above hand-supplies field values as literals. This builds
  // values the way the real generator does (buildField, driven by
  // cloudtrail's own FieldSpecs) and proves every one of them survives
  // serialize + parseWithArtifact, across several ordinals, following the
  // six-ordinal pattern used for nginx-access in regex-clf.test.ts.
  it("round-trips values built by buildField from cloudtrail's own FieldSpecs", () => {
    const generators = Object.fromEntries(
      cloudtrail.fields.map((f) => [f.name, buildField(f.name, f.spec)]),
    );
    const artifact = jsonNested.parseArtifact(cloudtrail);

    for (const seq of [0, 1, 7, 250, 799, 12345]) {
      const values = Object.fromEntries(
        cloudtrail.fields.map((f) => [f.name, generators[f.name].valueAt(seq)]),
      );
      const body = jsonNested.serialize(cloudtrail, values, 1788130943351, seq);
      const rec = parseWithArtifact(artifact, body) as Record<string, any>;

      for (const f of cloudtrail.fields) {
        const path = (f.path ?? f.name).split('.');
        const got = path.reduce((o: any, k: string) => (o == null ? o : o[k]), rec);
        expect(got).toBe(values[f.name]);
      }
    }
  });
});
