import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LOG_TYPES } from '../logtypes/registry.ts';
import { renderVectorTransform } from './vector.ts';
import { renderCriblPipeline } from './cribl.ts';

// Node entrypoint. Regenerates the committed aggregator-configs/ tree from
// the live renderers, driven by LOG_TYPES — the same source the load
// generator emits from. Writes ONLY under aggregator-configs/: this is what
// keeps the CI drift gate (`npm run aggregator-configs && git diff
// --exit-code -- aggregator-configs/`) trustworthy, since a script that
// wrote elsewhere could pass that check while leaving unrelated drift.
//
// Layout (spec §6.1):
//   aggregator-configs/<type>/cribl/pipeline.json
//   aggregator-configs/<type>/vector/transform.json

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT_ROOT = join(REPO_ROOT, 'aggregator-configs');

export function generate(): void {
  for (const def of Object.values(LOG_TYPES)) {
    const vector = renderVectorTransform(def);
    const vectorDir = join(OUT_ROOT, def.name, 'vector');
    mkdirSync(vectorDir, { recursive: true });
    writeFileSync(join(vectorDir, vector.filename), vector.content);

    const cribl = renderCriblPipeline(def);
    const criblDir = join(OUT_ROOT, def.name, 'cribl');
    mkdirSync(criblDir, { recursive: true });
    writeFileSync(join(criblDir, cribl.filename), cribl.content);
  }
}

// A substring match on process.argv[1] (the previous check here) rewrites
// the committed tree as a side effect of merely importing this module from
// any checkout path that happens to contain "cli" — comparing resolved URLs
// is the actual "am I the entrypoint" check (whole-branch review, promoted
// minor: src/aggregator/cli.ts:36).
if (
  typeof process !== 'undefined' &&
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  generate();
}
