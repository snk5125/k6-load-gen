# Containerised Vector round trip

Proves a **committed** `aggregator-configs/<type>/vector/transform.json` actually parses the
bytes the real generator + real family serializer emit — field by field, not "the run
succeeded". Everything else in this sub-project proves the renderers produce *something*; this
is the step that proves what they produce is correct.

## Run it

```bash
tests/aggregator/roundtrip/run.sh
```

or directly:

```bash
npx tsx tests/aggregator/roundtrip/main.ts
```

**Requires Docker, running locally, with network access to pull `timberio/vector:0.58.0-alpine`
the first time** (already pulled in this environment). Exits non-zero if any type fails.

The image is pinned to a concrete tag, not the floating `latest-alpine` — "verified live" names
no artifact when the tag it ran against can silently become a different image tomorrow (see
`VECTOR_IMAGE` in `main.ts`). Every run prints the resolved version it actually ran against
(`docker run --rm <image> --version`) as the first output line, the same way
`aggregator-configs/README.md`'s manual Cribl check records a Cribl version per entry in its
Verification log — this harness's analogue is one version line per run rather than a persistent
table, since every run uses the same pinned image.

## This is NOT part of `npm test` — but it is part of CI

`npm test` needs no Docker, no network, and no container runtime — that is deliberate (see the
main README's Development section). This harness needs all three, so it stays out of `npm test`.
**A green `npm test` run says nothing about whether the rendered Vector configs actually parse
generated events** — that's what this harness is for.

It **is** wired into CI: `.github/workflows/ci.yml`'s `vector-roundtrip` job runs it on every
push and PR, on GitHub-hosted runners (which carry Docker preinstalled — no separate Docker setup
step needed). It's a separate job from `verify`, deliberately: a Docker or image-pull problem is
a different failure class than a code or test problem, and this way a failure here doesn't slow
down or get lost inside `verify`'s faster feedback path. Run it locally the same way CI does:
`tests/aggregator/roundtrip/run.sh`.

## What it does, per type

1. Builds a real `BatchGenerator` from the type's own `LogTypeDef` (`buildGenerator` +
   `FAMILIES[def.family].serialize`, `batch_size: 20`) and writes 20 real serialized events to
   `/tmp/rt-<type>.log` — the same generator and serializer the load generator itself uses, not
   hand-written sample lines.
2. Runs `docker run ... validate --no-environment /cfg/<type>/vector/transform.json` against the
   **committed** transform fragment exactly as shipped. Vector rejects it — but only for missing
   `sources`/`sinks` ("No sources defined in the config." / "No sinks defined in the config."),
   never a JSON parse error. That distinction is the actual proof for Task 2's JSON-instead-of-
   YAML deviation: Vector reads far enough into the file to raise topology diagnostics, which
   means it accepted the file as a valid config format.
3. **Wraps the transform at harness time** — a `file` source plus a `splunk_hec_logs` sink — and
   validates that full pipeline. The renderer itself stays a transform-only fragment (see
   `src/aggregator/vector.ts`'s doc comment: "the CLI/deployment step that stitches this
   transform into a full Vector pipeline owns the actual source and sink"); no such deployment
   stitcher exists in this repo, so the wrapping happens here instead of changing what
   `renderVectorTransform`/the CLI emit. The committed tree keeps its "transform only" contract
   and the CI drift gate has nothing new to catch.
4. **The sink is a `splunk_hec_logs` sink with `indexed_fields` set from
   `def.fields.filter(f => f.parse?.index)`**, not a bare `console` sink — `LogTypeField.parse`
   has two halves (`type`, `index`) and only `type` has a renderer-side consumer (the VRL
   coercions). `index` has no home in a transform stage at all — neither vendor exposes per-field
   indexing there — so it drives the sink instead. This validate-only config exercises that shape
   with a real (if synthetic and unreachable) endpoint; `vector validate` never connects out, so
   the endpoint being fake is fine.
5. Extracts the **exact same VRL source string** the committed `transform.json` carries (never a
   paraphrase) and runs it through `vector vrl -i <ndjson> -p <program.vrl> -o` — one-shot,
   applies the program to each NDJSON line, prints the resulting event per line. This is the
   actual field-extraction proof, and it deliberately avoids a long-running `vector run` process
   reading a tailed file source: that has no reliable EOF-triggered exit, which risks exactly the
   kind of hang the main README's `syslog` transport section already warns about for a different
   component. `vrl -i` is deterministic, foreground, and bounded.
6. Compares every field `def.fields` declares against the value the generator actually produced
   for that event, coercion-aware (`parse.type: 'int'` compares against `Number(raw)`; everything
   else compares the raw string). A field only counts as "extracted" if it matches for **every**
   one of the 20 events. Anything less is printed as a `FIELD MISMATCH` line and fails that type.

## What this does NOT prove

- **Cribl.** No Cribl instance is available here, and no license tier permits scripting one in
  CI. `aggregator-configs/README.md` documents the manual Cribl check; a green run of this
  harness says nothing about whether `pipeline.json` is correct. See the main README's
  **Aggregator configs** section for the asymmetry stated plainly.
- **Real delivery.** The `splunk_hec_logs` sink here is validate-only, pointed at a synthetic,
  unreachable endpoint (`http://splunk.invalid.example:8088`) — this proves the sink's shape is
  valid Vector config, not that indexed fields actually reach a real Splunk/HEC receiver.
- **Every possible input.** 20 generated events per type, not exhaustive fuzzing of the field
  generators' cardinality/distribution space.

## If it hangs

Every docker invocation here (`validate`, `vrl -i`) is one-shot and bounded by a 60s timeout in
`main.ts` (`spawnSync(..., { timeout: 60_000 })`); none of them start a long-running Vector
process. If a run still hangs, `Ctrl-C` it and treat that as a finding to report, not something to
retry in a loop — see the main README's note on the `k6/x/tcp` socket hang for the class of bug
this project has already hit once from a component that does not exit reliably.
