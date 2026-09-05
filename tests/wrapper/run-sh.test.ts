import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Exercises bin/run.sh's exit-code propagation with a STUB k6 on PATH.
 *
 * This is the most consequential behaviour in the whole project and, until
 * this file existed, the only thing verifying it was a human remembering to
 * run a 60-second sweep by hand. k6 exits 99 on a threshold breach; a wrapper
 * that swallows it makes every failing run look green, with no visible symptom
 * until somebody trusts a build that should have been red.
 *
 * Stubbing k6 rather than running the real thing keeps this hermetic and fast:
 * no k6 install, no network, no target — so it can gate every change in CI.
 */

const REPO = resolve(__dirname, '../..');
const RUN_SH = join(REPO, 'bin', 'run.sh');
const TSX = join(REPO, 'node_modules', '.bin', 'tsx');
// The wrapper's in-image defaults (`node /app/dist/*.js`) do not exist in a
// checkout, so point both CLIs at the TypeScript sources the same way the
// header comment in bin/run.sh documents for local development.
const INDEX_CLI = `${TSX} ${join(REPO, 'src', 'storage', 'index-cli.ts')}`;
const TIMELINE_CLI = `${TSX} ${join(REPO, 'src', 'timeline', 'cli.ts')}`;
const PROFILE_DIR = join(REPO, 'profiles');

/**
 * Sentinel asking runWrapper to leave a variable GENUINELY unset rather than
 * passing a value. `EMIT_TIMELINE` unset is a distinct state from
 * `EMIT_TIMELINE=0` — that distinction is the whole of the environment-wins
 * precedence rule — and an object literal cannot express "absent" otherwise.
 */
const UNSET = '\u0000unset';

/** A summary rich enough for index-cli to derive real §9.3 keys from. */
const REAL_SUMMARY = JSON.stringify({
  schema_version: 1,
  run: {
    run_id: 'r1',
    started_at: '2026-08-29T22:00:00.000Z',
    ended_at: '2026-08-29T22:01:00.000Z',
    duration_sec: 60,
    k6_version: 'v2.2.0',
  },
  generator: { gen_index: 0, gen_count: 1 },
  resolved_config: { name: 'local-null', target: { transport: 'null' }, scenario: 'smoke' },
  rate: { requested_eps: 1000, achieved_eps: 1000, delta_pct: 0 },
  metrics: {},
  thresholds: {},
  validity: { dropped_iterations: 0, generator_cpu: null, valid: true, reasons: [] },
  payload_sample: [],
  warnings: [],
});

let root: string;

/**
 * Writes a fake `k6` that emits `lines` of output, optionally a summary
 * and/or a raw.json (standing in for `--out json`), then exits with `code`.
 *
 * It also always records its own argv to `k6-argv.txt` in the working
 * directory (which is $WORKDIR — bin/run.sh cds there before invoking k6).
 * That file is how the EMIT_TIMELINE tests below see whether the wrapper
 * actually passed `--out json`, which is the only observable difference the
 * flag makes.
 */
function stubK6(opts: {
  code: number;
  writeSummary: boolean;
  lines?: number;
  writeRaw?: boolean;
  summaryJson?: string;
  rawJson?: string;
}): string {
  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  const summaryJson = opts.summaryJson ?? '{"schema_version":1,"run":{"run_id":"stub"}}';
  const rawJson = opts.rawJson ?? '{"type":"Metric","data":{"name":"stub"}}';
  const script = `#!/bin/sh
printf '%s\\n' "$@" > k6-argv.txt
i=0
while [ "$i" -lt ${opts.lines ?? 3} ]; do
  echo "stub-k6 output line $i"
  i=$((i + 1))
done
${opts.writeSummary ? `printf '%s' '${summaryJson}' > summary.json` : '# no summary written'}
${opts.writeRaw ? `printf '%s\\n' '${rawJson}' > raw.json` : '# no raw.json written'}
exit ${opts.code}
`;
  const p = join(binDir, 'k6');
  writeFileSync(p, script);
  chmodSync(p, 0o755);
  return binDir;
}

/**
 * Writes a fake `aws` into the same stub bin dir, appending every invocation
 * to $AWS_STUB_LOG and exiting with `code`.
 *
 * This is what makes the `s3://` branch — the headline ECS deployment path,
 * and until now the only branch of bin/run.sh guarded by nothing at all —
 * testable hermetically: no bucket, no credentials, no network, exactly the
 * way stubbing k6 makes the run path testable.
 */
function stubAws(binDir: string, code = 0): void {
  const script = `#!/bin/sh
printf '%s\\n' "$*" >> "$AWS_STUB_LOG"
exit ${code}
`;
  const p = join(binDir, 'aws');
  writeFileSync(p, script);
  chmodSync(p, 0o755);
}

/** The `aws s3 cp` DESTINATIONS the stub recorded, in order. */
function awsDestinations(logPath: string): string[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('s3 cp '))
    .map((l) => l.split(/\s+/)[3]);
}

/** k6 argv as the stub recorded it, or '' if k6 never ran. */
function k6Argv(workdir: string): string {
  const p = join(workdir, 'k6-argv.txt');
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}

