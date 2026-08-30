import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { artifactKeys, indexRecord } from './keys.ts';

export function emitIndex(summaryJson: string): string {
  return JSON.stringify(indexRecord(JSON.parse(summaryJson))) + '\n';
}

/**
 * The run's S3 keys, as a plain object — never as shell-evaluable text.
 *
 * An earlier version of this function returned `KEY_X='...'` assignment
 * lines for the wrapper to `eval`/`source`. That embedded run_id (which
 * reaches this CLI via the RUN_ID environment variable) inside shell
 * syntax: a run_id containing a single quote could inject arbitrary shell
 * commands into the one process holding the ECS task's S3-write
 * credentials. artifactKeys' allowlist now rejects such a run_id outright,
 * but this function no longer generates shell text at all, as a second,
 * independent layer — see writeKeyFiles below for how the CLI hands these
 * values to bin/run.sh without ever building executable text from them.
 */
export function emitKeys(summaryJson: string, prefix: string): Record<string, string> {
  const s = JSON.parse(summaryJson) as Record<string, unknown>;
  const run = (s.run ?? {}) as Record<string, unknown>;
  const gen = (s.generator ?? {}) as Record<string, unknown>;

  const keys = artifactKeys(
    {
      run_id: String(run.run_id),
      gen_index: typeof gen.gen_index === 'number' ? gen.gen_index : 0,
      started_at: String(run.started_at),
    },
    prefix,
  );

  return {
    index: keys.index,
    timeline: keys.timeline,
    summary: keys.summary,
    run_log: keys.run_log,
    raw: keys.raw,
  };
}

/**
 * Writes each key to its own file under `dir` (one bare value + trailing
 * newline per file, named `index`, `timeline`, `summary`, `run_log`,
 * `raw`). bin/run.sh reads each back with `KEY_X=$(cat "$dir/x")` —
 * command substitution of a file's CONTENT, which is never interpreted as
 * shell syntax, unlike `eval`/`source` of generated text.
 */
export function writeKeyFiles(dir: string, keys: Record<string, string>): void {
  mkdirSync(dir, { recursive: true });
  for (const [name, value] of Object.entries(keys)) {
    writeFileSync(join(dir, name), value + '\n', 'utf8');
  }
}

/**
 * The wrapper's `--out json` decision, as read from a profile's own
 * `emit_timeline` flag: `'1'` or `'0'`.
 *
 * Spec §9.1 makes `emit_timeline` a PROFILE flag, but bin/run.sh could only
 * read the `EMIT_TIMELINE` environment variable, so the flag validated by
 * src/config/schema.ts and set by both shipped profiles was inert — a
 * validated-but-ignored knob, exactly the defect class §2.2 exists to
 * eliminate. The wrapper now calls this mode when EMIT_TIMELINE is unset.
 *
 * An absent flag resolves to `'1'` (spec §9.1: "on by default"). A present
 * but non-boolean flag throws rather than guessing — schema.ts rejects it
 * too, and a profile that reached here malformed should be loud.
 *
 * Like `writeKeyFiles`, the output is a BARE VALUE the wrapper captures with
 * command substitution. It is never shell syntax and must never become any:
 * see the injection note on emitKeys.
 */
export function emitTimelineFlag(profileJson: string): string {
  const profile = JSON.parse(profileJson) as Record<string, unknown>;
  const flag = profile.emit_timeline;
  if (flag === undefined) return '1';
  if (typeof flag !== 'boolean') {
    throw new Error(`emit_timeline must be a boolean, got ${JSON.stringify(flag)}`);
  }
  return flag ? '1' : '0';
}

// Node entrypoint. Guarded so importing this module in a test does not read
// stdin.
//   index-cli.ts index < summary.json                      -> flat JSON line on stdout
//   index-cli.ts keys <prefix> <output-dir> < summary.json -> writes key files
//   index-cli.ts emit-timeline <profile.json>              -> prints 1 or 0
if (typeof process !== 'undefined' && process.argv[1] && process.argv[1].includes('index-cli')) {
  const mode = process.argv[2];

  const fail = (e: unknown): never => {
    process.stderr.write(`index-cli: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  };

  if (mode === 'emit-timeline') {
    // emit-timeline reads a FILE, not stdin: the wrapper calls it BEFORE k6
    // has run, when there is no summary to pipe in and nothing would ever
    // arrive on stdin. Handled ahead of the stdin plumbing so it cannot hang.
    try {
      const profilePath = process.argv[3];
      if (!profilePath) {
        throw new Error('emit-timeline mode requires a profile path argument');
      }
      process.stdout.write(emitTimelineFlag(readFileSync(profilePath, 'utf8')) + '\n');
    } catch (e) {
      fail(e);
    }
  } else {
    const prefix = process.argv[3] ?? '';
    const outDir = process.argv[4];
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      raw += c;
    });
    process.stdin.on('end', () => {
      try {
        if (mode === 'keys') {
          if (!outDir) {
            throw new Error('keys mode requires an output directory argument');
          }
          writeKeyFiles(outDir, emitKeys(raw, prefix));
        } else {
          process.stdout.write(emitIndex(raw));
        }
      } catch (e) {
        fail(e);
      }
    });
  }
}
