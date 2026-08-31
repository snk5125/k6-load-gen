import { describe, it, expect } from 'vitest';
import { jsonFlat } from '../../src/logtypes/families/json-flat.ts';
import { jsonApp } from '../../src/logtypes/definitions/json-app.ts';
import type { LogTypeDef } from '../../src/logtypes/types.ts';

describe('json-flat family', () => {
  it('emits the same body shape the old template produced', () => {
    const body = jsonFlat.serialize(jsonApp, { host: 'h1', level: 'WARN' }, 1000, 7);
    expect(JSON.parse(body)).toEqual({ host: 'h1', level: 'WARN', seq: 7 });
  });

  it('never emits a newline', () => {
    const body = jsonFlat.serialize(jsonApp, { host: 'a\nb' }, 1000, 0);
    expect(body).not.toMatch(/\n/);
  });

  it('reports a json parse artifact', () => {
    expect(jsonFlat.parseArtifact(jsonApp)).toEqual({ kind: 'json', nested: false });
  });

  it('folds the envelope into the parse artifact when the def declares one', () => {
    // json-app has no envelope, so the test above never exercises this branch.
    // A local fixture stands in for a future envelope-carrying json-flat type.
    const enveloped: LogTypeDef = {
      name: 'test-enveloped',
      family: 'json-flat',
      fields: [],
      envelope: { wrap: 'Records', mode: 'array' },
    };
    expect(jsonFlat.parseArtifact(enveloped)).toEqual({
      kind: 'json',
      nested: false,
      envelope: { wrap: 'Records' },
    });
  });

  it('round-trips: parseArtifact describes how to read back what serialize wrote', () => {
    // The important claim isn't "parseArtifact returns some object" — it's
    // that the returned descriptor is actually sufficient to parse the body
    // serialize produced, and recover the original field values.
    const values = { host: 'h9', level: 'ERROR', trace_id: 't-1' };
    const body = jsonFlat.serialize(jsonApp, values, 5000, 42);
    const artifact = jsonFlat.parseArtifact(jsonApp);

    expect(artifact.kind).toBe('json');
    if (artifact.kind !== 'json') throw new Error('expected a json artifact');
    expect(artifact.nested).toBe(false);

    // A non-nested json artifact promises a flat JSON.parse is all reading
    // it back requires — no envelope unwrapping, no path traversal.
    const parsedBack = JSON.parse(body);
    expect(parsedBack).toEqual({ ...values, seq: 42 });
  });
});