function runWrapper(binDir: string, workdir: string, env: Record<string, string> = {}) {
  const merged: Record<string, string> = {
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    WORKDIR: workdir,
    K6_SCRIPT: '/nonexistent/main.ts', // never read: k6 is stubbed
    EMIT_TIMELINE: '0',
    ...env,
  };
  // A deliberate "leave this unset" beats an empty string: bin/run.sh
  // distinguishes an operator's explicit choice from no choice at all.
  for (const [k, v] of Object.entries(merged)) {
    if (v === UNSET) delete merged[k];
  }
  return spawnSync('sh', [RUN_SH], { env: merged, encoding: 'utf8' });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'runsh-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('bin/run.sh exit-code propagation', () => {
  it('exits 0 when k6 succeeds', () => {
    const binDir = stubK6({ code: 0, writeSummary: true });
    expect(runWrapper(binDir, join(root, 'w')).status).toBe(0);
  });

  it('exits 99 when k6 breaches a threshold — the CI gate', () => {
    // The single assertion this file exists for. k6 returns 99 on a threshold
    // breach; if the wrapper ever returns 0 here, every failing load test
    // silently reports success.
    const binDir = stubK6({ code: 99, writeSummary: true });
    expect(runWrapper(binDir, join(root, 'w')).status).toBe(99);
  });

  it('propagates an arbitrary non-zero code unchanged', () => {
    const binDir = stubK6({ code: 42, writeSummary: true });
    expect(runWrapper(binDir, join(root, 'w')).status).toBe(42);
  });

  it('promotes a bogus success (exit 0, no summary) to failure', () => {
    const binDir = stubK6({ code: 0, writeSummary: false });
    expect(runWrapper(binDir, join(root, 'w')).status).toBe(1);
  });

  it('does NOT downgrade a real failure that also produced no summary', () => {
    // The promotion above must only ever turn 0 into 1. If it clobbered a
    // genuine non-zero code, a threshold breach that died before writing a
    // summary would be reported as a plain generic failure and lose the 99.
    const binDir = stubK6({ code: 99, writeSummary: false });
    expect(runWrapper(binDir, join(root, 'w')).status).toBe(99);
  });

  it('captures k6 output to run.log while still propagating the code', () => {
    const workdir = join(root, 'w');
    const binDir = stubK6({ code: 99, writeSummary: true });
    const r = runWrapper(binDir, workdir);
    expect(r.status).toBe(99);
    const log = readFileSync(join(workdir, 'run.log'), 'utf8');
    expect(log).toContain('stub-k6 output line 0');
  });

  it('survives output far larger than a pipe buffer without truncating or hanging', () => {
    // The named-pipe approach deadlocks or truncates if the reader is not
    // draining properly; 20k lines is many times a 64KB pipe buffer.
    const workdir = join(root, 'w');
    const binDir = stubK6({ code: 99, writeSummary: true, lines: 20000 });
    const r = runWrapper(binDir, workdir);
    expect(r.status).toBe(99);
    const log = readFileSync(join(workdir, 'run.log'), 'utf8');
    expect(log).toContain('stub-k6 output line 0');
    expect(log).toContain('stub-k6 output line 19999');
  });

  it('still propagates the code when a local RESULTS_URI copy runs', () => {
    // Uploads/copies must never mask the run's verdict.
    const workdir = join(root, 'w');
    const out = join(root, 'out');
    const binDir = stubK6({ code: 99, writeSummary: true });
    const r = runWrapper(binDir, workdir, { RESULTS_URI: out });
    expect(r.status).toBe(99);
    expect(existsSync(join(out, 'summary.json'))).toBe(true);
  });

  it('KEEP_RAW=1 with a local RESULTS_URI gzips raw.json into the results directory', () => {
    // Regression test for a bug found in Plan 3 Task 7 end-to-end verification:
    // the local-filesystem branch of the RESULTS_URI case statement never
    // gzipped or copied raw.json at all, despite a comment claiming it took
    // "the identical code path" as the s3:// branch. KEEP_RAW=1 was a silent
    // no-op for every local RESULTS_URI, and nothing here caught it.
    const workdir = join(root, 'w');
    const out = join(root, 'out');
    const binDir = stubK6({ code: 0, writeSummary: true, writeRaw: true });
    const r = runWrapper(binDir, workdir, { RESULTS_URI: out, KEEP_RAW: '1' });
    expect(r.status).toBe(0);
    expect(existsSync(join(out, 'raw.json.gz'))).toBe(true);
  });

  it('KEEP_RAW unset (default) does not produce raw.json.gz, even when raw.json exists', () => {
    // Without this case, the test above would still pass against an
    // implementation that unconditionally gzips and ships raw.json —
    // KEEP_RAW must actually gate the behaviour, not just be present.
    const workdir = join(root, 'w');
    const out = join(root, 'out');
    const binDir = stubK6({ code: 0, writeSummary: true, writeRaw: true });
    const r = runWrapper(binDir, workdir, { RESULTS_URI: out });
    expect(r.status).toBe(0);
    expect(existsSync(join(out, 'raw.json.gz'))).toBe(false);
  });

  it('KEEP_RAW=1 with no raw.json present is a silent no-op, not an error', () => {
    // Covers the `[ -f "$RAW" ]` guard — e.g. EMIT_TIMELINE=0, where k6 is
    // never invoked with --out json and raw.json never exists.
    const workdir = join(root, 'w');
    const out = join(root, 'out');
    const binDir = stubK6({ code: 0, writeSummary: true, writeRaw: false });
    const r = runWrapper(binDir, workdir, { RESULTS_URI: out, KEEP_RAW: '1' });
    expect(r.status).toBe(0);
    expect(existsSync(join(out, 'raw.json.gz'))).toBe(false);
  });
});

