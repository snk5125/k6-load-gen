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
    (a Counter's Prometheus exposition resets to 0/near-0) or a component is
    briefly absent from a scrape — both make the "delta" go negative or
    overcount. Instead: sum the positive increment between each
    consecutive pair of scrapes that both have the series. A decrease is a
    reset — count only the post-reset value itself as that step's increment
    (never negative). A scrape where the series disappeared after being
    present contributes an unknown (not zero) increment for that step: it is
    counted as a gap, and resumption afterward starts a fresh baseline with
    no retroactive credit for whatever happened during the gap.

    Returns (increment, reset, gaps, had_data)."""
    increment = 0.0
    reset = False
    gaps = 0
    had_data = False
    last = None
    for v in values:
        if v is None:
            if last is not None:
                gaps += 1
            last = None
            continue
        had_data = True
        if last is not None:
            if v < last:
                increment += v
                reset = True
            else:
                increment += v - last
        last = v
    return increment, reset, gaps, had_data


def _sum_gauge(host_map, field):
    """Latest-snapshot gauge fields (utilization, buffer sizes) are not
    differenced — just summed across hosts, as parse_prom used to sum them
    across all labels before host-keying existed."""
    vals = [h[field] for h in host_map.values() if field in h]
    return sum(vals) if vals else None


def component_delta(rows, comp, t0, t1):
    """Sum of positive increments for `comp` over [t0, t1] (see
    _series_increment), differenced per (component_id, host) series before
    being summed across hosts so one host's counter reset cannot mask
    another host's real growth. None when no scrape falls in [t0, t1] at
    all; a component simply absent from those scrapes still gets a result
    with None fields (nothing to report, but the window was scraped)."""
    sequence, within = select_scrape_window(rows, t0, t1)
    if not within:
        return None
    hosts = set()
    for r in sequence:
        hosts.update(r.get("components", {}).get(comp, {}).keys())
    if not hosts:
        hosts = {""}
    sums = {f: 0.0 for f in COUNTERS}
    present = {f: False for f in COUNTERS}
    reset = False
    gaps = 0
    for host in hosts:
        for f in COUNTERS:
            values = [r.get("components", {}).get(comp, {}).get(host, {}).get(f) for r in sequence]
            inc, f_reset, f_gaps, had = _series_increment(values)
            if had:
                sums[f] += inc
                present[f] = True
            reset = reset or f_reset
            gaps += f_gaps
    d = {f: (sums[f] if present[f] else None) for f in COUNTERS}
    last_components = within[-1].get("components", {}).get(comp, {})
    d["utilization"] = _sum_gauge(last_components, "utilization")
    d["buffer_events"] = _sum_gauge(last_components, "buffer_events")
    d["buffer_bytes"] = _sum_gauge(last_components, "buffer_bytes")
    d["window_sec"] = t1 - t0
    d["window"] = {"from": iso(sequence[0]["ts"]), "to": iso(sequence[-1]["ts"]), "scrapes": len(sequence)}
    d["reset"] = reset
    d["gaps"] = gaps
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
        # been counted, so a series that never appeared in the window means
        # zero, not unknown. A series that appeared and then vanished is a
        # gap instead (component_delta already excludes it from the sum and
        # flags it in d["gaps"] rather than treating it as zero).
        entry = {"component": comp, "received": d.get("received"), "sent": d.get("sent"),
                 "errors": d["errors"] if d["errors"] is not None else 0.0,
                 "discarded": d["discarded"] if d["discarded"] is not None else 0.0,
                 "utilization": d.get("utilization"),
                 "buffer_events": d.get("buffer_events"), "buffer_bytes": d.get("buffer_bytes"),
                 "reset": d["reset"], "gaps": d["gaps"], "window": d["window"]}
        if d.get("received") is not None and d["window_sec"]:
            entry["received_per_sec"] = d["received"] / d["window_sec"]
        if d.get("handler_count"):
            entry["http_handler_ms_avg"] = 1000 * d["handler_seconds_sum"] / d["handler_count"]
        out["aggregator"][role] = entry
        if d["reset"] or d["gaps"]:
            quality.append({"role": role, "component": comp, "reset": d["reset"], "gaps": d["gaps"]})
    out["quality"] = quality
    # per-record vs per-POST sanity: source should see records/batch_size if it counts POSTs
    src, rec = out["aggregator"].get("source"), out["aggregator"].get("records")
    if src and rec and src.get("received") and rec.get("received") is not None and batch_size:
        out["aggregator"]["records_per_source_event"] = rec["received"] / src["received"]
    if cw is not None:
        out["service_cpu_pct"] = cpu_in_window(cw, t0, t1)
    return out


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

    stages = [summarize_stage(st, rows, comps, cw, batch_size) for st in stages_from_buckets(buckets)] if buckets else []
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
        "scrapes": {"file": a.metrics, "count": len(rows), "first": iso(rows[0]["ts"]) if rows else None, "last": iso(rows[-1]["ts"]) if rows else None},
        "cloudwatch": {"cluster": a.cw_cluster, "service": a.cw_service, "points": len(cw) if cw else 0},
    }
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
    L.append(f"- scrapes: {r['scrapes']['count']} from {r['scrapes']['first']} to {r['scrapes']['last']}; cloudwatch points: {r['cloudwatch']['points']}")
    L.append("")
    if r["stages"]:
        L.append("| stage | start (UTC) | s | eps delivered | p99 ms (med/max) | fail rate | dropped | src recv | src/s | records recv | rec errors | rec util | sink sent | buf events | cpu avg/max % |")
        L.append("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
        for i, s in enumerate(r["stages"]):
            g, ag = s["generator"], s["aggregator"]
            src, rec, sink = ag.get("source", {}), ag.get("records", {}), ag.get("sink", {})
            cpu = s.get("service_cpu_pct") or {}
            L.append("| {} | {} | {} | {} | {}/{} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {}/{} |".format(
                i, s["start"][11:19], fmt(s["seconds"], 0), fmt(g["eps_delivered"], 0), fmt(g["send_p99_ms_median"]), fmt(g["send_p99_ms_max"]),
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
                    bits.append(f"{item['gaps']} gap(s) in the series (increment unknown for that step, not counted)")
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
