import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emitIndex, emitKeys, emitTimelineFlag, writeKeyFiles } from '../../src/storage/index-cli.ts';

const summary = JSON.stringify({
  schema_version: 1,
  run: { run_id: 'r1', started_at: '2026-08-29T22:00:00.000Z' },
  generator: { gen_index: 0, gen_count: 1 },
  resolved_config: { name: 'p', target: { transport: 'null' }, scenario: 'smoke' },
  metrics: {},
  thresholds: {},
  validity: { valid: true },
});

describe('emitIndex', () => {
  it('emits exactly one line', () => {
    expect(emitIndex(summary).trim().split('\n').length).toBe(1);
  });

  it('emits parseable flat JSON', () => {
    const obj = JSON.parse(emitIndex(summary));
    expect(obj.run_id).toBe('r1');
    expect(obj.transport).toBe('null');
  });
});

describe('emitKeys', () => {
  it('returns the run keys as a plain object, not shell text', () => {
    const out = emitKeys(summary, 'k6');
    expect(out).toEqual({
      index: 'k6/index/dt=2026-08-29/r1-gen0.json',
      timeline: 'k6/timeline/dt=2026-08-29/r1-gen0.jsonl',
      summary: 'k6/runs/r1/gen-0/summary.json',
      run_log: 'k6/runs/r1/gen-0/run.log',
      raw: 'k6/runs/r1/gen-0/raw.json.gz',
      exit_code: 'k6/runs/r1/gen-0/exit_code',
    });
  });

  it('rejects a run_id carrying a shell injection payload rather than embedding it', () => {
    // The historical vulnerability: emitKeys used to build `KEY_X='...'`
    // text that bin/run.sh sourced, so a run_id containing a quote could
    // inject shell commands. artifactKeys' allowlist (src/storage/keys.ts)
    // now rejects this before any key is built at all.
    const injected = JSON.stringify({
      ...JSON.parse(summary),
      run: { run_id: "r1'; touch pwned_marker; echo '", started_at: '2026-08-29T22:00:00.000Z' },
    });
    expect(() => emitKeys(injected, 'k6')).toThrow(/run_id/i);
  });
});

describe('writeKeyFiles', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'index-cli-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes each key to its own file, bare value plus trailing newline', () => {
    const keys = emitKeys(summary, 'k6');
    const outDir = join(dir, 'keys');
    writeKeyFiles(outDir, keys);

    expect(readFileSync(join(outDir, 'index'), 'utf8')).toBe('k6/index/dt=2026-08-29/r1-gen0.json\n');
    expect(readFileSync(join(outDir, 'timeline'), 'utf8')).toBe(
      'k6/timeline/dt=2026-08-29/r1-gen0.jsonl\n',
    );
    expect(readFileSync(join(outDir, 'summary'), 'utf8')).toBe('k6/runs/r1/gen-0/summary.json\n');
    expect(readFileSync(join(outDir, 'run_log'), 'utf8')).toBe('k6/runs/r1/gen-0/run.log\n');
    expect(readFileSync(join(outDir, 'raw'), 'utf8')).toBe('k6/runs/r1/gen-0/raw.json.gz\n');
  });

  it('creates the output directory if it does not exist yet', () => {
    const outDir = join(dir, 'nested', 'keys');
    expect(() => writeKeyFiles(outDir, emitKeys(summary, 'k6'))).not.toThrow();
    expect(readFileSync(join(outDir, 'index'), 'utf8')).toContain('r1-gen0.json');
  });
});

describe('emitTimelineFlag', () => {
  // Spec §9.1 makes emit_timeline a PROFILE flag. It was validated by
  // schema.ts and set by both shipped profiles, and read by nothing: this is
  // the mode bin/run.sh calls to make it mean something. The output is a bare
  // value the wrapper captures with `$(...)`, never shell text it evaluates.

  it("returns '0' for a profile that disables the timeline", () => {
    expect(emitTimelineFlag(JSON.stringify({ name: 'p', emit_timeline: false }))).toBe('0');
  });

  it("returns '1' for a profile that enables it", () => {
    expect(emitTimelineFlag(JSON.stringify({ name: 'p', emit_timeline: true }))).toBe('1');
  });

  it("returns '1' when the flag is absent — spec §9.1's 'on by default'", () => {
    expect(emitTimelineFlag(JSON.stringify({ name: 'p' }))).toBe('1');
  });

  it('throws on a non-boolean flag rather than guessing a value', () => {
    // schema.ts rejects this too; a profile that reached here malformed
    // should be loud, not quietly coerced into truthiness.
    expect(() => emitTimelineFlag(JSON.stringify({ emit_timeline: 'false' }))).toThrow(
      /emit_timeline/,
    );
  });
});

describe('emitKeys — fleet summaries', () => {
  const fleetSummary = JSON.stringify({
    ...JSON.parse(summary),
    generator: { gen_index: null, gen_count: 3 },
    fleet: { generator_count: 3, generators_reported: 3, generators: [], aggregation: {} },
  });

  it('derives fleet keys when the summary carries a fleet block', () => {
    expect(emitKeys(fleetSummary, 'k6')).toEqual({
      index: 'k6/index/dt=2026-08-29/r1-fleet.json',
      timeline: 'k6/timeline/dt=2026-08-29/r1-fleet.jsonl',
      summary: 'k6/runs/r1/fleet/summary.json',
      run_log: 'k6/runs/r1/fleet/run.log',
      raw: 'k6/runs/r1/fleet/raw.json.gz',
      exit_code: 'k6/runs/r1/fleet/exit_code',
    });
  });

  it('lets the caller override gen_index on a FLEET summary, so a generator with no summary can still have its log placed', () => {
    expect(emitKeys(fleetSummary, 'k6', 2).run_log).toBe('k6/runs/r1/gen-2/run.log');
  });

  it('refuses an override on a generator summary, which carries its own identity', () => {
    expect(() => emitKeys(summary, 'k6', 5)).toThrow(/override is only valid .* FLEET summary/i);
  });
});