describe('bin/run.sh START_AT scheduled start — single-generator mode', () => {
  // START_AT accepts either an ISO-8601 UTC timestamp or a Unix epoch in
  // seconds; both forms are exercised below. bin/run.sh must parse the ISO
  // form without GNU date (this suite runs on macOS; the container is
  // Linux) — see the to_epoch fallback to `date -u -j -f`.

  it('START_AT as a past Unix epoch logs lateness and still runs k6', () => {
    const workdir = join(root, 'w');
    const binDir = stubK6({ code: 0, writeSummary: true });
    const pastEpoch = Math.floor(Date.now() / 1000) - 42;
    const r = runWrapper(binDir, workdir, { START_AT: String(pastEpoch) });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/run\.sh: START_AT was \d+ s ago; starting immediately \(late\)/);
    expect(k6Argv(workdir)).not.toBe('');
  });

  it('START_AT as a past ISO-8601 timestamp logs lateness and still runs k6', () => {
    const workdir = join(root, 'w');
    const binDir = stubK6({ code: 0, writeSummary: true });
    const pastIso = new Date(Date.now() - 5000).toISOString().replace(/\.\d+Z$/, 'Z');
    const r = runWrapper(binDir, workdir, { START_AT: pastIso });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/run\.sh: START_AT was \d+ s ago; starting immediately \(late\)/);
    expect(k6Argv(workdir)).not.toBe('');
  });

  it('START_AT an ISO-8601 timestamp ~2s ahead delays k6 start by at least ~2s', () => {
    const workdir = join(root, 'w');
    const binDir = stubK6({ code: 0, writeSummary: true });
    const startAt = new Date(Date.now() + 2000).toISOString().replace(/\.\d+Z$/, 'Z');
    const t0 = Date.now();
    const r = runWrapper(binDir, workdir, { START_AT: startAt });
    const elapsed = Date.now() - t0;
    expect(r.status, r.stderr).toBe(0);
    expect(elapsed).toBeGreaterThanOrEqual(1800);
    expect(k6Argv(workdir)).not.toBe('');
  });

  it('START_AT a Unix epoch ~2s ahead delays k6 start by at least ~2s', () => {
    const workdir = join(root, 'w');
    const binDir = stubK6({ code: 0, writeSummary: true });
    // +3, not +2: START_AT is a whole-second epoch, and Math.floor here can
    // already be up to 1s behind the actual instant, which would otherwise
    // make the wrapper's own (correct) whole-second sleep look short by 1s.
    const startAt = String(Math.floor(Date.now() / 1000) + 3);
    const t0 = Date.now();
    const r = runWrapper(binDir, workdir, { START_AT: startAt });
    const elapsed = Date.now() - t0;
    expect(r.status, r.stderr).toBe(0);
    expect(elapsed).toBeGreaterThanOrEqual(1800);
  });

  it('no START_AT means no wait and no lateness log', () => {
    const workdir = join(root, 'w');
    const binDir = stubK6({ code: 0, writeSummary: true });
    const t0 = Date.now();
    const r = runWrapper(binDir, workdir, { START_AT: UNSET });
    const elapsed = Date.now() - t0;
    expect(r.status, r.stderr).toBe(0);
    expect(elapsed).toBeLessThan(1500);
    expect(r.stderr).not.toMatch(/START_AT/);
  });
});

describe('bin/run.sh EMIT_TIMELINE resolution (environment, else profile, else 1)', () => {
  // Spec §9.1 makes `emit_timeline` a PROFILE flag. It was validated by
  // src/config/schema.ts and set by both shipped profiles, and nothing read
  // it: the wrapper looked only at the EMIT_TIMELINE environment variable and
  // defaulted to 1, so `PROFILE=local-null` ran `--out json` despite its own
  // profile saying not to. A validated-but-ignored knob is spec §2.2's defect
  // class, so these assert against the REAL shipped profiles, not fixtures.

  const profileEnv = (profile: string) => ({
    EMIT_TIMELINE: UNSET,
    PROFILE: profile,
    PROFILE_DIR,
    INDEX_CLI,
  });

  it('honours a profile that sets emit_timeline false — no --out json', () => {
    // profiles/local-null.json declares "emit_timeline": false. Before the
    // fix this run passed `--out json` regardless.
    const workdir = join(root, 'w');
    const binDir = stubK6({ code: 0, writeSummary: true });
    const r = runWrapper(binDir, workdir, profileEnv('local-null'));
    expect(r.status).toBe(0);
    expect(k6Argv(workdir)).not.toContain('--out');
  });

  it('honours a profile that sets emit_timeline true — passes --out json', () => {
    // profiles/otlp-grpc.json declares "emit_timeline": true. The
    // counterpart case: without it, "never pass --out json" would also pass.
    const workdir = join(root, 'w');
    const binDir = stubK6({ code: 0, writeSummary: true });
    const r = runWrapper(binDir, workdir, profileEnv('otlp-grpc'));
    expect(r.status).toBe(0);
    expect(k6Argv(workdir)).toContain('--out');
    expect(k6Argv(workdir)).toContain('json=');
  });

  it('lets an explicit EMIT_TIMELINE=1 override a profile that says false', () => {
    // Environment wins over profile, matching TARGET/SCENARIO/RATE and every
    // other setting in this project (src/config/env.ts).
    const workdir = join(root, 'w');
    const binDir = stubK6({ code: 0, writeSummary: true });
    const r = runWrapper(binDir, workdir, {
      ...profileEnv('local-null'),
      EMIT_TIMELINE: '1',
    });
    expect(r.status).toBe(0);
    expect(k6Argv(workdir)).toContain('--out');
  });

  it('lets an explicit EMIT_TIMELINE=0 override a profile that says true', () => {
    const workdir = join(root, 'w');
    const binDir = stubK6({ code: 0, writeSummary: true });
    const r = runWrapper(binDir, workdir, {
      ...profileEnv('otlp-grpc'),
      EMIT_TIMELINE: '0',
    });
    expect(r.status).toBe(0);
    expect(k6Argv(workdir)).not.toContain('--out');
  });

  it('defaults to on when a profile declares no emit_timeline at all', () => {
    // Spec §9.1: "on by default, off for extreme-rate runs".
    const workdir = join(root, 'w');
    const profileDir = join(root, 'profiles');
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(join(profileDir, 'no-flag.json'), '{"name":"no-flag"}');
    const binDir = stubK6({ code: 0, writeSummary: true });
    const r = runWrapper(binDir, workdir, {
      EMIT_TIMELINE: UNSET,
      PROFILE: 'no-flag',
      PROFILE_DIR: profileDir,
      INDEX_CLI,
    });
    expect(r.status).toBe(0);
    expect(k6Argv(workdir)).toContain('--out');
  });

  it('defaults to on, and does not abort, when the profile file is missing', () => {
    // PROFILE naming a file that is not in the image is the k6 script's error
    // to report, not the wrapper's to die on.
    const workdir = join(root, 'w');
    const binDir = stubK6({ code: 0, writeSummary: true });
    const r = runWrapper(binDir, workdir, {
      EMIT_TIMELINE: UNSET,
      PROFILE: 'no-such-profile',
      PROFILE_DIR,
      INDEX_CLI,
    });
    expect(r.status).toBe(0);
    expect(k6Argv(workdir)).toContain('--out');
  });
});

