// tests/aggregator/cli.test.ts — asserts the tree ON DISK matches what the
// renderers produce right now. This is the drift gate in unit-test form, so a
// stale committed config fails locally and not only in CI.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { LOG_TYPES } from '../../src/logtypes/registry.ts';
import { renderVectorTransform } from '../../src/aggregator/vector.ts';
import { renderCriblPipeline } from '../../src/aggregator/cribl.ts';

const ROOT = join(__dirname, '../../aggregator-configs');

describe('committed aggregator-configs tree', () => {
  it('has a config per type per vendor', () => {
    for (const name of Object.keys(LOG_TYPES)) {
      expect(existsSync(join(ROOT, name, 'vector', 'transform.json')), `${name} vector`).toBe(true);
      expect(existsSync(join(ROOT, name, 'cribl', 'pipeline.json')), `${name} cribl`).toBe(true);
    }
  });

  it('is byte-identical to what the renderers produce today', () => {
    // If this fails, someone changed a definition and did not regenerate.
    for (const [name, def] of Object.entries(LOG_TYPES)) {
      expect(readFileSync(join(ROOT, name, 'vector', 'transform.json'), 'utf8'))
        .toBe(renderVectorTransform(def).content);
      expect(readFileSync(join(ROOT, name, 'cribl', 'pipeline.json'), 'utf8'))
        .toBe(renderCriblPipeline(def).content);
    }
  });

  it('contains no real cloud region or hostname', () => {
    for (const name of Object.keys(LOG_TYPES)) {
      for (const p of ['vector/transform.json', 'cribl/pipeline.json']) {
        const text = readFileSync(join(ROOT, name, p), 'utf8');
        expect(text).not.toMatch(/\b(us|eu|ap|ca|sa|me|af)-(gov-)?[a-z]+-\d\b/);
        expect(text).not.toMatch(/amazonaws|\.internal\b/);
      }
    }
  });
});
