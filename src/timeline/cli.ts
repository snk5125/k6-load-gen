import { createBucketer } from './bucket.ts';
import { createInterface } from 'node:readline';

// Node entrypoint. Guarded so importing this module in a test does not read stdin.
//
// This streaming loop is the WHOLE module: there is no exported function that
// does the same job in memory. There used to be (`runCli`, which split the
// entire raw stream into an array before bucketing it), and it survived only
// because tests imported it — so tests/timeline/cli.test.ts was exercising a
// shim while the shipping path, the one bin/run.sh actually invokes, was
// covered by nothing. Raw k6 output is 10s of MB to GB (spec §9.1), which is
// exactly why the buffered version was replaced. The tests now spawn this
// file as a process, the way tests/wrapper/run-sh.test.ts drives bin/run.sh.
//
// Newline-delimited JSON, one flat bucket per line. Athena's SerDe requires
// exactly that.
if (typeof process !== 'undefined' && process.argv[1] && process.argv[1].includes('cli')) {
  const bucketSec = Number(process.env.TIMELINE_BUCKET_SEC ?? '15');

  // Validate bucket width: must be positive and finite
  if (!Number.isFinite(bucketSec) || bucketSec <= 0) {
    process.stderr.write(`Error: TIMELINE_BUCKET_SEC must be a positive number, got: ${process.env.TIMELINE_BUCKET_SEC ?? bucketSec}\n`);
    process.exit(1);
  }

  const bucketer = createBucketer(bucketSec);
  const rl = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  rl.on('line', (line) => {
    bucketer.add(line);
  });

  rl.on('close', () => {
    const buckets = bucketer.finish();
    for (const b of buckets) {
      process.stdout.write(JSON.stringify(b) + '\n');
    }
  });
}