describe('bin/run.sh AWS region check', () => {
  // ECS injects neither AWS_REGION nor AWS_DEFAULT_REGION (unlike Lambda),
  // and a Fargate awsvpc task has no reachable IMDS for the CLI to fall back
  // on — so `aws s3 cp` fails region resolution. Because shipping is
  // deliberately non-fatal, the failure mode is a GREEN run that persists
  // nothing, on the branch's headline path.

  const s3Env = {
    RESULTS_URI: 's3://bucket/prefix',
    INDEX_CLI,
    AWS_STUB_LOG: '', // filled per test
  };

  it('warns, naming both variables, when neither region variable is set', () => {
    const workdir = join(root, 'w');
    const binDir = stubK6({ code: 0, writeSummary: true, summaryJson: REAL_SUMMARY });
    stubAws(binDir);
    const r = runWrapper(binDir, workdir, {
      ...s3Env,
      AWS_STUB_LOG: join(root, 'aws.log'),
    });
    expect(r.stderr).toContain('AWS_REGION');
    expect(r.stderr).toContain('AWS_DEFAULT_REGION');
    // The warning must not touch the verdict.
    expect(r.status).toBe(0);
  });

  it('does not change the exit code — a 99 stays a 99', () => {
    const workdir = join(root, 'w');
    const binDir = stubK6({ code: 99, writeSummary: true, summaryJson: REAL_SUMMARY });
    stubAws(binDir);
    const r = runWrapper(binDir, workdir, {
      ...s3Env,
      AWS_STUB_LOG: join(root, 'aws.log'),
    });
    expect(r.status).toBe(99);
  });

  it('stays quiet when AWS_REGION is set', () => {
    const workdir = join(root, 'w');
    const binDir = stubK6({ code: 0, writeSummary: true, summaryJson: REAL_SUMMARY });
    stubAws(binDir);
    const r = runWrapper(binDir, workdir, {
      ...s3Env,
      AWS_STUB_LOG: join(root, 'aws.log'),
      AWS_REGION: 'test-region-1',
    });
    expect(r.stderr).not.toContain('AWS_DEFAULT_REGION');
  });

  it('stays quiet when only AWS_DEFAULT_REGION is set', () => {
    const workdir = join(root, 'w');
    const binDir = stubK6({ code: 0, writeSummary: true, summaryJson: REAL_SUMMARY });
    stubAws(binDir);
    const r = runWrapper(binDir, workdir, {
      ...s3Env,
      AWS_STUB_LOG: join(root, 'aws.log'),
      AWS_DEFAULT_REGION: 'test-region-1',
    });
    expect(r.stderr).not.toContain('neither AWS_REGION nor AWS_DEFAULT_REGION');
  });

  it('stays quiet for a local RESULTS_URI, which needs no region', () => {
    const workdir = join(root, 'w');
    const binDir = stubK6({ code: 0, writeSummary: true });
    const r = runWrapper(binDir, workdir, { RESULTS_URI: join(root, 'out') });
    expect(r.stderr).not.toContain('AWS_REGION');
  });
});

