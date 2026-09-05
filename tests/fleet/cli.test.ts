import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Exercises src/fleet/cli.ts AS A PROCESS — what bin/run.sh invokes via
 * $FLEET_CLI after every generator of a single-task fleet has exited.
 */
const REPO = resolve(__dirname, '../..');
const TSX = join(REPO, 'node_modules', '.bin', 'tsx');
const CLI = join(REPO, 'src', 'fleet', 'cli.ts');

const summary = (i: number, sent: number) =>
  JSON.stringify({
    schema_version: 2,
    run: { run_id: 'f1', started_at: '2026-08-29T10:00:00.000Z', ended_at: '2026-08-29T10:01:00.000Z', duration_sec: 60, k6_version: 'v2.2.0', active_types: ['json-app'], start_at: null },
    resolved_config: { name: 'local-null' },
    generator: { gen_index: i, gen_count: 2 },
    rate: { requested_eps: 100, achieved_eps: 100, delta_pct: 0 },
    metrics: { events_attempted: { count: sent }, events_sent: { count: sent }, send_failures: { rate: 0, passes: 0, fails: 1 } },
    types: {},
    thresholds: { slo: [], structural_count: 0 },
    verdict_from: [],
    validity: { dropped_iterations: 0, generator_cpu: null, valid: true, reasons: [] },
    payload_sample: [],
    warnings: [],
  });

const bucket = (sent: number) =>
  JSON.stringify({ bucket_start: '2026-08-29T10:00:00.000Z', bucket_sec: 15, events_sent: sent, events_attempted: sent, eps: sent / 15, send_failures: 0, send_samples: 1, failure_rate: 0, send_duration_p50: null, send_duration_p95: null, send_duration_p99: null, dropped_iterations: 0 });

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'fleet-cli-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function genDir(i: number, files: Record<string, string>): string {
  const d = join(root, `gen-${i}`);
  mkdirSync(d, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(d, name), content);
  return d;
}

function run(args: string[]) {
  return spawnSync(TSX, [CLI, ...args], { encoding: 'utf8' });
}

