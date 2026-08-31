# aggregator-configs/

Generated Vector and Cribl Stream configs, one pair per log type, driven by the same
`LogTypeDef`s (`src/logtypes/definitions/`) the load generator itself emits from:

```
aggregator-configs/<type>/vector/transform.json
aggregator-configs/<type>/cribl/pipeline.json
```

**This tree is generated. Never hand-edit a file under here.**

```bash
npm run aggregator-configs
```

regenerates every file from `renderVectorTransform`/`renderCriblPipeline` (`src/aggregator/`) and
`LOG_TYPES` (`src/logtypes/registry.ts`). A definition change that is not followed by
regenerating leaves stale configs committed — exactly the drift this tree exists to prevent —
which is why **two** gates catch it: `tests/aggregator/cli.test.ts` (`npm test`, fails locally)
and the `.github/workflows/ci.yml` "Aggregator configs are up to date" step (regenerates and
`git diff --exit-code`s, fails in CI). A committed file that does not match what the renderer
produces today, for the definition as it stands today, is always a bug — either the generator
script wasn't run, or the diff was hand-edited after the fact.

## Verification is asymmetric: Vector automated, Cribl manual

**Do not infer Cribl coverage from a green `npm test` or a green CI run.** Neither exercises a
real Cribl Stream instance — nothing here does.

| Vendor | How it's verified | Automated? |
|---|---|---|
| Vector | `tests/aggregator/roundtrip/` — real generator-produced events pushed through the exact committed `transform.json`'s VRL, via the official `timberio/vector:0.58.0-alpine` image (pinned; see that directory's README), asserting every declared field extracts with the right value | Yes — runs in CI as the separate `vector-roundtrip` job (`.github/workflows/ci.yml`), but **not** part of `npm test` — needs Docker. Run it locally: `tests/aggregator/roundtrip/run.sh` |
| Cribl | Manual procedure below, against a real Cribl Stream instance | **No.** No instance and no license tier are available in this repo's environment. |

`src/aggregator/cribl.ts`'s doc comment says it plainly: the function shapes are "written from
Cribl's documented pipeline/function shapes, not verified against a running Cribl instance... the
exact function conf keys" are "the part most likely to need correction against a real Cribl
Stream deployment." This procedure, performed by a human against a real instance, is the only
thing that can actually catch that class of error — nothing automated here does.

## Manual Cribl check

1. **Get sample events.** Run the Vector round trip (needs Docker) — as a side effect it writes
   20 real generator-produced events per type to `/tmp/rt-<type>.log`, using the same
   `buildGenerator` + family serializer the load generator itself uses:

   ```bash
   tests/aggregator/roundtrip/run.sh
   ```

   (If Docker is unavailable, the sample-generation logic alone can be lifted from
   `tests/aggregator/roundtrip/main.ts`'s `runOneType` — the part that calls `buildGenerator` and
   writes `events.map(e => e.body)` — without the Docker-dependent steps.)

2. **Import the pipeline.** In Cribl Stream: Data > Pipelines > Add Pipeline > Import, and
   upload/paste `aggregator-configs/<type>/cribl/pipeline.json` verbatim — do not retype it.

3. **Feed the sample events through Preview.** Pipelines > `<type>` > Preview tab > paste the
   contents of `/tmp/rt-<type>.log` into Sample Data > Run.

4. **Check every declared field extracts.** Compare the Preview output against
   `src/logtypes/definitions/<type>.ts`'s `fields` list — every field name (or, for `cloudtrail`,
   every dotted path such as `userIdentity.arn`) must appear in the output with the value the
   sample event actually carries. For a field typed `parse.type: 'int'` (e.g. auditd's `uid`,
   nginx's `status`), confirm it comes out as a number, not a string. This is the same
   field-by-field standard `tests/aggregator/roundtrip/` holds Vector to — "the run didn't error"
   is not sufficient.

   `auditd` (the `kv-audit` family) is the highest-risk pipeline to check first: its
   `regex_extract` + `serde` (`kvp`) pairing depends on Cribl's kvp serde defaults (pair
   delimiter, quote character, escape character) implicitly agreeing with `formatKvValue`
   (`src/logtypes/families/kv-audit.ts`) — an agreement asserted nowhere except this manual check.

5. **Check the indexed-fields sink.** `LogTypeField.parse.index` (see
   `src/logtypes/types.ts`) marks which fields should be indexed at the destination — this has no
   Cribl *pipeline*-side representation (no function in `pipeline.json` touches it; see that
   file's doc comment in `src/aggregator/cribl.ts` and `src/logtypes/types.ts`'s `parse` doc
   comment for why). It belongs on the **destination**: attach a Splunk destination to this
   pipeline's route and confirm its Indexed Fields list matches the type's indexed fields below
   (the same set `tests/aggregator/roundtrip/main.ts`'s `indexedFieldPaths` computes for Vector's
   `splunk_hec_logs` sink, from `def.fields.filter(f => f.parse?.index)`):

   | Type | Indexed fields |
   |---|---|
   | `auditd` | `success`, `uid`, `exe`, `key` |
   | `json-app` | `host`, `service`, `level` |
   | `nginx-access` | `remote_addr`, `request_uri`, `status` |
   | `cloudtrail` | `userIdentity.arn`, `eventName`, `awsRegion`, `sourceIPAddress` |

6. **Record the result** in the table below — date, Cribl version, who checked, outcome per type.
   Update it every time this procedure is actually performed; do not leave a stale "last checked"
   date once the pipelines change.

### Verification log

| Date | Cribl version | Checked by | Result |
|---|---|---|---|
| — | — | — | **Not yet performed.** No Cribl instance was available in the environment that built these pipelines (Task 5/6, 2026-08-31) — this row is a placeholder, not a check. `aggregator-configs/*/cribl/pipeline.json` should be treated as **unverified against a real Cribl Stream instance** until someone runs the procedure above and replaces this row. |