describe('bin/run.sh artifact-shipping accounting', () => {
  // Three total-artifact-loss modes exited with k6's own code and logged only
  // to stderr, so nothing reading exit status could see them: an unparseable
  // started_at skipped all five uploads, a missing summary.json skipped
  // everything including run.log, and a total upload failure was swallowed by
  // `|| true`. The exit code deliberately still does not move — an upload must
  // never mask the run's verdict — so the signal is an aggregate stderr line.

  it('reports how many artifacts it shipped on a successful local copy', () => {
    const workdir = join(root, 'w');
    const out = join(root, 'out');
    const binDir = stubK6({ code: 0, writeSummary: true });
    const r = runWrapper(binDir, workdir, { RESULTS_URI: out });
    // summary.json, run.log and exit_code; no timeline, since EMIT_TIMELINE is 0 here.
    expect(r.stderr).toContain('3 of 3 artifacts shipped');
    expect(readFileSync(join(out, 'exit_code'), 'utf8').trim()).toBe('0');
    expect(r.status).toBe(0);
  });

  it('reports the count of FAILED uploads when every upload fails', () => {
    const workdir = join(root, 'w');
    const binDir = stubK6({ code: 0, writeSummary: true, summaryJson: REAL_SUMMARY });
    stubAws(binDir, 1); // every `aws s3 cp` fails
    const r = runWrapper(binDir, workdir, {
      RESULTS_URI: 's3://bucket/prefix',
      INDEX_CLI,
      AWS_REGION: 'test-region-1',
      AWS_STUB_LOG: join(root, 'aws.log'),
    });
    // index.json, summary.json, run.log — no timeline, no raw at EMIT_TIMELINE=0.
    expect(r.stderr).toContain('4 of 4 artifacts failed to upload');
    // ...and the verdict is still k6's own.
    expect(r.status).toBe(0);
  });

  it('says 0 artifacts shipped, and why, when no summary.json was produced', () => {
    // This path previously skipped everything — including run.log, which does
    // not depend on the summary for its content — in total silence.
    const workdir = join(root, 'w');
    const binDir = stubK6({ code: 0, writeSummary: false });
    const r = runWrapper(binDir, workdir, { RESULTS_URI: join(root, 'out') });
    expect(r.stderr).toContain('0 artifacts shipped');
    expect(r.stderr).toContain('no summary.json');
  });

  it('says 0 artifacts shipped, and why, when the key derivation throws', () => {
    // `started_at: "unknown"` makes partitionDate (src/storage/keys.ts) throw,
    // which skips all five uploads. It is a real run-time condition — main.ts
    // stamps "unknown" when it cannot read the clock — and it silently
    // persisted nothing at all.
    const workdir = join(root, 'w');
    const binDir = stubK6({
      code: 0,
      writeSummary: true,
      summaryJson: JSON.stringify({
        schema_version: 1,
        run: { run_id: 'r1', started_at: 'unknown' },
        generator: { gen_index: 0 },
      }),
    });
    stubAws(binDir);
    const r = runWrapper(binDir, workdir, {
      RESULTS_URI: 's3://bucket/prefix',
      INDEX_CLI,
      AWS_REGION: 'test-region-1',
      AWS_STUB_LOG: join(root, 'aws.log'),
    });
    expect(r.stderr).toContain('0 artifacts shipped');
    expect(r.stderr).toContain('could not derive S3 keys');
    expect(awsDestinations(join(root, 'aws.log'))).toEqual([]);
    expect(r.status).toBe(0);
  });

  it('says 0 artifacts shipped, and why, when RESULTS_URI is unset', () => {
    const workdir = join(root, 'w');
    const binDir = stubK6({ code: 0, writeSummary: true });
    const r = runWrapper(binDir, workdir);
    expect(r.stderr).toContain('0 artifacts shipped');
    expect(r.stderr).toContain('RESULTS_URI is not set');
  });
});

describe('bin/run.sh s3:// upload path (stub aws on PATH)', () => {
  // The headline ECS deployment path. Nothing guarded it: every existing test
  // took the local-filesystem branch, which — contrary to a comment that has
  // now been corrected — is NOT the same code path. It derives no keys and
  // writes no index.json, so the entire §9.3 key layout was unexercised by
  // anything except the unit tests of the key builder itself.

  it('uploads exactly the six per-run keys, to the right destinations', () => {
    const workdir = join(root, 'w');
    const awsLog = join(root, 'aws.log');
    const binDir = stubK6({
      code: 0,
      writeSummary: true,
      summaryJson: REAL_SUMMARY,
      writeRaw: true,
      rawJson: '{"type":"Point","metric":"events_sent","data":{"time":"2026-08-29T22:00:00.000Z","value":100}}',
    });
    stubAws(binDir);
    const r = runWrapper(binDir, workdir, {
      RESULTS_URI: 's3://bucket/prefix',
      EMIT_TIMELINE: '1',
      KEEP_RAW: '1',
      INDEX_CLI,
      TIMELINE_CLI,
      AWS_REGION: 'test-region-1',
      AWS_STUB_LOG: awsLog,
    });
    expect(r.status).toBe(0);

    // Sorted on both sides: the five keys must all be present and correct;
    // the order bin/run.sh happens to upload them in is not a contract.
    expect([...awsDestinations(awsLog)].sort()).toEqual([
      // Partitioned on the UTC date of run.started_at; one flat line each.
      's3://bucket/prefix/index/dt=2026-08-29/r1-gen0.json',
      's3://bucket/prefix/timeline/dt=2026-08-29/r1-gen0.jsonl',
      // Per-run detail objects, fetched by key rather than scanned.
      's3://bucket/prefix/runs/r1/gen-0/summary.json',
      's3://bucket/prefix/runs/r1/gen-0/run.log',
      's3://bucket/prefix/runs/r1/gen-0/raw.json.gz',
      // k6's exit status, so a fleet merged later from S3 knows how this generator ended.
      's3://bucket/prefix/runs/r1/gen-0/exit_code',
    ].sort());
    expect(r.stderr).toContain('6 of 6 artifacts shipped');
  });

  it('omits raw.json.gz when KEEP_RAW is not set, and ships the other five', () => {
    const workdir = join(root, 'w');
    const awsLog = join(root, 'aws.log');
    const binDir = stubK6({
      code: 0,
      writeSummary: true,
      summaryJson: REAL_SUMMARY,
      writeRaw: true,
      rawJson: '{"type":"Point","metric":"events_sent","data":{"time":"2026-08-29T22:00:00.000Z","value":100}}',
    });
    stubAws(binDir);
    const r = runWrapper(binDir, workdir, {
      RESULTS_URI: 's3://bucket/prefix',
      EMIT_TIMELINE: '1',
      INDEX_CLI,
      TIMELINE_CLI,
      AWS_REGION: 'test-region-1',
      AWS_STUB_LOG: awsLog,
    });
    expect(r.status).toBe(0);
    const dests = awsDestinations(awsLog);
    expect(dests).not.toContain('s3://bucket/prefix/runs/r1/gen-0/raw.json.gz');
    expect(dests.length).toBe(5);
  });

  it('honours an empty prefix — s3://bucket with no path', () => {
    const workdir = join(root, 'w');
    const awsLog = join(root, 'aws.log');
    const binDir = stubK6({ code: 0, writeSummary: true, summaryJson: REAL_SUMMARY });
    stubAws(binDir);
    runWrapper(binDir, workdir, {
      RESULTS_URI: 's3://bucket',
      INDEX_CLI,
      AWS_REGION: 'test-region-1',
      AWS_STUB_LOG: awsLog,
    });
    expect(awsDestinations(awsLog)).toContain('s3://bucket/runs/r1/gen-0/summary.json');
  });
});

