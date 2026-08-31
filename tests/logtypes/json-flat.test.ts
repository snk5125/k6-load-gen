import { describe, it, expect } from 'vitest';
import { jsonFlat } from '../../src/logtypes/families/json-flat.ts';
import { jsonApp } from '../../src/logtypes/definitions/json-app.ts';

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
});
