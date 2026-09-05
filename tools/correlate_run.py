#!/usr/bin/env python3
"""
correlate_run.py — line up one k6-load-gen run with what the aggregator saw.

Stdlib only. Two modes:

  scrape   run DURING the test, next to the aggregator (or anywhere that can
           reach its prometheus_exporter): snapshots the metrics endpoint
           every N seconds into a JSONL file.

             correlate_run.py scrape --url http://<aggregator>:9598/metrics \
               --interval 15 --out vector-metrics.jsonl

  report   run AFTER the test: fetches the run's fleet (or single-generator)
           summary and timeline from S3 (or a local directory), joins them
           bucket by bucket with the scraped Vector metrics and, optionally,
           the ECS service's CPU from CloudWatch, and prints a Markdown report
           plus a machine-readable JSON — written to be handed to an LLM.

             correlate_run.py report --results-uri s3://<bucket>[/prefix] \
               --run-id <run_id> --metrics vector-metrics.jsonl \
               [--cw-cluster <vector-cluster> --cw-service <vector-service>] \
               [--source http_json --records json-app --sink Splunk] \
               [--json report.json]

The report answers, per load stage: what the generator offered and delivered,
what the aggregator received (POSTs and records), what it dropped or errored,
how busy each component was, and how much CPU the service used — the inputs
to "where is the knee, and what CPU is it at".

Stages come from the summary's own `schedule` block whenever it has one: the
resolved k6 stages, in seconds and fleet-wide EPS, laid over the run's start
reference (`run.start_at` when the fleet was scheduled with START_AT,
otherwise the generators' own starts). That makes "eps offered" a fact read
from the run's configuration rather than a guess, and it keeps the stage
boundaries right on precisely the run worth analysing — one that FAILED to
deliver what it offered. Only an artifact with no `schedule` (produced before
that field existed) falls back to inferring boundaries from the delivered EPS,
and every such report says so.
"""
import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.request

# ---------------------------------------------------------------- helpers

def iso(ts):
    return dt.datetime.fromtimestamp(ts, dt.timezone.utc).isoformat().replace("+00:00", "Z")


def parse_iso(s):
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def parse_instant(v):
    """An ISO-8601 timestamp OR a bare Unix epoch in seconds -> epoch float,
    or None. Both forms occur: `started_at` is always ISO, while `start_at`
    is START_AT exactly as it was set, and bin/run.sh accepts either."""
    if v is None:
        return None
    t = str(v).strip()
    if not t or t == "unknown":
        return None
    try:
        return float(t)
    except ValueError:
        pass
    try:
        return parse_iso(t)
    except ValueError:
        return None


