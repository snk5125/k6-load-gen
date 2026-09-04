import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactKeys, indexRecord } from '../storage/keys.ts';
import { mergeDirs } from './cli.ts';

/**
 * fleet-launch: a multi-task fleet in one command.
 *
 *   fleet-launch run   --cluster C --task-definition TD --network-configuration NETCFG
 *                      --overrides FILE --count N [--results-uri s3://...] [--run-id ID]
 *                      [--launch-type FARGATE] [--region R] [--poll-interval 15]
 *                      [--timeout 21600] [--no-merge] [--work-dir DIR]
 *   fleet-launch merge --results-uri s3://bucket/prefix --run-id ID --count N
 *                      [--region R] [--exit-codes 0,99,...] [--work-dir DIR]
 *
 * `run` launches N ECS tasks from one overrides file, injecting GEN_INDEX
 * 0..N-1 and GEN_COUNT=N (and a generated RUN_ID if the file has none),
 * waits for every task to stop, then does what `merge` does: downloads
 * every runs/<run_id>/gen-<i>/ directory from S3, merges them exactly as a
 * single-task fleet would (src/fleet/cli.ts), uploads the fleet artifacts
 * under runs/<run_id>/fleet/ plus the fleet index row, prints the fleet
 * report and exits with fleet.exit_code.
 *
 * Packaging: this ships INSIDE the k6-load-gen image and is run as a local
 * container — `docker run ... <image> fleet-launch run ...` (bin/run.sh
 * dispatches on that first argument) — so an operator needs Docker and AWS
 * credentials, not Node or a checkout. Everything AWS goes through the
 * image's own `aws` CLI with the credentials and region the operator hands
 * the container: this module holds no account, region, cluster or bucket
 * of its own. The task role stays s3:PutObject-only — reading the run
 * prefix happens here, with the operator's credentials.
 */

export interface RunArgs {
  cluster: string;
  taskDefinition: string;
  networkConfiguration: string;
  overridesPath: string;
  count: number;
  launchType: string;
  region?: string;
  resultsUri?: string;
  runId?: string;
  pollInterval: number;
  timeout: number;
  merge: boolean;
  workDir?: string;
}

interface Overrides {
  containerOverrides?: Array<{ name?: string; environment?: Array<{ name: string; value: string }> }>;
  [k: string]: unknown;
}

// ---------------------------------------------------------------- helpers

export function parseS3Uri(uri: string): { bucket: string; prefix: string } {
  const m = /^s3:\/\/([^/]+)\/?(.*)$/.exec(uri);
  if (!m) throw new Error(`RESULTS_URI must be an s3:// URI for a multi-task merge (got ${JSON.stringify(uri)})`);
  return { bucket: m[1], prefix: m[2].replace(/\/+$/, '') };
}

function envOf(o: Overrides): Array<{ name: string; value: string }> {
  return o.containerOverrides?.[0]?.environment ?? [];
}

export function readOverrideVar(o: Overrides, name: string): string | undefined {
  return envOf(o).find((e) => e.name === name)?.value;
}

/** The overrides for generator `i` of `n`: the file's environment minus any
 * GEN_INDEX/GEN_COUNT, plus the injected pair (and RUN_ID when supplied). */
export function injectGenerator(o: Overrides, i: number, n: number, runId?: string): Overrides {
  const co = o.containerOverrides?.[0];
  if (!co) throw new Error('overrides must contain containerOverrides[0] with an environment array');
  const env = (co.environment ?? []).filter((e) => !['GEN_INDEX', 'GEN_COUNT'].includes(e.name) && !(runId && e.name === 'RUN_ID'));
  env.push({ name: 'GEN_INDEX', value: String(i) }, { name: 'GEN_COUNT', value: String(n) });
  if (runId) env.push({ name: 'RUN_ID', value: runId });
  return { ...o, containerOverrides: [{ ...co, environment: env }, ...(o.containerOverrides ?? []).slice(1)] };
}