// ---------------------------------------------------------------------------
// Single-task fleet mode: GEN_COUNT=N with GEN_INDEX unset runs N k6
// processes inside one container and merges their results (see the fleet
// section of bin/run.sh and src/fleet/).
// ---------------------------------------------------------------------------

const FLEET_CLI = `${TSX} ${join(REPO, 'src', 'fleet', 'cli.ts')}`;

/** A schema-2 summary template; `__GEN__` is substituted by the stub from $GEN_INDEX. */
function fleetSummaryTemplate(genCount: number): string {
  return JSON.stringify({
    schema_version: 2,
    run: { run_id: 'r1', started_at: '2026-08-29T22:00:00.000Z', ended_at: '2026-08-29T22:01:00.000Z', duration_sec: 60, k6_version: 'v2.2.0', active_types: ['json-app'] },
    resolved_config: { name: 'local-null', target: { transport: 'null' }, types: { 'json-app': { scenario: 'smoke' } } },
    generator: { gen_index: '__GEN__', gen_count: genCount },
    rate: { requested_eps: 1000, achieved_eps: 1000, delta_pct: 0 },
    metrics: { events_attempted: { count: 100 }, events_sent: { count: 100 }, send_failures: { rate: 0, passes: 1, fails: 0 } },
    types: {},
    thresholds: { slo: [], structural_count: 0 },
    verdict_from: [],
    validity: { dropped_iterations: 0, generator_cpu: null, valid: true, reasons: [] },
    payload_sample: [],
    warnings: [],
  }).replace('"__GEN__"', '__GEN__');
}

/**
 * A fake k6 whose behaviour depends on $GEN_INDEX, so one stub can play every
 * generator of a fleet. Records argv and the GEN_* environment it saw into
 * its working directory — which in fleet mode is that generator's own dir.
 */
function stubFleetK6(perGen: Record<number, { code: number; writeSummary: boolean }>, genCount: number): string {
  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  const cases = Object.entries(perGen)
    .map(([i, o]) => `  ${i}) CODE=${o.code}; WRITE=${o.writeSummary ? 1 : 0} ;;`)
    .join('\n');
  const script = `#!/bin/sh
printf '%s\\n' "$@" > k6-argv.txt
echo "GEN_INDEX=\${GEN_INDEX:-unset} GEN_COUNT=\${GEN_COUNT:-unset}" > k6-env.txt
case "\${GEN_INDEX:-unset}" in
${cases}
  *) CODE=1; WRITE=0 ;;
esac
echo "stub-k6 output line 0"
echo "stub-k6 output line 1"
if [ "$WRITE" = 1 ]; then
  sed "s/__GEN__/\${GEN_INDEX}/g" > summary.json <<'JSON'
${fleetSummaryTemplate(genCount)}
JSON
fi
exit $CODE
`;
  const p = join(binDir, 'k6');
  writeFileSync(p, script);
  chmodSync(p, 0o755);
  return binDir;
}

const ok = { code: 0, writeSummary: true };

