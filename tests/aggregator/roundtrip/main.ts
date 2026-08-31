import { writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOG_TYPES } from '../../../src/logtypes/registry.ts';
import { buildGenerator } from '../../../src/payload/generator.ts';
import type { PayloadSpec, LogEvent } from '../../../src/payload/types.ts';
import type { LogTypeDef, LogTypeField } from '../../../src/logtypes/types.ts';

// Containerised Vector round trip (Task 5). Proves a COMMITTED
// aggregator-configs/<type>/vector/transform.json actually parses the
// bytes the real generator + real family serializer emit — field by
// field, not "the run succeeded". See README.md in this directory for
// what this does and does not prove, and why it needs Docker.
//
// The transform.json Sub-project B's renderer emits is deliberately just
// the `transforms` fragment (see src/aggregator/vector.ts's doc comment:
// "the CLI/deployment step that stitches this transform into a full
// Vector pipeline owns the actual source and sink") — no such deployment
// stitcher exists in this repo yet. This harness wraps the fragment AT
// HARNESS TIME rather than changing what the renderer/CLI emit, so the
// committed tree keeps its "transform only" contract and the CI drift
// gate has nothing new to catch.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const CONFIGS_ROOT = join(REPO_ROOT, 'aggregator-configs');
// Pinned to a concrete tag, not the floating `latest-alpine` — "verified
// live" names no artifact when the tag it ran against can silently become a
// different image tomorrow. Bump deliberately, and update the version this
// harness records (below) and aggregator-configs/README.md's own Vector
// version note together (whole-branch review, promoted minor:
// tests/aggregator/roundtrip/main.ts:27).
const VECTOR_IMAGE = 'timberio/vector:0.58.0-alpine';
const BATCH_SIZE = 20;
const DOCKER_TIMEOUT_MS = 60_000;

interface FieldFailure {
  field: string;
  index: number;
  expected: unknown;
  actual: unknown;
}

interface TypeResult {
  type: string;
  eventsIn: number;
  eventsParsed: number;
  fieldsDeclared: number;
  fieldsExtracted: number;
  failures: FieldFailure[];
  rawTransformOk: boolean;
  rawTransformNote: string;
  wrappedValidateOk: boolean;
  wrappedValidateOutput: string;
  indexedFields: string[];
}

/** `path.split('.')` walk — cloudtrail's `userIdentity.arn` lands nested. */
function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

/**
 * What the field SHOULD look like after the VRL coercions in
 * src/aggregator/vector.ts's coercionLines run. `int` -> a JS number.
 * `ip`/`string`/absent -> untouched. `timestamp` is unreachable today (no
 * LogTypeDef field uses it — see coercionEntries's doc comment in
 * src/aggregator/cribl.ts) so it falls through to a string comparison,
 * best-effort, rather than asserting a representation nothing produces.
 */
function expectedValue(f: LogTypeField, raw: string): unknown {
  if (f.parse?.type === 'int') return Number(raw);
  return raw;
}

function buildSpec(def: LogTypeDef): PayloadSpec {
  return {
    template: def.name,
    batch_size: BATCH_SIZE,
    fields: Object.fromEntries(def.fields.map((f) => [f.name, f.spec])),
  };
}

/**
 * The sink half of the wiring: `index` (unlike `type`) has no renderer-side
 * consumer — no vendor's transform stage exposes per-field indexing — so it
 * drives the sink wrapped around the transform instead. Vector's
 * `splunk_hec_logs` sink takes `indexed_fields`; this is that list, built
 * straight from `def.fields.filter(f => f.parse?.index)` per the
 * controller's ruling (see src/logtypes/types.ts's updated doc comment).
 */
function indexedFieldPaths(def: LogTypeDef): string[] {
  return def.fields.filter((f) => f.parse?.index).map((f) => f.path ?? f.name);
}

/**
 * Wraps the committed transform with a `file` source and a `splunk_hec_logs`
 * sink (rather than a bare `console` sink) specifically so the indexed-
 * fields sink shape is exercised by `vector validate`, not just asserted in
 * prose. Never actually run — `validate` never connects out — so a
 * synthetic, unreachable endpoint is fine here.
 */
function buildValidateConfig(
  def: LogTypeDef,
  transformSource: string,
  samplePathInContainer: string,
): Record<string, unknown> {
  return {
    sources: { in: { type: 'file', include: [samplePathInContainer] } },
    transforms: { [def.name]: { type: 'remap', inputs: ['in'], source: transformSource } },
    sinks: {
      splunk: {
        type: 'splunk_hec_logs',
        inputs: [def.name],
        endpoint: 'http://splunk.invalid.example:8088',
        default_token: '${VECTOR_SPLUNK_HEC_TOKEN}',
        indexed_fields: indexedFieldPaths(def),
        encoding: { codec: 'json' },
      },
    },
  };
}

