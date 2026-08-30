import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { validateProfile } from '../../src/config/schema.ts';

const PROFILES_DIR = resolve(__dirname, '../../profiles');

function readAllProfiles(): Array<[name: string, text: string]> {
  return readdirSync(PROFILES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => [f, readFileSync(join(PROFILES_DIR, f), 'utf8')]);
}

describe('committed profiles', () => {
  for (const [name, text] of readAllProfiles()) {
    it(`${name} validates`, () => {
      const r = validateProfile(JSON.parse(text));
      expect(r.errors).toEqual([]);
      expect(r.ok).toBe(true);
    });
  }

  it('no committed profile contains a literal secret', () => {
    for (const [name, text] of readAllProfiles()) {
      expect(text, `${name} must name an env var, not hold a value`).not.toMatch(
        /"(token|api_key|apikey|password|secret|authorization)"\s*:/i,
      );
    }
  });
});