describe('bin/run.sh single-task fleet mode — detection', () => {
  it('GEN_COUNT=3 with GEN_INDEX unset runs three generators and merges them', () => {
    const workdir = join(root, 'w');
    const binDir = stubFleetK6({ 0: ok, 1: ok, 2: ok }, 3);
    const r = runWrapper(binDir, workdir, { GEN_COUNT: '3', FLEET_CLI });
    expect(r.status, r.stderr).toBe(0);
    for (const i of [0, 1, 2]) {
      expect(existsSync(join(workdir, `gen-${i}`, 'summary.json'))).toBe(true);
      expect(readFileSync(join(workdir, `gen-${i}`, 'k6-env.txt'), 'utf8')).toContain(`GEN_INDEX=${i} GEN_COUNT=3`);
      expect(readFileSync(join(workdir, `gen-${i}`, 'exit_code'), 'utf8').trim()).toBe('0');
    }
    const fleet = JSON.parse(readFileSync(join(workdir, 'fleet', 'summary.json'), 'utf8'));
    expect(fleet.fleet.generator_count).toBe(3);
    expect(fleet.metrics.events_sent.count).toBe(300);
    expect(r.stdout).toMatch(/FLEET 3\/3 — VALID/);
    expect(existsSync(join(workdir, 'summary.json'))).toBe(false);
  });

  it('GEN_INDEX set (even with GEN_COUNT>1) stays in single-generator mode', () => {
    const workdir = join(root, 'w');
    const binDir = stubFleetK6({ 1: ok }, 3);
    const r = runWrapper(binDir, workdir, { GEN_COUNT: '3', GEN_INDEX: '1', FLEET_CLI });
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(workdir, 'summary.json'))).toBe(true);
    expect(existsSync(join(workdir, 'gen-1'))).toBe(false);
    expect(existsSync(join(workdir, 'fleet'))).toBe(false);
  });

  it('GEN_COUNT=1 is single-generator mode', () => {
    const workdir = join(root, 'w');
    const binDir = stubK6({ code: 0, writeSummary: true });
    expect(runWrapper(binDir, workdir, { GEN_COUNT: '1', FLEET_CLI }).status).toBe(0);
    expect(existsSync(join(workdir, 'summary.json'))).toBe(true);
    expect(existsSync(join(workdir, 'gen-0'))).toBe(false);
  });

  it('tags each generator\'s output lines and keeps a per-generator run.log', () => {
    const workdir = join(root, 'w');
    const binDir = stubFleetK6({ 0: ok, 1: ok }, 2);
    const r = runWrapper(binDir, workdir, { GEN_COUNT: '2', FLEET_CLI });
    expect(r.stdout).toContain('[gen-1] stub-k6 output line 0');
    expect(readFileSync(join(workdir, 'gen-1', 'run.log'), 'utf8')).toContain('[gen-1] stub-k6 output line 1');
    expect(readFileSync(join(workdir, 'gen-1', 'run.log'), 'utf8')).not.toContain('[gen-0]');
  });

  it('warns when the fleet is larger than the CPUs it will share', () => {
    const workdir = join(root, 'w');
    const perGen: Record<number, { code: number; writeSummary: boolean }> = {};
    for (let i = 0; i < 64; i++) perGen[i] = ok;
    const binDir = stubFleetK6(perGen, 64);
    const r = runWrapper(binDir, workdir, { GEN_COUNT: '64', FLEET_CLI });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/64 generators .*CPU/);
  });
});

describe('bin/run.sh START_AT scheduled start — fleet mode', () => {
  it('waits once, before launching any generator, so they share the same start', () => {
    const workdir = join(root, 'w');
    const binDir = stubFleetK6({ 0: ok, 1: ok, 2: ok }, 3);
    const startAt = String(Math.floor(Date.now() / 1000) + 2);
    const t0 = Date.now();
    const r = runWrapper(binDir, workdir, { GEN_COUNT: '3', FLEET_CLI, START_AT: startAt });
    const elapsed = Date.now() - t0;
    expect(r.status, r.stderr).toBe(0);
    expect(elapsed).toBeGreaterThanOrEqual(1800);
    // A single shared wait, not one per generator: it must not take anywhere
    // near 3x as long as the single-generator case.
    expect(elapsed).toBeLessThan(5000);
    for (const i of [0, 1, 2]) {
      expect(existsSync(join(workdir, `gen-${i}`, 'summary.json'))).toBe(true);
    }
  });

  it('START_AT in the past logs lateness once and still runs every generator', () => {
    const workdir = join(root, 'w');
    const binDir = stubFleetK6({ 0: ok, 1: ok }, 2);
    const pastEpoch = Math.floor(Date.now() / 1000) - 10;
    const r = runWrapper(binDir, workdir, { GEN_COUNT: '2', FLEET_CLI, START_AT: String(pastEpoch) });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/run\.sh: START_AT was \d+ s ago; starting immediately \(late\)/);
    for (const i of [0, 1]) {
      expect(existsSync(join(workdir, `gen-${i}`, 'summary.json'))).toBe(true);
    }
  });
});

describe('bin/run.sh single-task fleet mode — exit code precedence', () => {
  const runFleet = (perGen: Record<number, { code: number; writeSummary: boolean }>) => {
    const binDir = stubFleetK6(perGen, 3);
    return runWrapper(binDir, join(root, 'w'), { GEN_COUNT: '3', FLEET_CLI });
  };

  it('all generators succeed -> 0', () => {
    expect(runFleet({ 0: ok, 1: ok, 2: ok }).status).toBe(0);
  });

  it('one threshold breach -> 99, the CI gate', () => {
    const r = runFleet({ 0: ok, 1: { code: 99, writeSummary: true }, 2: ok });
    expect(r.status).toBe(99);
    const fleet = JSON.parse(readFileSync(join(root, 'w', 'fleet', 'summary.json'), 'utf8'));
    expect(fleet.fleet.exit_code).toBe(99);
  });

  it('a generator that never ran beats a threshold breach: 107 + 99 -> 107', () => {
    const r = runFleet({ 0: { code: 107, writeSummary: false }, 1: { code: 99, writeSummary: true }, 2: ok });
    expect(r.status).toBe(107);
    const fleet = JSON.parse(readFileSync(join(root, 'w', 'fleet', 'summary.json'), 'utf8'));
    expect(fleet.validity.valid).toBe(false);
    expect(fleet.fleet.generators_reported).toBe(2);
    // The shell precedence and the merge module's must never drift apart.
    expect(fleet.fleet.exit_code).toBe(r.status);
  });

  it('a bogus success (exit 0, no summary) is promoted to 1 per generator', () => {
    const r = runFleet({ 0: ok, 1: { code: 0, writeSummary: false }, 2: ok });
    expect(r.status).toBe(1);
    expect(readFileSync(join(root, 'w', 'gen-1', 'exit_code'), 'utf8').trim()).toBe('1');
  });

  it('every generator crashing still exits with the crash code and ships nothing but logs', () => {
    const r = runFleet({ 0: { code: 107, writeSummary: false }, 1: { code: 107, writeSummary: false }, 2: { code: 107, writeSummary: false } });
    expect(r.status).toBe(107);
    expect(r.stderr).toMatch(/fleet merge failed/);
    expect(existsSync(join(root, 'w', 'fleet', 'summary.json'))).toBe(false);
  });
});

