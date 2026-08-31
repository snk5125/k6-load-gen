import { describe, it, expect } from 'vitest';
import { jsonFlat } from '../../src/logtypes/families/json-flat.ts';
import { jsonApp } from '../../src/logtypes/definitions/json-app.ts';
import type { LogTypeDef } from '../../src/logtypes/types.ts';
import { parseWithArtifact } from './parse-with-artifact.ts';

// json-app has no envelope, so it never exercises that branch of
// parseArtifact/serialize. This fixture stands in for a future
// envelope-carrying json-flat type (e.g. something CloudTrail-shaped).
const enveloped: LogTypeDef = {
  name: 'test-enveloped',
  family: 'json-flat',
  fields: [],
  envelope: { wrap: 'Records', mode: 'array' },
};

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
    expect(jsonFlat.parseArtifact(enveloped)).toEqual({
      kind: 'json',
      nested: false,
      envelope: { wrap: 'Records' },
    });
  });

  it('round-trips through parseWithArtifact', () => {
    // The important claim isn't "parseArtifact returns some object" — it's
    // that the returned descriptor is actually sufficient to parse the body
    // serialize produced. parseWithArtifact is driven entirely by the
    // artifact, so a drift between serialize and parseArtifact fails this
    // assertion rather than passing unnoticed.
    const values = { host: 'h9', level: 'ERROR', trace_id: 't-1' };
    const body = jsonFlat.serialize(jsonApp, values, 5000, 42);
    const artifact = jsonFlat.parseArtifact(jsonApp);
    expect(parseWithArtifact(artifact, body)).toEqual({ ...values, seq: 42 });
  });

  it('round-trips an enveloped record through parseWithArtifact', () => {
    // This is the case where the artifact genuinely changes what the parse
    // does — envelope unwrapping only happens because parseArtifact said to.
    const values = { host: 'h3', level: 'INFO' };
    const body = jsonFlat.serialize(enveloped, values, 5000, 3);
    const artifact = jsonFlat.parseArtifact(enveloped);
    expect(parseWithArtifact(artifact, body)).toEqual({ ...values, seq: 3 });
  });
});
