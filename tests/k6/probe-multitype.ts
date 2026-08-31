import { profileName, readOverrides, readTypeOverrides } from '../../src/config/env.ts';
import { validateProfile, type Profile } from '../../src/config/schema.ts';
import { resolveRun } from '../../src/config/resolve.ts';
import { buildThresholds } from '../../src/metrics/thresholds.ts';
import { buildGenerator, type BatchGenerator } from '../../src/payload/generator.ts';
// Imported for its side effect only: this registers the six base metrics
// with k6 (each is `new Counter(...)`/`new Rate(...)`/`new Trend(...)` at
// module scope in registry.ts), the same way src/main.ts does. Without
// this, k6's threshold parser rejects a threshold declared on a tagged
// sub-metric name (e.g. `events_sent{scenario:cloudtrail}`) with "no metric
// name ... found" — the base metric has to exist in k6's registry before a
// `{tag:value}`-scoped threshold on it can resolve, and this probe would
// otherwise never create it (unlike main.ts, this probe's default function
// never calls `.add()` on anything).
import '../../src/metrics/registry.ts';

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
// duration_scale defaults to 1 (real run length) in resolveRun. Now that
// `options.scenarios` below is the REAL scenario map — not a discarded
// value — k6 will actually execute it for as long as each shape's stages
// say, and mixed-estate's auditd type uses the `soak` shape (a single
// 14400s stage): at the default scale that is 4 real wall-clock hours,
// which would turn "run the probe" into an unusable command. Every
// resolveScenario stage floors at 1s regardless of how small the scale is
// (`Math.max(1, Math.round(sec * duration_scale))`), so a near-zero default
// still exercises the real construction/executor/threshold path — it just
// compresses every stage to its 1s floor instead of skipping it.
if (overrides.duration_scale === undefined) overrides.duration_scale = 0.0001;

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

// This MUST be assigned to `options` below, not merely called and
// discarded: k6 only ever parses thresholds it finds on `options.thresholds`
// at init time. A `buildThresholds` call whose result is thrown away proves
// nothing — a wrong aggregation-method expression (Task 7's whole point) is
// rejected by k6's threshold parser, not by this pure string-assembly
// function, so the probe only fails on that class of bug if the result is
// actually handed to k6 via `options`.
const thresholds = buildThresholds({
  profile_thresholds: run.profile.thresholds,
  abort_on_fail: false,
  active_types: run.active_types,
});

// Exported, not just constructed: k6 reads `scenarios`/`thresholds` off
// `options` at init time, so this is what actually exercises the scenario
// map and the structural threshold expressions against the real k6 binary.
export const options = { scenarios, thresholds };

console.log('SCENARIOS ' + Object.keys(scenarios).sort().join(','));

export default function () {
  /* construction already verified above, in init context */
}