describe('bin/run.sh single-task fleet mode — shipping', () => {
  it('ships every generator\'s artifacts and the fleet artifacts to their own s3 keys', () => {
    const workdir = join(root, 'w');
    const awsLog = join(root, 'aws.log');
    const binDir = stubFleetK6({ 0: ok, 1: ok, 2: ok }, 3);
    stubAws(binDir);
    const r = runWrapper(binDir, workdir, {
      GEN_COUNT: '3', FLEET_CLI, INDEX_CLI,
      RESULTS_URI: 's3://bucket/prefix', AWS_REGION: 'test-region-1', AWS_STUB_LOG: awsLog,
    });
    expect(r.status, r.stderr).toBe(0);
    const expected: string[] = [];
    for (const i of [0, 1, 2]) {
      expected.push(
        `s3://bucket/prefix/index/dt=2026-08-29/r1-gen${i}.json`,
        `s3://bucket/prefix/runs/r1/gen-${i}/summary.json`,
        `s3://bucket/prefix/runs/r1/gen-${i}/run.log`,
        `s3://bucket/prefix/runs/r1/gen-${i}/exit_code`,
      );
    }
    expected.push(
      's3://bucket/prefix/index/dt=2026-08-29/r1-fleet.json',
      's3://bucket/prefix/runs/r1/fleet/summary.json',
      's3://bucket/prefix/runs/r1/fleet/run.log',
    );
    expect([...awsDestinations(awsLog)].sort()).toEqual(expected.sort());
    expect(r.stderr).toContain('15 of 15 artifacts shipped');
  });

  it('places a crashed generator\'s run.log under its own gen-<i> key using the fleet summary\'s identity', () => {
    const workdir = join(root, 'w');
    const awsLog = join(root, 'aws.log');
    const binDir = stubFleetK6({ 0: { code: 107, writeSummary: false }, 1: ok }, 2);
    stubAws(binDir);
    const r = runWrapper(binDir, workdir, {
      GEN_COUNT: '2', FLEET_CLI, INDEX_CLI,
      RESULTS_URI: 's3://bucket/prefix', AWS_REGION: 'test-region-1', AWS_STUB_LOG: awsLog,
    });
    expect(r.status).toBe(107);
    const dests = awsDestinations(awsLog);
    expect(dests).toContain('s3://bucket/prefix/runs/r1/gen-0/run.log');
    expect(dests).not.toContain('s3://bucket/prefix/runs/r1/gen-0/summary.json');
    expect(dests).toContain('s3://bucket/prefix/runs/r1/gen-1/summary.json');
    expect(dests).toContain('s3://bucket/prefix/runs/r1/fleet/summary.json');
  });

  it('copies per-generator and fleet artifacts into subdirectories of a local RESULTS_URI', () => {
    const workdir = join(root, 'w');
    const results = join(root, 'results');
    const binDir = stubFleetK6({ 0: ok, 1: ok }, 2);
    const r = runWrapper(binDir, workdir, { GEN_COUNT: '2', FLEET_CLI, RESULTS_URI: results });
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(results, 'gen-0', 'summary.json'))).toBe(true);
    expect(existsSync(join(results, 'gen-1', 'run.log'))).toBe(true);
    expect(existsSync(join(results, 'fleet', 'summary.json'))).toBe(true);
    expect(existsSync(join(results, 'fleet', 'run.log'))).toBe(true);
    expect(existsSync(join(results, 'summary.json'))).toBe(false);
  });

  it('a failed merge still ships the per-generator artifacts and keeps k6\'s verdict', () => {
    const workdir = join(root, 'w');
    const results = join(root, 'results');
    const binDir = stubFleetK6({ 0: ok, 1: { code: 99, writeSummary: true } }, 2);
    const r = runWrapper(binDir, workdir, { GEN_COUNT: '2', FLEET_CLI: 'false', RESULTS_URI: results });
    expect(r.status).toBe(99);
    expect(r.stderr).toMatch(/fleet merge failed/);
    expect(existsSync(join(results, 'gen-0', 'summary.json'))).toBe(true);
    expect(existsSync(join(results, 'gen-1', 'summary.json'))).toBe(true);
    expect(existsSync(join(results, 'fleet', 'summary.json'))).toBe(false);
  });
});

describe('bin/run.sh operator mode — `fleet-launch` dispatch', () => {
  it('execs the launcher with the remaining arguments and runs nothing else', () => {
    const binDir = stubK6({ code: 0, writeSummary: true });
    const launcher = join(root, 'launcher.sh');
    writeFileSync(launcher, '#!/bin/sh\nprintf "%s\\n" "$@" > "$LAUNCH_ARGV"\nexit 7\n');
    chmodSync(launcher, 0o755);
    const workdir = join(root, 'w');
    const r = spawnSync('sh', [RUN_SH, 'fleet-launch', 'run', '--count', '3'], {
      env: { PATH: `${binDir}:${process.env.PATH ?? ''}`, WORKDIR: workdir, FLEET_LAUNCH_CLI: launcher, LAUNCH_ARGV: join(root, 'argv.txt') },
      encoding: 'utf8',
    });
    expect(r.status).toBe(7);
    expect(readFileSync(join(root, 'argv.txt'), 'utf8')).toBe('run\n--count\n3\n');
    expect(existsSync(workdir)).toBe(false); // never got as far as the run path
    expect(existsSync(join(workdir, 'k6-argv.txt'))).toBe(false);
  });
});
