import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';

/**
 * Exercises src/timeline/cli.ts AS A PROCESS — the same thing bin/run.sh
 * invokes via $TIMELINE_CLI — rather than importing a function from it.
 *
 * These tests used to import `runCli`, a buffered helper that split the whole
 * raw stream into an array before bucketing. The shipping path has been the
 * streaming readline loop for some time; `runCli` was dead outside this file
 * and has been deleted. Importing it meant this suite tested a shim, and the
 * real entrypoint — stdin plumbing, the TIMELINE_BUCKET_SEC read, the exit
 * status the wrapper branches on — was covered by nothing at all.
 *
 * Spawning keeps it hermetic (no k6, no network), exactly as
 * tests/wrapper/run-sh.test.ts stubs k6 to drive bin/run.sh.
 */

const REPO = resolve(__dirname, '../..');
const TSX = join(REPO, 'node_modules', '.bin', 'tsx');
const CLI = join(REPO, 'src', 'timeline', 'cli.ts');

const sample = (metric: string, time: string, value: number) =>
  JSON.stringify({ type: 'Point', metric, data: { time, value } });

/** Runs the real CLI over `input`, returning its stdout. */
function runCliProcess(input: string, bucket_sec: number) {
  const r = spawnSync(TSX, [CLI], {
    input,
    encoding: 'utf8',
    env: { ...process.env, TIMELINE_BUCKET_SEC: String(bucket_sec) },
  });
  // A non-zero status here means the entrypoint itself broke; surfacing its
  // stderr beats an inscrutable assertion failure on empty stdout.
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
}

describe('src/timeline/cli.ts (streaming entrypoint, spawned as a process)', () => {
  it('emits one flat JSON object per line, Athena-compatible', () => {
    const input = [
      sample('events_sent', '2026-08-29T10:00:00.000Z', 100),
      sample('events_sent', '2026-08-29T10:00:20.000Z', 200),
    ].join('\n');

    const out = runCliProcess(input, 15);
    const lines = out.trim().split('\n');
    expect(lines.length).toBe(2);

    for (const line of lines) {
      expect(line).not.toContain('\n');
      const obj = JSON.parse(line);
      // Athena's JSON SerDe cannot read nested objects here — every value must be scalar or null.
      for (const v of Object.values(obj)) {
        expect(['number', 'string', 'boolean']).toContain(v === null ? 'number' : typeof v);
      }
    }
  });

  it('produces empty output for empty input rather than throwing', () => {
    expect(runCliProcess('', 15).trim()).toBe('');
  });

  it('ends with a trailing newline when it emits anything', () => {
    const out = runCliProcess(sample('events_sent', '2026-08-29T10:00:00.000Z', 1), 15);
    expect(out.endsWith('\n')).toBe(true);
  });

  it('honours the bucket width TIMELINE_BUCKET_SEC gives it', () => {
    const input = [
      sample('events_sent', '2026-08-29T10:00:00.000Z', 1),
      sample('events_sent', '2026-08-29T10:00:20.000Z', 1),
    ].join('\n');
    expect(runCliProcess(input, 15).trim().split('\n').length).toBe(2);
    expect(runCliProcess(input, 60).trim().split('\n').length).toBe(1);
  });
});