export function generateRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-');
  const rand = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
  return `fleet-${stamp}-${rand}`;
}

function aws(args: string[], region?: string): string {
  const full = region ? [...args, '--region', region] : args;
  const r = spawnSync('aws', full, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`could not run aws ${args.slice(0, 2).join(' ')}: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`aws ${args.slice(0, 2).join(' ')} failed (exit ${r.status}): ${(r.stderr || r.stdout).trim()}`);
  }
  return r.stdout;
}

const log = (line: string) => process.stderr.write(`fleet-launch: ${line}\n`);

// ---------------------------------------------------------------- launch + wait

interface Launched { genIndex: number; taskArn: string }

function launch(a: RunArgs, overrides: Overrides, runId: string): Launched[] {
  const out: Launched[] = [];
  for (let i = 0; i < a.count; i++) {
    const o = injectGenerator(overrides, i, a.count, readOverrideVar(overrides, 'RUN_ID') === runId ? undefined : runId);
    const res = JSON.parse(
      aws(
        [
          'ecs', 'run-task',
          '--cluster', a.cluster,
          '--task-definition', a.taskDefinition,
          '--launch-type', a.launchType,
          '--network-configuration', a.networkConfiguration,
          '--overrides', JSON.stringify(o),
          '--output', 'json',
        ],
        a.region,
      ),
    ) as { tasks?: Array<{ taskArn: string }>; failures?: Array<{ reason?: string; arn?: string }> };
    const arn = res.tasks?.[0]?.taskArn;
    if (!arn) {
      const why = (res.failures ?? []).map((f) => f.reason ?? 'unknown').join('; ') || 'no task returned';
      throw new Error(`run-task for gen-${i} failed: ${why}${out.length ? ` (already launched: ${out.map((l) => l.taskArn).join(', ')})` : ''}`);
    }
    out.push({ genIndex: i, taskArn: arn });
    log(`launched gen-${i}: ${arn}`);
  }
  return out;
}

interface Stopped { genIndex: number; taskArn: string; exitCode: number | null; stoppedReason: string }

function waitForStop(a: RunArgs, launched: Launched[]): Stopped[] {
  const deadline = Date.now() + a.timeout * 1000;
  for (;;) {
    const res = JSON.parse(
      aws(['ecs', 'describe-tasks', '--cluster', a.cluster, '--tasks', ...launched.map((l) => l.taskArn), '--output', 'json'], a.region),
    ) as { tasks?: Array<{ taskArn: string; lastStatus: string; stoppedReason?: string; containers?: Array<{ exitCode?: number }> }> };
    const tasks = res.tasks ?? [];
    const byArn = new Map(tasks.map((t) => [t.taskArn, t]));
    const pending = launched.filter((l) => byArn.get(l.taskArn)?.lastStatus !== 'STOPPED');
    if (pending.length === 0) {
      return launched.map((l) => {
        const t = byArn.get(l.taskArn)!;
        const code = t.containers?.[0]?.exitCode;
        return { ...l, exitCode: typeof code === 'number' ? code : null, stoppedReason: t.stoppedReason ?? '' };
      });
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${a.timeout}s waiting for ${pending.length} task(s) to stop: ${pending.map((p) => p.taskArn).join(', ')}`);
    }
    log(`${launched.length - pending.length}/${launched.length} stopped; waiting ${a.pollInterval}s`);
    spawnSync('sleep', [String(a.pollInterval)]);
  }
}

// ---------------------------------------------------------------- merge from S3

export interface MergeArgs {
  resultsUri: string;
  runId: string;
  count: number;
  region?: string;
  /** ECS-reported container exit codes by generator index, used when a
   * generator shipped no exit_code file (it never ran). */
  ecsExitCodes?: Array<number | null>;
  workDir?: string;
}

