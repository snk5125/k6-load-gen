import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { injectGenerator, parseS3Uri, generateRunId, parseArgs } from '../../src/fleet/launch.ts';

/**
 * Drives src/fleet/launch.ts as a process against a STUB `aws` on PATH —
 * the same technique tests/wrapper/run-sh.test.ts uses for k6 and aws.
 * The stub answers run-task, describe-tasks (RUNNING once, then STOPPED)
 * and `s3 cp` (recursive downloads come from a local fixture directory;
 * uploads are only recorded), so the whole launch → wait → merge → upload
 * path runs hermetically.
 */
const REPO = resolve(__dirname, '../..');
const TSX = join(REPO, 'node_modules', '.bin', 'tsx');
const CLI = join(REPO, 'src', 'fleet', 'launch.ts');

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'fleet-launch-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function stubAws(): string {
  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  const script = `#!/bin/sh
printf '%s\\n' "$*" >> "$AWS_STUB_LOG"
case "$1 $2" in
  "ecs run-task")
    n=$(cat "$AWS_STUB_COUNT" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$AWS_STUB_COUNT"
    printf '{"tasks":[{"taskArn":"arn:aws:ecs:x:1:task/c/t%s"}],"failures":[]}\\n' "$n" ;;
  "ecs describe-tasks")
    d=$(cat "$AWS_STUB_DESCRIBE" 2>/dev/null || echo 0); d=$((d+1)); echo $d > "$AWS_STUB_DESCRIBE"
    if [ "$d" -lt 2 ]; then status=RUNNING; else status=STOPPED; fi
    n=$(cat "$AWS_STUB_COUNT"); codes="\${AWS_STUB_EXIT_CODES:-}"; missing="\${AWS_STUB_MISSING:-}"
    # Only the ARNs asked for are described; a task listed in AWS_STUB_MISSING
    # comes back in failures[] (reason MISSING) from the second poll on, the
    # way ECS answers for a task that aged out. A sidecar container is listed
    # FIRST so a by-position read would pick the wrong exit code.
    printf '{"tasks":['
    first=1; i=1; while [ $i -le $n ]; do
      case " $* " in *"task/c/t$i "*)
        if [ "$d" -ge 2 ] && [ "$missing" = "$i" ]; then :; else
          code=$(echo "$codes" | cut -d, -f$i); [ -z "$code" ] && code=0
          [ $first -eq 0 ] && printf ','; first=0
          printf '{"taskArn":"arn:aws:ecs:x:1:task/c/t%s","lastStatus":"%s","stoppedReason":"Essential container in task exited","containers":[{"name":"sidecar","exitCode":0},{"name":"k6-load-gen","exitCode":%s}]}' "$i" "$status" "$code"
        fi ;;
      esac
      i=$((i+1))
    done
    printf '],"failures":['
    if [ "$d" -ge 2 ] && [ -n "$missing" ]; then printf '{"arn":"arn:aws:ecs:x:1:task/c/t%s","reason":"MISSING"}' "$missing"; fi
    printf ']}\\n' ;;
  "s3 cp")
    case "$*" in
      *--recursive*)
        rel=$(echo "$3" | sed -e 's|^s3://[^/]*/||'); mkdir -p "$4"; cp -R "$AWS_STUB_S3_DIR/$rel"/. "$4"/ 2>/dev/null ;;
      "s3 cp s3://"*)
        # download of one object: serve it from the fixture, or fail like a missing key
        rel=$(echo "$3" | sed -e 's|^s3://[^/]*/||'); [ -f "$AWS_STUB_S3_DIR/$rel" ] && cp "$AWS_STUB_S3_DIR/$rel" "$4" || exit 1 ;;
    esac ;;
esac
exit 0
`;
  writeFileSync(join(binDir, 'aws'), script);
  chmodSync(join(binDir, 'aws'), 0o755);
  return binDir;
}