def aws(*args):
    r = subprocess.run(["aws", *args], capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(f"aws {' '.join(args[:2])} failed: {r.stderr.strip() or r.stdout.strip()}")
    return r.stdout


# ---------------------------------------------------------------- scrape

METRIC_RE = re.compile(r'^(?P<name>[a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(?P<labels>[^}]*)\})?\s+(?P<value>[^\s]+)')
LABEL_RE = re.compile(r'(\w+)="((?:[^"\\]|\\.)*)"')

KEEP = {
    "vector_component_received_events_total": "received",
    "vector_component_sent_events_total": "sent",
    "vector_component_errors_total": "errors",
    "vector_component_discarded_events_total": "discarded",
    "vector_utilization": "utilization",
    "vector_buffer_events": "buffer_events",
    "vector_buffer_byte_size": "buffer_bytes",
    "vector_http_server_handler_duration_seconds_sum": "handler_seconds_sum",
    "vector_http_server_handler_duration_seconds_count": "handler_count",
}


def parse_prom(text):
    """-> {component_id: {host: {field: value}}}, summed over every label but
    component_id and host. `host` is the `host` label when scrapes carry one
    (e.g. multiple Vector instances behind the same component_id); otherwise
    it is "" so single-host deployments behave exactly as before."""
    out = {}
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        m = METRIC_RE.match(line)
        if not m or m.group("name") not in KEEP:
            continue
        labels = dict(LABEL_RE.findall(m.group("labels") or ""))
        comp = labels.get("component_id", "_")
        host = labels.get("host", "")
        try:
            v = float(m.group("value"))
        except ValueError:
            continue
        field = KEEP[m.group("name")]
        out.setdefault(comp, {}).setdefault(host, {})
        out[comp][host][field] = out[comp][host].get(field, 0.0) + v
    return out


def cmd_scrape(a):
    with open(a.out, "a") as f:
        while True:
            t = time.time()
            try:
                with urllib.request.urlopen(a.url, timeout=10) as r:
                    snap = parse_prom(r.read().decode("utf-8", "replace"))
                f.write(json.dumps({"ts": t, "components": snap}) + "\n")
                f.flush()
            except Exception as e:  # keep scraping through a restart
                f.write(json.dumps({"ts": t, "error": str(e)}) + "\n")
                f.flush()
            time.sleep(max(1, a.interval - (time.time() - t)))


# ---------------------------------------------------------------- report

def fetch_run(results_uri, run_id, work):
    """Fleet summary+timeline if present, else gen-0's. Returns (summary, buckets, kind)."""
    if results_uri.startswith("s3://"):
        m = re.match(r"^s3://([^/]+)/?(.*)$", results_uri)
        bucket, prefix = m.group(1), m.group(2).strip("/")
        p = f"{prefix}/" if prefix else ""
        run_dir = f"s3://{bucket}/{p}runs/{run_id}/"
        aws("s3", "cp", run_dir, work, "--recursive", "--only-show-errors")
        for leaf in ("fleet", "gen-0"):
            sp = os.path.join(work, leaf, "summary.json")
            if os.path.exists(sp):
                summary = json.load(open(sp))
                dt_ = summary["run"]["started_at"][:10]
                stem = f"{run_id}-fleet" if leaf == "fleet" else f"{run_id}-gen0"
                tl_local = os.path.join(work, leaf, "timeline.jsonl")
                if not os.path.exists(tl_local):
                    r = subprocess.run(["aws", "s3", "cp", f"s3://{bucket}/{p}timeline/dt={dt_}/{stem}.jsonl", tl_local,
                                        "--only-show-errors"], capture_output=True, text=True)
                buckets = [json.loads(l) for l in open(tl_local)] if os.path.exists(tl_local) else []
                return summary, buckets, leaf
        raise SystemExit(f"no fleet/summary.json or gen-0/summary.json under {run_dir}")
    # local directory: <dir>/fleet/ or <dir>/gen-0/ or the files directly
    for leaf in ("fleet", "gen-0", "."):
        sp = os.path.join(results_uri, leaf, "summary.json")
        if os.path.exists(sp):
            tl = os.path.join(results_uri, leaf, "timeline.jsonl")
            buckets = [json.loads(l) for l in open(tl)] if os.path.exists(tl) else []
            return json.load(open(sp)), buckets, leaf
    raise SystemExit(f"no summary.json found under {results_uri}")


def load_scrapes(path):
    rows = []
    for line in open(path):
        line = line.strip()
        if not line:
            continue
        r = json.loads(line)
        if "components" in r:
            rows.append(r)
    rows.sort(key=lambda r: r["ts"])
    return rows


COUNTERS = ("received", "sent", "errors", "discarded", "handler_count", "handler_seconds_sum")


def select_scrape_window(rows, t0, t1):
    """Scrapes to use for a [t0, t1] stage: every row with a timestamp in the
    closed interval, plus the scrape immediately before t0 as the baseline
    for differencing (rows must be sorted by ts).

    Returns (sequence, within): `sequence` includes the baseline (if any),
    `within` is just the in-window rows — a component_delta with no rows in
    `within` has nothing to report for this stage regardless of comp."""
    within = [r for r in rows if t0 <= r["ts"] <= t1]
    before = [r for r in rows if r["ts"] < t0]
    baseline = before[-1] if before else None
    sequence = ([baseline] if baseline is not None else []) + within
    return sequence, within


def _series_increment(values):
    """values: a series' value at each scrape in chronological order (None
    where the scrape has no data for it, including comp/host absent).

    Endpoint subtraction is wrong whenever a Vector process restarts mid-run
    (a Counter's Prometheus exposition resets to 0/near-0), so instead: sum
    the increment between each consecutive pair of OBSERVATIONS. A decrease
    is a reset — count only the post-reset value itself as that step's
    increment (never negative).

    A scrape where the series is absent is a gap, and it is counted as one,
    but it does NOT discard the increment across it. These counters are
    cumulative: the value at resumption already includes whatever the
    component did while the series was missing, so the rise from the last
    known value to the resumed one is a real, known increment and is
    credited in full. (Treating the resumption as a fresh baseline lost the
    increment both across the gap and out of it: 100, 110, -, 130, 140 came
    to 20 instead of 40.) Only a resumed value BELOW the last known one is
    not a continuation — that is a restart, handled as a reset above.

    Fewer than two observations cannot be differenced at all: one observation
    is a level, not an increment. The increment is then None (unknown), never
    0.0 — publishing a confident zero would claim the component handled
    nothing, which is a different and unsupported statement.

    Returns (increment, reset, gaps, had_data); `increment` is None when
    `had_data` is False, and also when the series was seen exactly once."""
    increment = 0.0
    reset = False
    gaps = 0
    seen = 0
    last = None
    in_gap = False
    for v in values:
        if v is None:
            # One gap per contiguous run of absent scrapes, counted only once
            # the series has actually been seen (leading absences are not gaps).
            if last is not None and not in_gap:
                gaps += 1
                in_gap = True
            continue
        seen += 1
        if last is not None:
            if v < last:
                increment += v
                reset = True
            else:
                increment += v - last
        last = v
        in_gap = False
    if seen == 0:
        return None, reset, gaps, False
    if seen < 2:
        return None, reset, gaps, True
    return increment, reset, gaps, True


def _gauge(host_map, field):
    """Latest-snapshot gauge fields are not differenced. Buffer sizes are
    summed across hosts (a fleet-wide backlog); utilization is a 0..1 share
    per host, so the fleet figure is the busiest host, not a sum."""
    vals = [h[field] for h in host_map.values() if field in h]
    if not vals:
        return None
    return max(vals) if field == "utilization" else sum(vals)


def component_delta(rows, comp, t0, t1):
    """Sum of positive increments for `comp` over [t0, t1] (see
    _series_increment), differenced per (component_id, host) series before
    being summed across hosts so one host's counter reset cannot mask
    another host's real growth. None when no scrape falls in [t0, t1] at
    all; a component simply absent from those scrapes still gets a result
    with None fields (nothing to report, but the window was scraped).

    `window_sec` is the span the increments actually cover (baseline scrape ts
    -> last in-window scrape ts) and is the correct denominator for rates;
    `nominal_sec` is the stage's own length, kept for reporting only."""
    sequence, within = select_scrape_window(rows, t0, t1)
    if not within:
        return None
    hosts = set()
    for r in sequence:
        hosts.update(r.get("components", {}).get(comp, {}).keys())
    if not hosts:
        hosts = {""}
    sums = {f: 0.0 for f in COUNTERS}
    known = {f: False for f in COUNTERS}   # at least one host could be differenced
    seen = {f: False for f in COUNTERS}    # the series appeared at all
    reset = False
    gaps = 0
    lone = False
    for host in hosts:
        for f in COUNTERS:
            values = [r.get("components", {}).get(comp, {}).get(host, {}).get(f) for r in sequence]
            inc, f_reset, f_gaps, had = _series_increment(values)
            if had:
                seen[f] = True
                if inc is None:
                    lone = True          # present, but only one observation
                else:
                    sums[f] += inc
                    known[f] = True
            reset = reset or f_reset
            gaps += f_gaps
    d = {f: (sums[f] if known[f] else None) for f in COUNTERS}
    # Fields that WERE exposed but could not be differenced. The distinction
    # matters downstream: a field that never appeared is a genuine zero (Vector
    # only emits errors/discarded once something has been counted), while one
    # of these is unknown and must print as "-".
    d["unknown"] = sorted(f for f in COUNTERS if seen[f] and not known[f])
    last_components = within[-1].get("components", {}).get(comp, {})
    d["utilization"] = _gauge(last_components, "utilization")
    d["buffer_events"] = _gauge(last_components, "buffer_events")
    d["buffer_bytes"] = _gauge(last_components, "buffer_bytes")
    # The increments above span from the BASELINE scrape (taken before t0) to
    # the last in-window scrape — up to one scrape interval more than the stage
    # itself. Rates must divide by that real span, not by the stage's nominal
    # length, or every per-second figure is inflated by the baseline overhang.
    span = sequence[-1]["ts"] - sequence[0]["ts"]
    d["window_sec"] = span
    d["nominal_sec"] = t1 - t0
    d["window"] = {"from": iso(sequence[0]["ts"]), "to": iso(sequence[-1]["ts"]),
                   "scrapes": len(sequence), "seconds": span}
    d["reset"] = reset
    d["gaps"] = gaps
    d["lone_scrape"] = lone
    return d


def cloudwatch_cpu(cluster, service, t0, t1):
    """AWS/ECS CPUUtilization (% of reserved), 60 s, Average and Maximum."""
    out = json.loads(aws(
        "cloudwatch", "get-metric-statistics", "--namespace", "AWS/ECS", "--metric-name", "CPUUtilization",
        "--dimensions", f"Name=ClusterName,Value={cluster}", f"Name=ServiceName,Value={service}",
        "--statistics", "Average", "Maximum", "--period", "60",
        "--start-time", iso(t0 - 120), "--end-time", iso(t1 + 120), "--output", "json",
    ))
    pts = sorted(out.get("Datapoints", []), key=lambda p: p["Timestamp"])
    return [{"ts": parse_iso(p["Timestamp"]), "avg": p["Average"], "max": p["Maximum"]} for p in pts]


def cpu_in_window(points, t0, t1):
    xs = [p for p in points if t0 - 30 <= p["ts"] <= t1 + 30]
    if not xs:
        return None
    return {"avg": sum(p["avg"] for p in xs) / len(xs), "max": max(p["max"] for p in xs)}


DEFAULT_BUCKET_SEC = 15


def start_reference(summary):
    """Where the intended schedule starts, for THIS artifact.

    The grid is anchored on when the generators ACTUALLY began — the earliest
    of `fleet.generators[].started_at`, or `run.started_at` for a single
    generator. `run.start_at` (the instant every generator was told to start,
    injected as START_AT) is deliberately NOT the origin: bin/run.sh sleeps
    until START_AT and k6 then takes its own time to initialise, and a fleet
    whose tasks only came up after that instant has already missed it. Laying
    the intended grid at START_AT then shifts every boundary by the lateness,
    so every row gets the wrong stage index and the wrong "eps offered" —
    exactly the runs worth analysing are the ones mislabelled.

    `start_at` survives in two roles only:

      * `lateness_sec` = anchor - start_at, reported so a reader can see how
        far the fleet drifted from its schedule;
      * extra uncertainty when start_at is LATER than the observed start. A
        generator cannot begin before the instant it is waiting for, so that
        ordering is impossible and means the two clocks disagree; the
        discrepancy widens the boundary precision.

    Only an artifact with no usable `started_at` at all falls back to
    `start_at` as the origin — a bad grid beats no grid there, and the source
    string says which was used.

    Returns {"epoch", "source", "uncertainty_sec", "lateness_sec"} or None
    when the artifact carries no usable start of either kind.

    `uncertainty_sec` is the observed spread between the first and last
    generator to start (a fleet whose members began seconds apart has no
    single true boundary), widened as above; it is what widens boundary
    marking in assign_buckets.
    """
    run = summary.get("run", {}) or {}
    fleet = summary.get("fleet") or {}
    scheduled = parse_instant(run.get("start_at"))

    starts = [parse_instant(g.get("started_at")) for g in fleet.get("generators", []) or []]
    starts = [x for x in starts if x is not None]
    source = "earliest fleet.generators[].started_at (when the fleet actually began)"
    if not starts:
        one = parse_instant(run.get("started_at"))
        starts = [one] if one is not None else []
        source = "run.started_at (when the generator actually began)"

    if starts:
        anchor = min(starts)
        skew = max(starts) - anchor
        lateness = (anchor - scheduled) if scheduled is not None else None
        # Starting before START_AT is impossible; treat the gap as clock
        # disagreement and let it widen the boundary precision.
        if lateness is not None and lateness < 0:
            skew = max(skew, -lateness)
        return {"epoch": anchor, "source": source, "uncertainty_sec": skew, "lateness_sec": lateness}

    if scheduled is not None:
        return {"epoch": scheduled,
                "source": "run.start_at (the scheduled instant; no actual start was recorded)",
                "uncertainty_sec": 0.0, "lateness_sec": None}
    return None


def schedule_grid(schedule, active_types=None):
    """The intended stage grid from a summary's `schedule` block.

    Stages are PER TYPE (see docs/results-guide.md §3), while a timeline
    bucket is not: it sums every type. So a single grid is only honest when
    the active types' stage boundaries line up. Three cases, in the order they
    are tried:

      one type with stages          -> its stages, as-is;
      several, identical durations  -> one grid, `target_eps_fleet` SUMMED
                                       across the types (that is what the
                                       fleet offered at that instant);
      several, different durations  -> no grid. Returns a note saying so, and
                                       the caller falls back to the delivered-
                                       EPS heuristic rather than reporting
                                       buckets against boundaries that only
                                       one of the types actually ran.

    Returns (stages, note): `stages` is a list of
    {index, offset_start, offset_end, duration_sec, target_eps_fleet,
     target_iterations_per_sec, types}, offsets in seconds from the run's start
    reference; or (None, note) when no grid can be built.
    """
    if not schedule:
        return None, None
    names = sorted(schedule)
    if active_types:
        selected = [n for n in names if n in active_types]
        if selected:
            names = selected
    with_stages = [n for n in names if schedule[n].get("stages")]
    if not with_stages:
        return None, ("the schedule declares no stages (a shared-iterations shape is a fixed unit of work, "
                      "not a rate), so there are no stage boundaries to align to")

    shapes = {n: tuple(round(float(st.get("duration_sec") or 0), 6) for st in schedule[n]["stages"])
              for n in with_stages}
    if len(set(shapes.values())) != 1:
        detail = "; ".join(f"{n}: {len(shapes[n])} stages" for n in with_stages)
        return None, ("stages are PER TYPE and the active types do not share stage boundaries "
                      f"({detail}); a timeline bucket sums every type, so no single stage grid describes it")

    ref = schedule[with_stages[0]]["stages"]
    stages = []
    t = 0.0
    for i, st in enumerate(ref):
        dur = float(st.get("duration_sec") or 0)
        stages.append({
            "index": i,
            "offset_start": t,
            "offset_end": t + dur,
            "duration_sec": dur,
            "target_eps_fleet": sum(float(schedule[n]["stages"][i].get("target_eps_fleet") or 0) for n in with_stages),
            "target_iterations_per_sec": sum(
                float(schedule[n]["stages"][i].get("target_iterations_per_sec") or 0) for n in with_stages),
            "types": list(with_stages),
        })
        t += dur
    note = None
    if len(with_stages) > 1:
        note = ("stages are per type; these types share identical stage boundaries, so 'eps offered' is their SUM ("
                + ", ".join(with_stages) + ")")
    return stages, note


def assign_buckets(buckets, stages, ref_epoch, uncertainty_sec=0.0):
    """Assign each timeline bucket to the intended stage containing its START.

    k6 ramps LINEARLY inside a stage, so a bucket cannot be labelled ramp or
    hold from the schedule — only which stage it belongs to. A bucket whose own
    span crosses a stage boundary is flagged `boundary: True`: it holds two
    different offered rates, so its delivered EPS belongs to neither stage
    cleanly. The crossing test is widened by `uncertainty_sec` (how far apart
    the generators actually started, or how late they were against START_AT),
    because the boundary is only known to that precision.

    A bucket before the first stage or after the last gets `stage: None` and is
    always flagged — it is outside the schedule, not part of any stage.

    Returns a list of {"bucket", "stage", "boundary"} in the input order.
    """
    # Only INTERNAL boundaries (where one stage hands over to the next) plus
    # the schedule's end can split a bucket between two stages. The run's own
    # start is not an edge: nothing precedes stage 0, so a bucket that begins
    # there is not shared with anything, and flagging it would mark the first
    # bucket of every run as boundary whenever uncertainty_sec > 0.
    edges = []
    for st in stages[1:]:
        edges.append(st["offset_start"])
    if stages:
        edges.append(stages[-1]["offset_end"])
    out = []
    for b in buckets:
        start = parse_instant(b.get("bucket_start"))
        if start is None:
            out.append({"bucket": b, "stage": None, "boundary": True})
            continue
        t = start - ref_epoch
        width = float(b.get("bucket_sec") or DEFAULT_BUCKET_SEC)
        end = t + width
        idx = None
        for st in stages:
            if st["offset_start"] <= t < st["offset_end"]:
                idx = st["index"]
                break
        boundary = idx is None or any(t - uncertainty_sec < e < end + uncertainty_sec for e in edges)
        out.append({"bucket": b, "stage": idx, "boundary": boundary})
    return out


def stages_from_schedule(buckets, stages, ref_epoch, uncertainty_sec=0.0):
    """Group the timeline's buckets by the intended stage they fall in.

    Buckets are in time order and the assignment is monotonic in time, so
    grouping consecutive runs of the same stage index yields one group per
    stage, plus a leading/trailing group with `stage: None` for whatever fell
    outside the schedule (a generator that overran, or a timeline that starts
    before the reference).

    Each group carries what the schedule INTENDED for it — `eps_offered`
    (target_eps_fleet) and `intended_seconds` — beside the buckets that will
    supply what was delivered.
    """
    by_index = {st["index"]: st for st in stages}
    groups = []
    for a in assign_buckets(buckets, stages, ref_epoch, uncertainty_sec):
        if not groups or groups[-1]["stage"] != a["stage"]:
            st = by_index.get(a["stage"])
            groups.append({
                "stage": a["stage"],
                "buckets": [],
                "boundary_buckets": 0,
                "eps_offered": st["target_eps_fleet"] if st else None,
                "target_iterations_per_sec": st["target_iterations_per_sec"] if st else None,
                "intended_seconds": st["duration_sec"] if st else None,
            })
        groups[-1]["buckets"].append(a["bucket"])
        if a["boundary"]:
            groups[-1]["boundary_buckets"] += 1
    return groups


def grid_too_fine(stages, buckets):
    """A note when the intended grid is finer than the timeline can resolve,
    else None.

    A timeline bucket is the smallest unit this report has, and every bucket is
    attributed to the single stage containing its START. A stage shorter than
    the bucket width therefore cannot own a bucket of its own: the bucket spans
    it entirely, gets credited whole to whichever neighbour happens to contain
    the bucket's start, and the short stage disappears from the table while its
    traffic is silently added to a stage that never offered it.

    Rather than attribute buckets to stages it cannot separate, the report
    declines the schedule grid altogether and falls back to the labelled
    delivered-EPS heuristic (an inference the reader can see and discount)
    while saying exactly why. The widest bucket in the timeline sets the bar,
    since that is the coarsest resolution any row will have.
    """
    if not stages or not buckets:
        return None
    widths = [float(b.get("bucket_sec") or DEFAULT_BUCKET_SEC) for b in buckets]
    width = max(widths)
    short = [st for st in stages if float(st.get("duration_sec") or 0) < width]
    if not short:
        return None
    detail = ", ".join(f"stage {st['index']} is {st['duration_sec']:g}s" for st in short)
    return (f"the schedule has stages shorter than the {width:g}s timeline bucket ({detail}); a bucket would "
            "span more than one intended stage and be credited whole to a neighbour, deleting the short stage "
            "from the report, so the schedule grid is refused and stage boundaries fall back to the heuristic")


def stages_from_buckets(buckets):
    """Group consecutive buckets whose eps stays within 15% into stages."""
    stages = []
    for b in buckets:
        if stages and stages[-1]["buckets"] and abs(b["eps"] - stages[-1]["ref_eps"]) <= 0.15 * max(stages[-1]["ref_eps"], 1):
            stages[-1]["buckets"].append(b)
        else:
            stages.append({"ref_eps": b["eps"], "buckets": [b]})
    return stages


def summarize_stage(st, rows, comps, cw, batch_size):
    bs = st["buckets"]
    t0 = parse_iso(bs[0]["bucket_start"])
    t1 = parse_iso(bs[-1]["bucket_start"]) + bs[-1]["bucket_sec"]
    dur = t1 - t0
    sent = sum(b["events_sent"] for b in bs)
    attempted = sum(b["events_attempted"] for b in bs)
    p99s = [b["send_duration_p99"] for b in bs if b["send_duration_p99"] is not None]
    fails = sum(b["send_failures"] for b in bs)
    samples = sum(b.get("send_samples", 0) for b in bs)
    out = {
        "start": bs[0]["bucket_start"], "seconds": dur, "buckets": len(bs),
        "generator": {
            "eps_delivered": sent / dur if dur else 0, "events_sent": sent, "events_attempted": attempted,
            "send_p99_ms_max": max(p99s) if p99s else None, "send_p99_ms_median": sorted(p99s)[len(p99s) // 2] if p99s else None,
            "failure_rate": (fails / samples) if samples else 0.0,
            "dropped_iterations": sum(b["dropped_iterations"] for b in bs),
        },
        "aggregator": {},
    }
    quality = []
    for role, comp in comps.items():
        if not comp:
            continue
        d = component_delta(rows, comp, t0, t1)
        if d is None:
            out["aggregator"][role] = {"component": comp, "note": "no scrape covering this stage"}
            continue
        # Vector only emits an errors/discarded counter once something has
        # been counted, so a series that NEVER appeared in the window means
        # zero, not unknown. A series that did appear but could not be
        # differenced (seen exactly once) is unknown and must stay None —
        # zeroing it would claim nothing errored on no evidence.
        def counted(field):
            v = d.get(field)
            if v is not None:
                return v
            return None if field in d.get("unknown", ()) else 0.0

        entry = {"component": comp, "received": d.get("received"), "sent": d.get("sent"),
                 "errors": counted("errors"), "discarded": counted("discarded"),
                 "utilization": d.get("utilization"),
                 "buffer_events": d.get("buffer_events"), "buffer_bytes": d.get("buffer_bytes"),
                 "reset": d["reset"], "gaps": d["gaps"], "lone_scrape": d["lone_scrape"],
                 "window": d["window"], "window_sec": d["window_sec"], "nominal_sec": d["nominal_sec"]}
        # Rates divide by the span the increments actually cover, never by the
        # stage's nominal length (see component_delta).
        if d.get("received") is not None and d["window_sec"]:
            entry["received_per_sec"] = d["received"] / d["window_sec"]
        if d.get("handler_count"):
            entry["http_handler_ms_avg"] = 1000 * d["handler_seconds_sum"] / d["handler_count"]
        out["aggregator"][role] = entry
        if d["reset"] or d["gaps"] or d["lone_scrape"]:
            quality.append({"role": role, "component": comp, "reset": d["reset"],
                            "gaps": d["gaps"], "lone": d["lone_scrape"]})
    out["quality"] = quality
    # per-record vs per-POST sanity: source should see records/batch_size if it counts POSTs
    src, rec = out["aggregator"].get("source"), out["aggregator"].get("records")
    if src and rec and src.get("received") and rec.get("received") is not None and batch_size:
        out["aggregator"]["records_per_source_event"] = rec["received"] / src["received"]
    if cw is not None:
        out["service_cpu_pct"] = cpu_in_window(cw, t0, t1)
    return out


def coverage_note(cov):
    """A fleet's `fleet.timeline_coverage` (None on single-generator runs or
    older artifacts) -> a note when the fleet timeline cannot be trusted for
    stage analysis, else None. `configured_off` means timelines were
    deliberately disabled (no timeline at all), which is not a coverage
    problem — there is simply nothing to analyse."""
    if not cov or cov.get("complete") or cov.get("configured_off"):
        return None
    missing = ", ".join(f"gen-{i}" for i in cov.get("missing", []))
    return (f"timeline coverage INCOMPLETE: {len(cov.get('present', []))}/{cov.get('expected')} generators "
            f"(missing {missing}); the fleet timeline under-counts, so per-stage figures are partial and no knee verdict is given")


def alignment_lines(a):
    """How the stage rows were produced, in words, for the top of the report.

    Always says which of the two it was: an intended grid read from the run's
    own `schedule`, or the delivered-EPS heuristic that predates it. A reader
    must never have to guess whether "stage 3" is a fact or an inference.
    """
    if not a:
        return []
    if a.get("stages_from") == "schedule":
        out = [
            "stage boundaries come from the run's resolved `schedule` (intended stages), laid over the "
            f"actual start {a.get('reference')} from {a.get('reference_source')}; 'eps offered' is that stage's "
            "target_eps_fleet. k6 ramps LINEARLY within a stage, so a bucket carries its stage index, "
            "never a ramp/hold label",
        ]
        unc = a.get("uncertainty_sec") or 0
        out.append(
            f"boundary precision: ±{unc:.1f}s (how far apart the generators actually began, plus any "
            "disagreement with the scheduled instant); the 'sched' column marks a stage's straddling "
            "buckets as '(+Nb)' — those buckets hold two offered rates, so their delivered eps belongs "
            "cleanly to neither stage"
        )
        late = a.get("lateness_sec")
        if late is not None:
            out.append(
                f"the fleet began {late:+.1f}s against its scheduled START_AT ({a.get('start_at')}); the grid "
                "is anchored on the ACTUAL start, so lateness shifts no stage label — it is reported, not applied"
            )
        if a.get("note"):
            out.append(a["note"])
        return out
    if a.get("stages_from") == "heuristic":
        why = a.get("note") or "no schedule was available"
        return [f"stage boundaries inferred from delivered EPS (heuristic, NOT the run's own schedule) — {why}. "
                "'eps offered' is unknown, and a run that failed to keep up will have its stages mislabelled"]
    return []


def knee_verdict(stages):
    """First stage where p99 or failure_rate breaks away from the first two stages."""
    base = [s for s in stages[:2] if s["generator"]["send_p99_ms_median"] is not None]
    if not base:
        return None
    base_p99 = max(s["generator"]["send_p99_ms_median"] for s in base)
    for i, s in enumerate(stages):
        g = s["generator"]
        if g["dropped_iterations"] > 0:
            return {"stage": i, "reason": "generator dropped iterations — the generator's knee, not the target's; the run is void from here"}
        if (g["send_p99_ms_median"] or 0) > 2 * base_p99 or g["failure_rate"] > 0.001:
            return {"stage": i, "eps_delivered": g["eps_delivered"], "reason": "p99 more than doubled vs the first stages, or failures appeared",
                    "service_cpu_pct": s.get("service_cpu_pct")}
    return {"stage": None, "reason": "no knee inside the swept range: p99 stayed within 2x of the first stages and failures stayed under 0.1%"}


def cmd_report(a):
    work = tempfile.mkdtemp(prefix="correlate-")
    summary, buckets, kind = fetch_run(a.results_uri, a.run_id, work)
    rows = load_scrapes(a.metrics) if a.metrics else []
    comps = {"source": a.source, "records": a.records, "sink": a.sink}
    cfg = summary.get("resolved_config", {}) or {}
    types = cfg.get("types", {}) or {}
    batch_size = None
    if len(types) == 1:
        batch_size = list(types.values())[0].get("batch_size")
    t0 = parse_iso(summary["run"]["started_at"]) if summary["run"].get("started_at", "unknown") != "unknown" else None
    t1 = parse_iso(summary["run"]["ended_at"])
    cw = cloudwatch_cpu(a.cw_cluster, a.cw_service, t0 or t1 - 3600, t1) if a.cw_cluster and a.cw_service else None

    # Stage boundaries: from the run's own schedule when it published one,
    # else inferred from the delivered EPS (the pre-`schedule` heuristic, which
    # mislabels exactly the runs that failed to keep up).
    ref = start_reference(summary)
    grid, grid_note = schedule_grid(summary.get("schedule"), summary["run"].get("active_types"))
    too_fine = grid_too_fine(grid, buckets) if (buckets and grid) else None
    if buckets and grid and ref and not too_fine:
        groups = stages_from_schedule(buckets, grid, ref["epoch"], ref["uncertainty_sec"])
        stages_from = "schedule"
    elif buckets:
        groups = stages_from_buckets(buckets)
        stages_from = "heuristic"
        if too_fine:
            grid_note = too_fine
        elif grid and not ref:
            grid_note = "the artifact carries a schedule but no usable start time to lay it over"
        elif not summary.get("schedule"):
            grid_note = "this artifact predates the `schedule` field"
    else:
        groups = []
        stages_from = "none"

    stages = []
    for g in groups:
        st = summarize_stage(g, rows, comps, cw, batch_size)
        st["stage"] = g.get("stage")
        st["eps_offered"] = g.get("eps_offered")
        st["target_iterations_per_sec"] = g.get("target_iterations_per_sec")
        st["intended_seconds"] = g.get("intended_seconds")
        st["boundary_buckets"] = g.get("boundary_buckets")
        stages.append(st)

    alignment = {
        "stages_from": stages_from,
        "reference": iso(ref["epoch"]) if ref else None,
        "reference_source": ref["source"] if ref else None,
        "uncertainty_sec": ref["uncertainty_sec"] if ref else None,
        "lateness_sec": ref.get("lateness_sec") if ref else None,
        "note": grid_note,
        "start_at": summary["run"].get("start_at"),
        "start_skew_sec": (summary.get("fleet") or {}).get("start_skew_sec"),
    }
    fleet = summary.get("fleet")
    report = {
        "run": {"run_id": summary["run"]["run_id"], "started_at": summary["run"].get("started_at"), "ended_at": summary["run"]["ended_at"],
                "duration_sec": summary["run"].get("duration_sec"), "artifact": kind,
                "generators": (fleet or {}).get("generator_count", 1), "generators_reported": (fleet or {}).get("generators_reported"),
                "exit_code": (fleet or {}).get("exit_code")},
        "config": {"profile": cfg.get("name"), "transport": (cfg.get("target") or {}).get("transport"),
                   "types": {k: {"scenario": v.get("scenario"), "batch_size": v.get("batch_size"), "anchor": v.get("anchor")} for k, v in types.items()},
                   "active_types": summary["run"].get("active_types")},
        "validity": summary["validity"],
        "thresholds_failed": [t for t in summary["thresholds"]["slo"] if not t["ok"]],
        "rate": summary["rate"],
        "totals": {"events_attempted": summary["metrics"].get("events_attempted", {}).get("count"),
                   "events_sent": summary["metrics"].get("events_sent", {}).get("count"),
                   "send_failure_rate": summary["metrics"].get("send_failures", {}).get("rate"),
                   "send_duration_ms": summary["metrics"].get("send_duration")},
        "warnings": summary.get("warnings", []),
        "stages": stages,
        "knee": knee_verdict(stages) if stages else None,
        "alignment": alignment,
        "timeline_coverage": (fleet or {}).get("timeline_coverage"),
        "scrapes": {"file": a.metrics, "count": len(rows), "first": iso(rows[0]["ts"]) if rows else None, "last": iso(rows[-1]["ts"]) if rows else None},
        "cloudwatch": {"cluster": a.cw_cluster, "service": a.cw_service, "points": len(cw) if cw else 0},
    }
    note = coverage_note(report["timeline_coverage"])
    if note:
        report["knee"] = {"stage": None, "reason": note}
    if a.json:
        json.dump(report, open(a.json, "w"), indent=2)
    print(render(report))


def fmt(v, d=1):
    if v is None:
        return "-"
    if isinstance(v, float):
        return f"{v:.{d}f}"
    return str(v)


def render(r):
    L = []
    L.append(f"# Run {r['run']['run_id']} — correlation report")
    L.append("")
    L.append("Read this with docs/results-guide.md. Rules that apply first: if validity.valid is false the run is void; "
             "eps and counts are per stage; aggregator counts are the sum of positive increments across the scrapes covering "
             "the stage (a Vector restart mid-run is a counter reset, handled without going negative — see quality notes below "
             "any stage where one was detected, or where a series briefly vanished from a scrape); service CPU is the AWS/ECS "
             "CPUUtilization of the aggregator service (% of reserved), average and maximum over the stage; "
             "'records_per_source_event' should equal batch_size when the source counts POSTs and the records "
             "component counts log records — 1.0 means the source already emits one event per record.")
    L.append("")
    v = r["validity"]
    L.append(f"- validity: {'VALID' if v['valid'] else 'INVALID'}; dropped_iterations={v['dropped_iterations']}; reasons={v['reasons']}")
    L.append(f"- profile {r['config']['profile']} over {r['config']['transport']}; types {json.dumps(r['config']['types'])}")
    L.append(f"- generators {r['run']['generators']} (reported {r['run']['generators_reported']}); fleet exit_code {r['run']['exit_code']}; artifact read: {r['run']['artifact']}")
    L.append(f"- rate requested/achievable (fleet-wide, peak stage): {r['rate']['requested_eps']} / {r['rate']['achieved_eps']} eps; totals sent {r['totals']['events_sent']} of {r['totals']['events_attempted']}")
    L.append(f"- thresholds failed: {[t['metric'] + ' ' + t['expression'] for t in r['thresholds_failed']] or 'none'}")
    if r["warnings"]:
        L.append(f"- warnings: {r['warnings']}")
    note = coverage_note(r.get("timeline_coverage"))
    if note:
        L.append(f"- {note}")
    L.append(f"- scrapes: {r['scrapes']['count']} from {r['scrapes']['first']} to {r['scrapes']['last']}; cloudwatch points: {r['cloudwatch']['points']}")
    for line in alignment_lines(r.get("alignment")):
        L.append(f"- {line}")
    L.append("")
    if r["stages"]:
        L.append("| stage | sched | eps offered | start (UTC) | s | eps delivered | p99 ms (med/max) | fail rate | dropped | src recv | src/s | records recv | rec errors | rec util | sink sent | buf events | cpu avg/max % |")
        L.append("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
        for i, s in enumerate(r["stages"]):
            g, ag = s["generator"], s["aggregator"]
            src, rec, sink = ag.get("source", {}), ag.get("records", {}), ag.get("sink", {})
            cpu = s.get("service_cpu_pct") or {}
            sched = "-" if s.get("stage") is None else str(s["stage"])
            if s.get("boundary_buckets"):
                sched += f" (+{s['boundary_buckets']}b)"
            L.append("| {} | {} | {} | {} | {} | {} | {}/{} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {}/{} |".format(
                i, sched, fmt(s.get("eps_offered"), 0), s["start"][11:19], fmt(s["seconds"], 0), fmt(g["eps_delivered"], 0),
                fmt(g["send_p99_ms_median"]), fmt(g["send_p99_ms_max"]),
                fmt(g["failure_rate"], 4), g["dropped_iterations"], fmt(src.get("received"), 0), fmt(src.get("received_per_sec"), 0),
                fmt(rec.get("received"), 0), fmt(rec.get("errors"), 0), fmt(rec.get("utilization"), 2), fmt(sink.get("sent"), 0),
                fmt(sink.get("buffer_events"), 0), fmt(cpu.get("avg")), fmt(cpu.get("max"))))
        L.append("")
        quality_lines = []
        for i, s in enumerate(r["stages"]):
            notes = []
            for item in s.get("quality", []):
                bits = []
                if item["reset"]:
                    bits.append("counter reset (non-negative delta used)")
                if item["gaps"]:
                    bits.append(f"{item['gaps']} gap(s) in the series (counter cumulative, so the rise across "
                                "the gap is still credited)")
                if item.get("lone"):
                    bits.append("one scrape in window: counters unknown")
                notes.append(f"{item['role']} ({item['component']}): " + ", ".join(bits))
            if notes:
                quality_lines.append(f"- stage {i} quality: " + "; ".join(notes))
        if quality_lines:
            L.extend(quality_lines)
            L.append("")
        k = r["knee"]
        if k:
            L.append(f"- knee: stage {k['stage']} — {k['reason']}" + (f"; eps {fmt(k.get('eps_delivered'), 0)}; service cpu {k.get('service_cpu_pct')}" if k.get("stage") is not None else ""))
    else:
        L.append("- no timeline for this run (EMIT_TIMELINE=0 or profile emit_timeline false): stage analysis unavailable; totals above only")
    L.append("")
    L.append("Interpretation prompts: (1) Is the run valid? (2) Does 'records recv' equal 'eps delivered' x seconds, i.e. did the "
             "aggregator see every record? (3) At which stage does p99 or fail rate break away, and what were rec util and cpu there? "
             "(4) If cpu at the knee is well under the alarm threshold, a single component saturated first: use a composite trigger.")
    return "\n".join(L)


# ---------------------------------------------------------------- main

def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="mode", required=True)
    s = sub.add_parser("scrape", help="snapshot a Vector prometheus_exporter every N seconds")
    s.add_argument("--url", required=True)
    s.add_argument("--interval", type=float, default=15)
    s.add_argument("--out", required=True)
    s.set_defaults(fn=cmd_scrape)
    r = sub.add_parser("report", help="join a run's artifacts with scraped metrics (and CloudWatch CPU)")
    r.add_argument("--results-uri", required=True, help="s3://bucket[/prefix] or a local directory holding fleet/ or gen-0/")
    r.add_argument("--run-id", required=True)
    r.add_argument("--metrics", help="JSONL from `scrape`")
    r.add_argument("--source", default="http_json", help="Vector component id that receives the POSTs")
    r.add_argument("--records", default="json-app", help="component id that sees one event per log record (a parse transform)")
    r.add_argument("--sink", default="Splunk", help="sink component id")
    r.add_argument("--cw-cluster", help="ECS cluster of the AGGREGATOR service, for CPU")
    r.add_argument("--cw-service", help="ECS service name of the aggregator")
    r.add_argument("--json", help="also write the machine-readable report here")
    r.set_defaults(fn=cmd_report)
    a = p.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