/** Downloads runs/<run_id>/, merges, uploads fleet/*, returns { report, exitCode }. */
export function mergeFromS3(m: MergeArgs): { report: string; exitCode: number } {
  const { bucket, prefix } = parseS3Uri(m.resultsUri);
  const p = prefix ? `${prefix}/` : '';
  const runUri = `s3://${bucket}/${p}runs/${m.runId}/`;
  const work = m.workDir ?? mkdtempSync(join(tmpdir(), 'fleet-launch-'));
  mkdirSync(work, { recursive: true });

  log(`downloading ${runUri}`);
  aws(['s3', 'cp', runUri, work, '--recursive', '--only-show-errors'], m.region);

  const genDirs: string[] = [];
  for (let i = 0; i < m.count; i++) {
    const d = join(work, `gen-${i}`);
    mkdirSync(d, { recursive: true });
    const ecs = m.ecsExitCodes?.[i];
    if (!existsSync(join(d, 'exit_code')) && typeof ecs === 'number') {
      writeFileSync(join(d, 'exit_code'), `${ecs}\n`);
    }
    if (!existsSync(join(d, 'summary.json'))) log(`gen-${i}: no summary.json in S3`);
    genDirs.push(d);
  }

  const fleetDir = join(work, 'fleet');
  const report = mergeDirs(fleetDir, genDirs);
  writeFileSync(join(fleetDir, 'run.log'), report);
  const fleet = JSON.parse(readFileSync(join(fleetDir, 'summary.json'), 'utf8')) as {
    run: { run_id: string; started_at: string };
    fleet: { exit_code: number };
  };
  writeFileSync(join(fleetDir, 'index.json'), JSON.stringify(indexRecord(fleet as unknown as Record<string, unknown>)) + '\n');

  const keys = artifactKeys({ run_id: fleet.run.run_id, gen_index: null, started_at: fleet.run.started_at }, prefix);
  const uploads: Array<[string, string]> = [
    [join(fleetDir, 'summary.json'), keys.summary],
    [join(fleetDir, 'run.log'), keys.run_log],
    [join(fleetDir, 'index.json'), keys.index],
  ];
  if (existsSync(join(fleetDir, 'timeline.jsonl'))) uploads.push([join(fleetDir, 'timeline.jsonl'), keys.timeline]);
  for (const [file, key] of uploads) {
    aws(['s3', 'cp', file, `s3://${bucket}/${key}`, '--only-show-errors'], m.region);
  }
  log(`uploaded ${uploads.length} fleet artifacts under s3://${bucket}/${keys.summary.replace(/summary\.json$/, '')}`);
  if (!m.workDir) rmSync(work, { recursive: true, force: true });
  return { report, exitCode: fleet.fleet.exit_code };
}

// ---------------------------------------------------------------- arg parsing

export function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${JSON.stringify(a)}`);
    const key = a.slice(2);
    if (key === 'no-merge' || key === 'help') {
      out[key] = true;
      continue;
    }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`--${key} needs a value`);
    out[key] = v;
    i++;
  }
  return out;
}

const USAGE = `usage:
  fleet-launch run   --cluster C --task-definition TD --network-configuration NETCFG
                     --overrides FILE --count N [--results-uri s3://...] [--run-id ID]
                     [--launch-type FARGATE] [--region R] [--poll-interval 15]
                     [--timeout 21600] [--no-merge] [--work-dir DIR]
  fleet-launch merge --results-uri s3://bucket/prefix --run-id ID --count N
                     [--region R] [--exit-codes 0,99,...] [--work-dir DIR]
`;

function need(o: Record<string, string | boolean>, k: string): string {
  const v = o[k];
  if (typeof v !== 'string' || v.length === 0) throw new Error(`--${k} is required`);
  return v;
}

function num(o: Record<string, string | boolean>, k: string, d: number): number {
  const v = o[k];
  if (v === undefined) return d;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${k} must be a non-negative number`);
  return n;
}