const summary = (i: number, count: number, sent: number, ok = true) =>
  JSON.stringify({
    schema_version: 2,
    run: { run_id: 'f1', started_at: '2026-08-29T10:00:00.000Z', ended_at: '2026-08-29T10:01:00.000Z', duration_sec: 60, k6_version: 'v2.2.0', active_types: ['json-app'] },
    resolved_config: { name: 'hec', target: { transport: 'hec' }, types: { 'json-app': { scenario: 'sweep' } } },
    generator: { gen_index: i, gen_count: count },
    rate: { requested_eps: 100, achieved_eps: 100, delta_pct: 0 },
    metrics: { events_attempted: { count: sent }, events_sent: { count: sent }, send_failures: { rate: 0, passes: 0, fails: 1 } },
    types: {},
    thresholds: { slo: [{ ok, metric: 'send_failures', expression: 'rate<0.001' }], structural_count: 0 },
    verdict_from: ['send_failures rate<0.001'],
    validity: { dropped_iterations: 0, generator_cpu: null, valid: true, reasons: [] },
    payload_sample: [],
    warnings: [],
  });

const bucketLine = (sent: number) =>
  JSON.stringify({ bucket_start: '2026-08-29T10:00:00.000Z', bucket_sec: 15, events_sent: sent, events_attempted: sent, eps: sent / 15, send_failures: 0, send_samples: 1, failure_rate: 0, send_duration_p50: null, send_duration_p95: null, send_duration_p99: null, dropped_iterations: 0 });

/** A fake bucket on disk, laid out like the real one: runs/f1/gen-<i>/... plus
 * the date-partitioned timeline/dt=2026-08-29/f1-gen<i>.jsonl objects. */
function fakeBucket(prefix: string, gens: Record<number, { sent: number; exit: string; ok?: boolean; timeline?: boolean }>, count: number): string {
  const s3 = join(root, 's3');
  for (const [i, g] of Object.entries(gens)) {
    const d = join(s3, prefix, 'runs', 'f1', `gen-${i}`);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'summary.json'), summary(Number(i), count, g.sent, g.ok ?? true));
    writeFileSync(join(d, 'exit_code'), g.exit + '\n');
    writeFileSync(join(d, 'run.log'), 'log\n');
    if (g.timeline !== false) {
      const t = join(s3, prefix, 'timeline', 'dt=2026-08-29');
      mkdirSync(t, { recursive: true });
      writeFileSync(join(t, `f1-gen${i}.jsonl`), bucketLine(g.sent) + '\n');
    }
  }
  return s3;
}

function overridesFile(env: Array<{ name: string; value: string }>): string {
  const p = join(root, 'overrides.json');
  writeFileSync(p, JSON.stringify({ containerOverrides: [{ name: 'k6-load-gen', environment: env }] }));
  return p;
}

function run(binDir: string, args: string[], extraEnv: Record<string, string> = {}) {
  const log = join(root, 'aws.log');
  const r = spawnSync(TSX, [CLI, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      AWS_STUB_LOG: log,
      AWS_STUB_COUNT: join(root, 'count'),
      AWS_STUB_DESCRIBE: join(root, 'describe'),
      AWS_STUB_S3_DIR: join(root, 's3'),
      ...extraEnv,
    },
  });
  const lines = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
  return { ...r, lines };
}

const baseArgs = ['--cluster', 'c', '--task-definition', 'td', '--network-configuration', 'net', '--poll-interval', '0.01', '--timeout', '30'];

