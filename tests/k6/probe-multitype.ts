import { profileName, readOverrides, readTypeOverrides } from '../../src/config/env.ts';
import { validateProfile, type Profile } from '../../src/config/schema.ts';
import { resolveRun } from '../../src/config/resolve.ts';
import { buildThresholds } from '../../src/metrics/thresholds.ts';
import { buildGenerator, type BatchGenerator } from '../../src/payload/generator.ts';

export const options = { vus: 1, iterations: 1 };

// Construction happens in init context (module scope): a throw here aborts
// the run with a non-zero exit code, whereas a throw inside the default
// function is treated as an iteration error and does NOT fail the run's
// exit code — verified behaviour of this k6 binary (see
// probe-transport-init.ts). This probe builds the same scenario map and
// generators src/main.ts builds, all here in init context, so it can only
// report success if that construction genuinely succeeds.
const PROFILE_NAME = profileName();
const PROFILE_TEXT = open(`../../profiles/${PROFILE_NAME}.json`);

let raw: unknown;
try {
  raw = JSON.parse(PROFILE_TEXT);
} catch (e) {
  throw new Error(
    `profile "${PROFILE_NAME}" is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
  );
}

const validation = validateProfile(raw);
if (!validation.ok) {
  throw new Error(`profile "${PROFILE_NAME}" is invalid:\n  - ${validation.errors.join('\n  - ')}`);
}

const profile = raw as Profile;
const typeOverrides = readTypeOverrides(Object.keys(profile.types));

const overrides = readOverrides();
// RUN_ID is required by resolveRun but irrelevant to what this probe
// checks (scenario construction, not artifact naming), so default it
// rather than requiring the caller to set it for a throwaway probe run.
if (!overrides.run_id) overrides.run_id = 'probe-multitype';

const run = resolveRun(profile, overrides, typeOverrides);

// Mirrors src/main.ts's init-context block exactly: the scenario key IS the
// log type name (dispatch key + k6 scenario tag), one generator per type.
const scenarios: Record<string, unknown> = {};
const GENERATORS: Record<string, BatchGenerator> = {};
for (const type of run.active_types) {
  const resolved = run.types[type];
  scenarios[type] = resolved.k6;
  GENERATORS[type] = buildGenerator(resolved.payload, {
    run_id: run.run_id,
    gen_index: run.gen_index,
  });
}

// Exercise buildThresholds the same way main.ts does, so a Task 7 init
// error (e.g. a wrong aggregation-method expression) would fail this probe
// too, not just a real run.
buildThresholds({
  profile_thresholds: run.profile.thresholds,
  abort_on_fail: false,
  active_types: run.active_types,
});

console.log('SCENARIOS ' + Object.keys(scenarios).sort().join(','));

export default function () {
  /* construction already verified above, in init context */
}