/** All of this harness's scratch files live directly under /tmp, mounted
 * read-only into the container as /data — this is the one place that
 * mapping is expressed, so every container-side path is derived from the
 * host path that was actually written, never restated independently. */
function toContainerPath(hostPath: string): string {
  if (!hostPath.startsWith('/tmp/')) {
    throw new Error(`toContainerPath: expected a /tmp path, got "${hostPath}"`);
  }
  return `/data/${hostPath.slice('/tmp/'.length)}`;
}

/**
 * Records the concrete Vector version the pinned image actually runs — the
 * same "which version did this check run against" record
 * aggregator-configs/README.md's manual Cribl log keeps (its "Cribl
 * version" column). Run once per invocation, not once per type: the image
 * is the same for every type, so a `docker run --version` per type would
 * only add noise.
 */
function getVectorVersion(): string {
  const res = spawnSync('docker', ['run', '--rm', VECTOR_IMAGE, '--version'], {
    encoding: 'utf8',
    timeout: DOCKER_TIMEOUT_MS,
  });
  if (res.error || res.status !== 0) {
    throw new Error(`could not determine ${VECTOR_IMAGE}'s version: ${res.stderr ?? res.error}`);
  }
  return res.stdout.trim();
}

function runDocker(args: string[]): { code: number | null; stdout: string; stderr: string; timedOut: boolean } {
  const res = spawnSync('docker', args, { encoding: 'utf8', timeout: DOCKER_TIMEOUT_MS });
  if (res.error) {
    throw new Error(`docker ${args.join(' ')} failed to launch: ${res.error.message}`);
  }
  return {
    code: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    timedOut: res.signal === 'SIGTERM' && res.status === null,
  };
}