export function main(argv: string[]): number {
  const [mode, ...rest] = argv;
  if (!mode || mode === '--help' || mode === 'help') {
    process.stdout.write(USAGE);
    return mode ? 0 : 2;
  }
  const o = parseArgs(rest);
  if (o.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  if (mode === 'merge') {
    const count = num(o, 'count', NaN);
    if (!Number.isInteger(count) || count < 1) throw new Error('--count must be an integer >= 1');
    const codes = typeof o['exit-codes'] === 'string'
      ? o['exit-codes'].split(',').map((c) => (c.trim() === '' ? null : Number(c)))
      : undefined;
    const { report, exitCode } = mergeFromS3({
      resultsUri: need(o, 'results-uri'),
      runId: need(o, 'run-id'),
      count,
      region: typeof o.region === 'string' ? o.region : undefined,
      ecsExitCodes: codes,
      workDir: typeof o['work-dir'] === 'string' ? o['work-dir'] : undefined,
    });
    process.stdout.write(report);
    return exitCode;
  }

  if (mode !== 'run') throw new Error(`unknown mode ${JSON.stringify(mode)}\n${USAGE}`);

  const count = num(o, 'count', NaN);
  if (!Number.isInteger(count) || count < 1) throw new Error('--count must be an integer >= 1');
  const overridesPath = need(o, 'overrides').replace(/^file:\/\//, '');
  const overrides = JSON.parse(readFileSync(overridesPath, 'utf8')) as Overrides;
  if (readOverrideVar(overrides, 'GEN_INDEX') !== undefined) {
    throw new Error('the overrides file sets GEN_INDEX; remove it — fleet-launch assigns one per task');
  }
  const a: RunArgs = {
    cluster: need(o, 'cluster'),
    taskDefinition: need(o, 'task-definition'),
    networkConfiguration: need(o, 'network-configuration'),
    overridesPath,
    count,
    launchType: typeof o['launch-type'] === 'string' ? o['launch-type'] : 'FARGATE',
    region: typeof o.region === 'string' ? o.region : undefined,
    resultsUri: typeof o['results-uri'] === 'string' ? o['results-uri'] : readOverrideVar(overrides, 'RESULTS_URI'),
    runId: typeof o['run-id'] === 'string' ? o['run-id'] : readOverrideVar(overrides, 'RUN_ID'),
    pollInterval: num(o, 'poll-interval', 15),
    timeout: num(o, 'timeout', 21600),
    merge: o['no-merge'] !== true,
    workDir: typeof o['work-dir'] === 'string' ? o['work-dir'] : undefined,
  };
  if (a.merge && !a.resultsUri) {
    throw new Error('RESULTS_URI is not in the overrides file; pass --results-uri (or --no-merge to skip the merge)');
  }
  const runId = a.runId ?? generateRunId();
  // Validates the run_id allowlist before anything is launched.
  artifactKeys({ run_id: runId, gen_index: null, started_at: new Date().toISOString() }, '');
  log(`run_id ${runId}, ${count} generators, task definition ${a.taskDefinition}`);

  const launched = launch(a, overrides, runId);
  const stopped = waitForStop(a, launched);
  for (const s of stopped) log(`gen-${s.genIndex} stopped: exit ${s.exitCode ?? '?'}${s.stoppedReason ? ` (${s.stoppedReason})` : ''}`);

  if (!a.merge) {
    process.stdout.write(`${runId}\n`);
    return stopped.every((s) => s.exitCode === 0) ? 0 : 1;
  }
  const { report, exitCode } = mergeFromS3({
    resultsUri: a.resultsUri!,
    runId,
    count,
    region: a.region,
    ecsExitCodes: stopped.map((s) => s.exitCode),
    workDir: a.workDir,
  });
  process.stdout.write(report);
  return exitCode;
}

// Node entrypoint. Guarded so importing this module in a test does not run it.
if (typeof process !== 'undefined' && process.argv[1] && /fleet-launch|fleet[\/\\]launch/.test(process.argv[1])) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    process.stderr.write(`fleet-launch: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
  }
}
