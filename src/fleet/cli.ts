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
  const fleet = mergeSummaries(read.map((r) => r.input), genDirs.length);
  const timelines = read.map((r) => r.timeline).filter((t): t is TimelineBucket[] => t !== null);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(fleet, null, 2), 'utf8');
  if (timelines.length > 0) {
    const merged = mergeBuckets(timelines);
    writeFileSync(join(outDir, 'timeline.jsonl'), merged.map((b) => JSON.stringify(b)).join('\n') + '\n', 'utf8');
  }
  return renderFleetSummary(fleet);
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