function runOneType(def: LogTypeDef): TypeResult {
  const spec = buildSpec(def);
  const gen = buildGenerator(spec, { run_id: 'roundtrip', gen_index: 0 });
  const events: LogEvent[] = gen.batchAt(0, Date.now());

  const samplePath = `/tmp/rt-${def.name}.log`;
  writeFileSync(samplePath, events.map((e) => e.body).join('\n') + '\n');

  const ndjsonPath = `/tmp/rt-${def.name}-input.ndjson`;
  writeFileSync(
    ndjsonPath,
    events.map((e) => JSON.stringify({ message: e.body })).join('\n') + '\n',
  );

  const transformPath = join(CONFIGS_ROOT, def.name, 'vector', 'transform.json');
  const transformConfig = JSON.parse(readFileSync(transformPath, 'utf8')) as {
    transforms: Record<string, { source: string }>;
  };
  const transformSource = transformConfig.transforms[def.name].source;

  const vrlPath = `/tmp/rt-${def.name}.vrl`;
  writeFileSync(vrlPath, transformSource);

  // Step 2, part A: the COMMITTED transform.json alone, exactly the
  // command in task-5-brief.md Step 2. Expected outcome is a topology
  // error (no sources/sinks defined) rather than a JSON parse error —
  // that distinction is what actually validates Task 2's JSON-not-YAML
  // deviation: Vector reading past "Loaded" into component-level
  // diagnostics proves the file was accepted as a config format, not
  // rejected as malformed JSON.
  const rawCheck = runDocker([
    'run', '--rm', '-v', `${CONFIGS_ROOT}:/cfg:ro`, VECTOR_IMAGE,
    'validate', '--no-environment', `/cfg/${def.name}/vector/transform.json`,
  ]);
  const rawCheckOutput = rawCheck.stdout + rawCheck.stderr;
  // rawTransformOk drives the pass/fail verdict; rawTransformNote is only
  // ever the human-readable half — the two used to diverge (this note
  // printed "unexpected result" while `pass` stayed true, since main()
  // never looked at it — whole-branch review, promoted minor:
  // tests/aggregator/roundtrip/main.ts:181-183 / :275-278).
  const rawTransformOk = rawCheck.code === 78 && /No sources defined|No sinks defined/.test(rawCheckOutput);
  const rawTransformNote = rawTransformOk
    ? 'accepted as JSON; rejected only for missing source/sink (expected — it is a fragment)'
    : `unexpected result (exit ${rawCheck.code}): ${rawCheckOutput.trim().slice(0, 300)}`;

  // Step 2, part B: wrapped with a file source + the indexed splunk_hec_logs
  // sink. This is the "does the JSON config validate at all" proof the
  // brief asks for, using the indexed-fields sink so that shape is
  // exercised too.
  const validateConfig = buildValidateConfig(def, transformSource, toContainerPath(samplePath));
  const validateConfigPath = `/tmp/rt-${def.name}-validate.json`;
  writeFileSync(validateConfigPath, JSON.stringify(validateConfig, null, 2) + '\n');
  const validateCheck = runDocker([
    'run', '--rm', '-v', '/tmp:/data:ro', VECTOR_IMAGE,
    'validate', '--no-environment', toContainerPath(validateConfigPath),
  ]);
  const wrappedValidateOk = validateCheck.code === 0;

  // Step 3: actual field-by-field extraction. `vector vrl` applies the
  // SAME VRL source string the committed transform.json carries (extracted
  // above, not paraphrased) to each NDJSON line — the identical logic a
  // `remap` transform would run, without needing a live sink or a
  // long-running `vector run` process to shut down cleanly (file-source
  // tailing has no reliable EOF-triggered exit; `vrl -i` is one-shot).
  const vrlCheck = runDocker([
    'run', '--rm', '-v', '/tmp:/data:ro', VECTOR_IMAGE,
    'vrl', '-i', toContainerPath(ndjsonPath), '-p', toContainerPath(vrlPath), '-o',
  ]);
  const parsedLines = vrlCheck.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const parsedEvents = parsedLines.map((l) => JSON.parse(l) as Record<string, unknown>);

  const failures: FieldFailure[] = [];
  let fieldsExtracted = 0;
  for (const f of def.fields) {
    let ok = parsedEvents.length === events.length;
    for (let i = 0; i < events.length && i < parsedEvents.length; i++) {
      const raw = events[i].fields[f.name] ?? '';
      const expected = expectedValue(f, raw);
      const path = f.path ?? f.name;
      const actual = getPath(parsedEvents[i], path);
      if (actual !== expected) {
        ok = false;
        if (failures.filter((x) => x.field === f.name).length === 0) {
          failures.push({ field: f.name, index: i, expected, actual });
        }
      }
    }
    if (ok) fieldsExtracted++;
  }

  return {
    type: def.name,
    eventsIn: events.length,
    eventsParsed: parsedEvents.length,
    fieldsDeclared: def.fields.length,
    fieldsExtracted,
    failures,
    rawTransformOk,
    rawTransformNote,
    wrappedValidateOk,
    wrappedValidateOutput: (validateCheck.stdout + validateCheck.stderr).trim(),
    indexedFields: indexedFieldPaths(def),
  };
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function main(): void {
  const dockerCheck = spawnSync('docker', ['info'], { encoding: 'utf8', timeout: DOCKER_TIMEOUT_MS });
  if (dockerCheck.error || dockerCheck.status !== 0) {
    console.error('docker is required (and must be running) for the containerised round trip. See README.md.');
    process.exit(1);
  }

  const vectorVersion = getVectorVersion();
  console.log(`Vector image: ${VECTOR_IMAGE} (${vectorVersion})`);

  const results: TypeResult[] = [];
  for (const def of Object.values(LOG_TYPES)) {
    console.log(`--- ${def.name} ---`);
    const r = runOneType(def);
    results.push(r);
    console.log(`  raw transform.json check: ${r.rawTransformNote}`);
    console.log(`  wrapped validate (file source + indexed splunk_hec_logs sink): ${r.wrappedValidateOk ? 'Validated' : 'FAILED — ' + r.wrappedValidateOutput}`);
    console.log(`  indexed_fields: [${r.indexedFields.join(', ')}]`);
    if (r.failures.length > 0) {
      for (const f of r.failures) {
        console.log(`  FIELD MISMATCH: ${f.field} at event[${f.index}] expected=${JSON.stringify(f.expected)} actual=${JSON.stringify(f.actual)}`);
      }
    }
  }

  console.log('\n=== Round-trip summary ===');
  const header = `${pad('Type', 14)} ${pad('Events in', 10)} ${pad('Parsed', 8)} ${pad('Fields decl', 12)} ${pad('Extracted', 10)} Result`;
  console.log(header);
  let anyFail = false;
  for (const r of results) {
    const pass =
      r.eventsIn === r.eventsParsed &&
      r.fieldsExtracted === r.fieldsDeclared &&
      r.wrappedValidateOk &&
      r.rawTransformOk;
    if (!pass) anyFail = true;
    console.log(
      `${pad(r.type, 14)} ${pad(String(r.eventsIn), 10)} ${pad(String(r.eventsParsed), 8)} ` +
      `${pad(String(r.fieldsDeclared), 12)} ${pad(String(r.fieldsExtracted), 10)} ${pass ? 'PASS' : 'FAIL'}`,
    );
  }

  if (anyFail) {
    console.error('\nAt least one type failed the round trip — see FIELD MISMATCH lines above.');
    process.exit(1);
  }
  console.log('\nAll types: every declared field extracted with the generator-produced value.');
}

main();