describe('fleet-launch helpers', () => {
  it('parses an s3 URI with and without a prefix', () => {
    expect(parseS3Uri('s3://b/k6-runs/')).toEqual({ bucket: 'b', prefix: 'k6-runs' });
    expect(parseS3Uri('s3://b')).toEqual({ bucket: 'b', prefix: '' });
    expect(() => parseS3Uri('/local/dir')).toThrow(/s3:\/\//);
  });

  it('injects GEN_INDEX/GEN_COUNT and replaces any the file had', () => {
    const o = { containerOverrides: [{ name: 'k6-load-gen', environment: [{ name: 'PROFILE', value: 'hec' }, { name: 'GEN_COUNT', value: '9' }] }] };
    const env = injectGenerator(o, 2, 4).containerOverrides![0].environment!;
    expect(env).toEqual([{ name: 'PROFILE', value: 'hec' }, { name: 'GEN_INDEX', value: '2' }, { name: 'GEN_COUNT', value: '4' }]);
  });

  it('accepts --key value and --key=value, including a task definition with a revision or as an ARN', () => {
    expect(parseArgs(['--task-definition', 'k6-load-gen:12', '--count', '3'])).toEqual({ 'task-definition': 'k6-load-gen:12', count: '3' });
    expect(parseArgs(['--task-definition=k6-load-gen:12', '--no-merge'])).toEqual({ 'task-definition': 'k6-load-gen:12', 'no-merge': true });
    expect(parseArgs(['--task-definition=arn:aws:ecs:r:1:task-definition/k6-load-gen:12'])['task-definition']).toBe('arn:aws:ecs:r:1:task-definition/k6-load-gen:12');
    expect(() => parseArgs(['--count'])).toThrow(/needs a value/);
  });

  it('explains a stray positional and rejects an unknown option', () => {
    expect(() => parseArgs(['--no-merge', 'k6-loadgen:7'])).toThrow(/unexpected argument "k6-loadgen:7": --no-merge takes no value/);
    expect(() => parseArgs(['--task-definition', 'k6-loadgen', 'k6-loadgen:7'])).toThrow(/already had its value/);
    expect(() => parseArgs(['--task-defintion', 'x'])).toThrow(/unknown option --task-defintion/);
  });

  it('generates a run id that passes the key allowlist', () => {
    expect(generateRunId(new Date('2026-09-04T12:34:56.000Z'))).toMatch(/^fleet-20260904-123456Z-[0-9a-f]{8}$/);
  });
});

describe('fleet-launch run (spawned, stub aws)', () => {
  it('launches N tasks with distinct GEN_INDEX, waits, merges from S3, uploads the fleet artifacts and exits with the fleet code', () => {
    const binDir = stubAws();
    fakeBucket('k6-runs', { 0: { sent: 300, exit: '0' }, 1: { sent: 500, exit: '0' } }, 2);
    const ov = overridesFile([{ name: 'PROFILE', value: 'hec' }, { name: 'RUN_ID', value: 'f1' }, { name: 'RESULTS_URI', value: 's3://bucket/k6-runs' }]);
    const work = join(root, 'work');
    const r = run(binDir, ['run', ...baseArgs, '--overrides', ov, '--count', '2', '--work-dir', work]);
    expect(r.status, r.stderr).toBe(0);

    const runTasks = r.lines.filter((l) => l.startsWith('ecs run-task'));
    expect(runTasks).toHaveLength(2);
    const envs = runTasks.map((l) => JSON.parse(l.slice(l.indexOf('{'), l.lastIndexOf('}') + 1)).containerOverrides[0].environment);
    expect(envs[0]).toContainEqual({ name: 'GEN_INDEX', value: '0' });
    expect(envs[1]).toContainEqual({ name: 'GEN_INDEX', value: '1' });
    for (const e of envs) {
      expect(e).toContainEqual({ name: 'GEN_COUNT', value: '2' });
      expect(e).toContainEqual({ name: 'RUN_ID', value: 'f1' });
    }
    expect(runTasks[0]).toContain('--cluster c --task-definition td --launch-type FARGATE --network-configuration net');

    expect(r.lines.filter((l) => l.startsWith('ecs describe-tasks')).length).toBeGreaterThanOrEqual(2);
    expect(r.lines.some((l) => l.startsWith('s3 cp s3://bucket/k6-runs/runs/f1/') && l.includes('--recursive'))).toBe(true);
    // The per-generator timelines live in the date partition, not under runs/; both must be fetched by key.
    expect(r.lines).toContain(`s3 cp s3://bucket/k6-runs/timeline/dt=2026-08-29/f1-gen0.jsonl ${join(work, 'gen-0', 'timeline.jsonl')} --only-show-errors`);
    expect(r.lines).toContain(`s3 cp s3://bucket/k6-runs/timeline/dt=2026-08-29/f1-gen1.jsonl ${join(work, 'gen-1', 'timeline.jsonl')} --only-show-errors`);
    const uploads = r.lines.filter((l) => /^s3 cp \S+ s3:\/\//.test(l)).map((l) => l.split(' ')[3]).sort();
    expect(uploads).toEqual([
      's3://bucket/k6-runs/index/dt=2026-08-29/f1-fleet.json',
      's3://bucket/k6-runs/runs/f1/fleet/run.log',
      's3://bucket/k6-runs/runs/f1/fleet/summary.json',
      's3://bucket/k6-runs/timeline/dt=2026-08-29/f1-fleet.jsonl',
    ]);
    expect(r.stdout).toMatch(/FLEET 2\/2 — VALID/);
    const fleet = JSON.parse(readFileSync(join(work, 'fleet', 'summary.json'), 'utf8'));
    expect(fleet.metrics.events_sent.count).toBe(800);
    expect(fleet.fleet.generators.map((g: { exit_code: number }) => g.exit_code)).toEqual([0, 0]);
    const tl = readFileSync(join(work, 'fleet', 'timeline.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(tl).toHaveLength(1);
    expect(tl[0].events_sent).toBe(800);
  });

  it('merges without a timeline when the run had them off, and says so', () => {
    const binDir = stubAws();
    fakeBucket('k6-runs', { 0: { sent: 1, exit: '0', timeline: false }, 1: { sent: 1, exit: '0', timeline: false } }, 2);
    const ov = overridesFile([{ name: 'RUN_ID', value: 'f1' }, { name: 'RESULTS_URI', value: 's3://bucket/k6-runs' }]);
    const work = join(root, 'work');
    const r = run(binDir, ['run', ...baseArgs, '--overrides', ov, '--count', '2', '--work-dir', work]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/gen-0: no timeline at/);
    expect(existsSync(join(work, 'fleet', 'timeline.jsonl'))).toBe(false);
    expect(r.lines.some((l) => l.includes('f1-fleet.jsonl'))).toBe(false);
  });

  it('uses the ECS container exit code for a generator that shipped nothing, and exits with it', () => {
    const binDir = stubAws();
    fakeBucket('k6-runs', { 0: { sent: 300, exit: '0' } }, 2); // gen-1 never wrote to S3
    const ov = overridesFile([{ name: 'RUN_ID', value: 'f1' }, { name: 'RESULTS_URI', value: 's3://bucket/k6-runs' }]);
    const work = join(root, 'work');
    const r = run(binDir, ['run', ...baseArgs, '--overrides', ov, '--count', '2', '--work-dir', work], { AWS_STUB_EXIT_CODES: '0,107' });
    expect(r.status).toBe(107);
    const fleet = JSON.parse(readFileSync(join(work, 'fleet', 'summary.json'), 'utf8'));
    expect(fleet.validity.valid).toBe(false);
    expect(fleet.fleet.generators[1]).toMatchObject({ gen_index: 1, exit_code: 107, summary_present: false });
    expect(r.stderr).toMatch(/gen-1: no summary\.json in S3/);
  });

  it('exits 99 when a generator breached a threshold', () => {
    const binDir = stubAws();
    fakeBucket('k6-runs', { 0: { sent: 300, exit: '0' }, 1: { sent: 300, exit: '99', ok: false } }, 2);
    const ov = overridesFile([{ name: 'RUN_ID', value: 'f1' }, { name: 'RESULTS_URI', value: 's3://bucket/k6-runs' }]);
    const r = run(binDir, ['run', ...baseArgs, '--overrides', ov, '--count', '2'], { AWS_STUB_EXIT_CODES: '0,99' });
    expect(r.status).toBe(99);
    expect(r.stdout).toMatch(/FAILED THRESHOLDS/);
  });

  it('--no-merge launches and waits only, printing the run id', () => {
    const binDir = stubAws();
    const ov = overridesFile([{ name: 'RUN_ID', value: 'f1' }]);
    const r = run(binDir, ['run', ...baseArgs, '--overrides', ov, '--count', '3', '--no-merge']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe('f1');
    expect(r.lines.filter((l) => l.startsWith('ecs run-task'))).toHaveLength(3);
    expect(r.lines.some((l) => l.startsWith('s3 cp'))).toBe(false);
  });

  it('generates a RUN_ID when the overrides file has none, and injects it', () => {
    const binDir = stubAws();
    const ov = overridesFile([{ name: 'PROFILE', value: 'hec' }]);
    const r = run(binDir, ['run', ...baseArgs, '--overrides', ov, '--count', '1', '--no-merge']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toMatch(/^fleet-\d{8}-\d{6}Z-[0-9a-f]{8}$/);
    const env = JSON.parse(r.lines[0].slice(r.lines[0].indexOf('{'), r.lines[0].lastIndexOf('}') + 1)).containerOverrides[0].environment;
    expect(env.find((e: { name: string }) => e.name === 'RUN_ID').value).toBe(r.stdout.trim());
  });

  it('--no-merge exits with the same precedence as a merged fleet', () => {
    const binDir = stubAws();
    const ov = overridesFile([{ name: 'RUN_ID', value: 'f1' }]);
    expect(run(binDir, ['run', ...baseArgs, '--overrides', ov, '--count', '3', '--no-merge'], { AWS_STUB_EXIT_CODES: '0,99,0' }).status).toBe(99);
    rmSync(join(root, 'count'), { force: true }); rmSync(join(root, 'describe'), { force: true }); rmSync(join(root, 'aws.log'), { force: true });
    expect(run(binDir, ['run', ...baseArgs, '--overrides', ov, '--count', '3', '--no-merge'], { AWS_STUB_EXIT_CODES: '99,137,0' }).status).toBe(137);
  });

  it('treats a task that aged out of describe-tasks as stopped and takes its exit code from the artifact', () => {
    const binDir = stubAws();
    fakeBucket('k6-runs', { 0: { sent: 300, exit: '0' }, 1: { sent: 500, exit: '0' } }, 2);
    const ov = overridesFile([{ name: 'RUN_ID', value: 'f1' }, { name: 'RESULTS_URI', value: 's3://bucket/k6-runs' }]);
    const work = join(root, 'work');
    // Task 1 (gen-0) disappears from the API from the second poll on.
    const r = run(binDir, ['run', ...baseArgs, '--overrides', ov, '--count', '2', '--work-dir', work], { AWS_STUB_MISSING: '1' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/gen-0: .*no longer returned by describe-tasks/);
    const fleet = JSON.parse(readFileSync(join(work, 'fleet', 'summary.json'), 'utf8'));
    expect(fleet.fleet.generators.map((g: { exit_code: number }) => g.exit_code)).toEqual([0, 0]);
  });

  it('refuses an overrides file that sets GEN_INDEX, and a merge with no RESULTS_URI, before launching anything', () => {
    const binDir = stubAws();
    const withIndex = overridesFile([{ name: 'RUN_ID', value: 'f1' }, { name: 'GEN_INDEX', value: '0' }]);
    let r = run(binDir, ['run', ...baseArgs, '--overrides', withIndex, '--count', '2']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/GEN_INDEX/);
    expect(r.lines).toHaveLength(0);

    const noUri = overridesFile([{ name: 'RUN_ID', value: 'f1' }]);
    r = run(binDir, ['run', ...baseArgs, '--overrides', noUri, '--count', '2']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/RESULTS_URI/);
    expect(r.lines).toHaveLength(0);
  });
});

describe('fleet-launch merge (spawned, stub aws)', () => {
  it('merges an existing run prefix without launching anything', () => {
    const binDir = stubAws();
    fakeBucket('', { 0: { sent: 10, exit: '0' }, 1: { sent: 20, exit: '0' }, 2: { sent: 30, exit: '0' } }, 3);
    const work = join(root, 'work');
    const r = run(binDir, ['merge', '--results-uri', 's3://bucket', '--run-id', 'f1', '--count', '3', '--work-dir', work]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.lines.some((l) => l.startsWith('ecs '))).toBe(false);
    expect(r.stdout).toMatch(/FLEET 3\/3 — VALID/);
    const uploads = r.lines.filter((l) => /^s3 cp \S+ s3:\/\//.test(l)).map((l) => l.split(' ')[3]);
    expect(uploads).toContain('s3://bucket/runs/f1/fleet/summary.json');
    expect(uploads).toContain('s3://bucket/index/dt=2026-08-29/f1-fleet.json');
    expect(JSON.parse(readFileSync(join(work, 'fleet', 'summary.json'), 'utf8')).metrics.events_sent.count).toBe(60);
  });

  it('prints usage and exits 0 on --help, 2 with no mode', () => {
    const binDir = stubAws();
    expect(run(binDir, ['--help']).status).toBe(0);
    expect(run(binDir, []).status).toBe(2);
  });
});