describe('src/fleet/cli.ts merge (spawned as a process)', () => {
  it('writes a fleet summary and merged timeline, prints the report, exits 0', () => {
    const a = genDir(0, { 'summary.json': summary(0, 300), exit_code: '0\n', 'timeline.jsonl': bucket(300) + '\n' });
    const b = genDir(1, { 'summary.json': summary(1, 500), exit_code: '0\n', 'timeline.jsonl': bucket(500) + '\n' });
    const out = join(root, 'fleet');
    const r = run(['merge', out, a, b]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/FLEET 2\/2 — VALID/);

    const f = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
    expect(f.fleet.generator_count).toBe(2);
    expect(f.generator).toEqual({ gen_index: null, gen_count: 2 });
    expect(f.metrics.events_sent.count).toBe(800);
    expect(f.fleet.generators.map((g: { exit_code: number }) => g.exit_code)).toEqual([0, 0]);

    const t = readFileSync(join(out, 'timeline.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(t).toHaveLength(1);
    expect(t[0].events_sent).toBe(800);
  });

  it('tolerates a generator with no summary, no exit code and no timeline, and marks the fleet invalid', () => {
    const a = genDir(0, { 'summary.json': summary(0, 300), exit_code: '0\n', 'timeline.jsonl': bucket(300) + '\n' });
    const b = genDir(1, {});
    const out = join(root, 'fleet');
    const r = run(['merge', out, a, b]);
    expect(r.status, r.stderr).toBe(0);
    const f = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
    expect(f.validity.valid).toBe(false);
    expect(f.fleet.generators[1]).toMatchObject({ gen_index: 1, exit_code: null, summary_present: false });
    expect(readFileSync(join(out, 'timeline.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('takes the generator index from the directory name, not the order of arguments', () => {
    const a = genDir(1, { 'summary.json': summary(1, 1), exit_code: '99\n' });
    const b = genDir(0, { 'summary.json': summary(0, 1), exit_code: '0\n' });
    const out = join(root, 'fleet');
    expect(run(['merge', out, a, b]).status).toBe(0);
    const f = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
    expect(f.fleet.generators.map((g: { gen_index: number; exit_code: number }) => [g.gen_index, g.exit_code])).toEqual([[0, 0], [1, 99]]);
  });

  it('rejects a generator directory whose index is outside the fleet, writing nothing', () => {
    const a = genDir(0, { 'summary.json': summary(0, 1), exit_code: '0\n' });
    const b = genDir(3, { 'summary.json': summary(3, 1), exit_code: '0\n' });
    const out = join(root, 'fleet');
    const r = run(['merge', out, a, b]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/gen-3 is outside a fleet of 2/);
    expect(existsSync(join(out, 'summary.json'))).toBe(false);
  });

  it('refuses to merge generators from different runs, writing nothing', () => {
    const a = genDir(0, { 'summary.json': summary(0, 1), exit_code: '0\n' });
    const b = genDir(1, { 'summary.json': summary(1, 1).replace('"run_id":"f1"', '"run_id":"f2"'), exit_code: '0\n' });
    const out = join(root, 'fleet');
    const r = run(['merge', out, a, b]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/disagree on run\.run_id/);
    expect(existsSync(join(out, 'summary.json'))).toBe(false);
  });

  it('records which generators had a timeline, and warns when one did not', () => {
    const a = genDir(0, { 'summary.json': summary(0, 300), exit_code: '0\n', 'timeline.jsonl': bucket(300) + '\n' });
    const b = genDir(1, { 'summary.json': summary(1, 500), exit_code: '0\n' });
    const out = join(root, 'fleet');
    const r = run(['merge', out, a, b]);
    expect(r.status, r.stderr).toBe(0);
    const f = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
    expect(f.fleet.timeline_coverage).toEqual({ expected: 2, present: [0], missing: [1], complete: false, configured_off: false, orphan_timelines: [] });
    expect(f.warnings.join(' ')).toMatch(/timeline coverage.*gen-1/);
    expect(r.stdout).toMatch(/timeline coverage\s+: 1\/2 generators \(missing gen-1\)/);
  });

  it('does NOT merge a timeline from a generator that produced no summary', () => {
    // bin/run.sh buckets whatever raw.json it finds, so a k6 killed after
    // writing raw.json but before handleSummary leaves a timeline beside no
    // summary. Summing it in inflates every bucket against summary totals
    // that never counted those events — and hides a truncated timeline,
    // because the merged total would then always look large enough.
    const a = genDir(0, { 'summary.json': summary(0, 300), exit_code: '0\n', 'timeline.jsonl': bucket(300) + '\n' });
    const b = genDir(1, { exit_code: '137\n', 'timeline.jsonl': bucket(500) + '\n' });
    const out = join(root, 'fleet');
    const r = run(['merge', out, a, b]);
    expect(r.status, r.stderr).toBe(0);

    const t = readFileSync(join(out, 'timeline.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(t).toHaveLength(1);
    expect(t[0].events_sent).toBe(300); // gen-1's 500 were dropped, not summed

    const f = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
    expect(f.fleet.timeline_coverage).toEqual({
      expected: 2, present: [0], missing: [1], complete: false, configured_off: false, orphan_timelines: [1],
    });
    expect(f.warnings.join(' ')).toMatch(/gen-1 produced a timeline but no summary; its timeline was not merged/);
    expect(r.stdout).toMatch(/timeline orphans/);
  });

  it('marks coverage configured_off when no generator emitted a timeline', () => {
    const a = genDir(0, { 'summary.json': summary(0, 1), exit_code: '0\n' });
    const b = genDir(1, { 'summary.json': summary(1, 1), exit_code: '0\n' });
    const out = join(root, 'fleet');
    expect(run(['merge', out, a, b]).status).toBe(0);
    const f = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
    expect(f.fleet.timeline_coverage).toMatchObject({ complete: false, configured_off: true, present: [] });
    expect(f.warnings.join(' ')).not.toMatch(/timeline coverage/);
  });

  it('warns when a complete timeline holds far fewer events than the summary', () => {
    // 800 events sent between the two summaries, 100 of them in the timeline
    const a = genDir(0, { 'summary.json': summary(0, 300), exit_code: '0\n', 'timeline.jsonl': bucket(50) + '\n' });
    const b = genDir(1, { 'summary.json': summary(1, 500), exit_code: '0\n', 'timeline.jsonl': bucket(50) + '\n' });
    const out = join(root, 'fleet');
    const r = run(['merge', out, a, b]);
    expect(r.status, r.stderr).toBe(0);
    const f = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
    expect(f.fleet.timeline_coverage.complete).toBe(true);
    expect(f.warnings.join(' ')).toMatch(/timeline holds 100 of the summary's 800 events_sent/);
  });

  it('exits 1 and writes nothing when no generator produced a summary', () => {
    const a = genDir(0, { exit_code: '107\n' });
    const b = genDir(1, { exit_code: '107\n' });
    const out = join(root, 'fleet');
    const r = run(['merge', out, a, b]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no generator produced a summary/i);
    expect(existsSync(join(out, 'summary.json'))).toBe(false);
  });

  it('writes nothing when the timeline merge fails, so a half-merged fleet cannot be shipped', () => {
    const a = genDir(0, { 'summary.json': summary(0, 300), exit_code: '0\n', 'timeline.jsonl': bucket(300) + '\n' });
    const wide = bucket(500).replace('"bucket_sec":15', '"bucket_sec":30');
    const b = genDir(1, { 'summary.json': summary(1, 500), exit_code: '0\n', 'timeline.jsonl': wide + '\n' });
    const out = join(root, 'fleet');
    const r = run(['merge', out, a, b]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/bucket_sec/);
    expect(existsSync(join(out, 'summary.json'))).toBe(false);
  });

  it('rejects a directory that is not named gen-<index>', () => {
    const bad = join(root, 'other');
    mkdirSync(bad);
    const r = run(['merge', join(root, 'fleet'), bad]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/gen-<index>/);
  });
});
