import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { mergeSummaries, type GeneratorInput } from './merge.ts';
import { mergeBuckets } from './timeline-merge.ts';
import { renderFleetSummary } from './render.ts';
import type { RunSummary } from '../summary/build.ts';
import type { TimelineBucket } from '../timeline/types.ts';

/**
 * Reads one generator directory as bin/run.sh lays it out in fleet mode:
 *   <dir>/summary.json   written by k6's handleSummary (absent on a crash)
 *   <dir>/exit_code      the k6 process's exit status, written by the wrapper
 *   <dir>/timeline.jsonl produced by timeline-cli (absent when EMIT_TIMELINE=0)
 * The generator index comes from the directory NAME (`gen-<i>`), not from
 * the summary — a generator that produced no summary still has an index.
 */
export function readGeneratorDir(dir: string): { input: GeneratorInput; timeline: TimelineBucket[] | null } {
  const m = /^gen-(\d+)$/.exec(basename(dir));
  if (!m) throw new Error(`generator directory must be named gen-<index>, got ${JSON.stringify(dir)}`);
  const gen_index = Number(m[1]);

  const summaryPath = join(dir, 'summary.json');
  const summary = existsSync(summaryPath)
    ? (JSON.parse(readFileSync(summaryPath, 'utf8')) as RunSummary)
    : null;

  const exitPath = join(dir, 'exit_code');
  let exit_code: number | null = null;
  if (existsSync(exitPath)) {
    const n = Number(readFileSync(exitPath, 'utf8').trim());
    exit_code = Number.isInteger(n) ? n : null;
  }

  const timelinePath = join(dir, 'timeline.jsonl');
  const timeline = existsSync(timelinePath)
    ? readFileSync(timelinePath, 'utf8')
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as TimelineBucket)
    : null;

  return { input: { gen_index, exit_code, summary }, timeline };
}

/** Merges the generator directories into `outDir` and returns the rendered report. */
export function mergeDirs(outDir: string, genDirs: string[]): string {
  const read = genDirs.map(readGeneratorDir);
  const timelines = read.map((r) => r.timeline).filter((t): t is TimelineBucket[] => t !== null);
  // Every merge step runs BEFORE anything touches disk: bin/run.sh ships
  // fleet/summary.json on file existence, so a summary written ahead of a
  // timeline merge that then throws would be shipped as authoritative while
  // the console said the merge failed.
  const merged = timelines.length > 0 ? mergeBuckets(timelines) : null;
  // Which generators had a timeline, and how much of the run the merged one
  // holds, are facts only this side knows — the summaries never mention them.
  // Both fleet paths (bin/run.sh's single task and fleet-launch's S3 merge)
  // arrive here, so the coverage block is filled in exactly once.
  const present: Record<number, boolean> = {};
  for (const r of read) present[r.input.gen_index] = r.timeline !== null;
  const mergedEventsSent = merged === null ? null : merged.reduce((a, b) => a + b.events_sent, 0);
  // The bucket width the merge judges `fleet.start_skew_sec` against — read
  // from the timeline that actually exists rather than assumed, since
  // TIMELINE_BUCKET_SEC is configurable per run.
  const bucketSec = merged && merged.length > 0 ? merged[0].bucket_sec : null;
  const fleet = mergeSummaries(read.map((r) => r.input), genDirs.length, present, mergedEventsSent, bucketSec);
  const report = renderFleetSummary(fleet);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(fleet, null, 2), 'utf8');
  if (merged !== null) {
    writeFileSync(join(outDir, 'timeline.jsonl'), merged.map((b) => JSON.stringify(b)).join('\n') + '\n', 'utf8');
  }
  return report;
}

// Node entrypoint. Guarded so importing this module in a test does not run it.
//   fleet-cli merge <out-dir> <gen-dir>...   -> writes <out-dir>/summary.json
//                                              (+ timeline.jsonl), prints the
//                                              fleet report on stdout
if (typeof process !== 'undefined' && process.argv[1] && /fleet[-/]cli/.test(process.argv[1])) {
  const [mode, outDir, ...genDirs] = process.argv.slice(2);
  if (mode !== 'merge' || !outDir || genDirs.length === 0) {
    process.stderr.write('usage: fleet-cli merge <out-dir> <gen-dir>...\n');
    process.exit(2);
  }
  try {
    process.stdout.write(mergeDirs(outDir, genDirs));
  } catch (e) {
    process.stderr.write(`fleet-cli: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}
