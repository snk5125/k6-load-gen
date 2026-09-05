#!/usr/bin/env python3
"""
Unit tests for tools/correlate_run.py — counter resets and missing series
(issue 5). Stdlib `unittest` only, run with:

    python3 -m unittest discover -s tools -p 'test_*.py'

Covers: component_delta's replacement of endpoint subtraction with the sum
of positive increments over consecutive scrapes, counter-reset handling,
gap (vanished-series) handling, per-host differencing before summing, and
the reported scrape window. Also verifies parse_prom against a small
captured Prometheus text sample.
"""
import unittest

import correlate_run as cr


def row(ts, **components):
    """Build one scrape row: row(10, http_json={"": {"received": 5.0}})."""
    return {"ts": ts, "components": components}


class ParsePromTests(unittest.TestCase):
    # Captured (trimmed) from a real `vector --config ... --watch-config`
    # prometheus_exporter /metrics response, k6-load-gen aggregator, single
    # host, 2026-08-01. Kept small: one counter with two label sets that
    # collapse to the same component, one gauge, and a comment/HELP/TYPE
    # block to prove those lines are skipped.
    SAMPLE = """\
# HELP vector_component_received_events_total Total received events.
# TYPE vector_component_received_events_total counter
vector_component_received_events_total{component_id="http_json",component_type="source"} 120
vector_component_received_events_total{component_id="http_json",component_type="source",code="400"} 5
# HELP vector_utilization Utilization.
# TYPE vector_utilization gauge
vector_utilization{component_id="json-app"} 0.42
vector_component_sent_events_total{component_id="Splunk",host="gen-a"} 30
vector_component_sent_events_total{component_id="Splunk",host="gen-b"} 70
"""

    def test_sums_same_component_across_other_labels(self):
        out = cr.parse_prom(self.SAMPLE)
        # No host label -> host key is "", and the two http_json series
        # (base + code="400") are summed together.
        self.assertEqual(out["http_json"][""]["received"], 125.0)

    def test_gauge_parses_under_default_host(self):
        out = cr.parse_prom(self.SAMPLE)
        self.assertEqual(out["json-app"][""]["utilization"], 0.42)

    def test_host_label_keys_a_separate_series(self):
        out = cr.parse_prom(self.SAMPLE)
        self.assertEqual(out["Splunk"]["gen-a"]["sent"], 30.0)
        self.assertEqual(out["Splunk"]["gen-b"]["sent"], 70.0)
        # Not collapsed into one host bucket.
        self.assertNotIn("", out["Splunk"])

    def test_comment_and_unknown_metric_lines_ignored(self):
        out = cr.parse_prom(self.SAMPLE)
        self.assertNotIn("vector_component_received_events_total", out)


class ComponentDeltaTests(unittest.TestCase):
    def test_monotonic_counters_give_exact_delta(self):
        # baseline before t0=0, then three scrapes inside the window.
        rows = [
            row(-15, http_json={"": {"received": 90.0}}),
            row(0, http_json={"": {"received": 100.0}}),
            row(15, http_json={"": {"received": 110.0}}),
            row(30, http_json={"": {"received": 120.0}}),
            row(45, http_json={"": {"received": 130.0}}),
        ]
        d = cr.component_delta(rows, "http_json", 0, 45)
        self.assertIsNotNone(d)
        # Telescoping sum of consecutive increments == endpoint subtraction
        # when nothing resets or goes missing: 130 - 90 (baseline included).
        self.assertEqual(d["received"], 40.0)
        self.assertFalse(d["reset"])
        self.assertEqual(d["gaps"], 0)

    def test_reset_mid_window_is_non_negative_and_flagged(self):
        rows = [
            row(0, http_json={"": {"received": 100.0}}),
            row(15, http_json={"": {"received": 110.0}}),
            row(30, http_json={"": {"received": 50.0}}),   # process restarted
            row(45, http_json={"": {"received": 60.0}}),
        ]
        d = cr.component_delta(rows, "http_json", 0, 45)
        self.assertIsNotNone(d)
        # 0->100 (no baseline, first sample sets the reference): +0
        # 100->110: +10; 110->50: reset, count post-reset value +50; 50->60: +10
        self.assertEqual(d["received"], 70.0)
        self.assertGreaterEqual(d["received"], 0.0)
        self.assertTrue(d["reset"])

    def test_vanished_series_flags_gap_without_going_negative(self):
        rows = [
            row(0, http_json={"": {"received": 100.0}}),
            row(15, http_json={"": {"received": 110.0}}),
            row(30, http_json={}),                          # series disappeared
            row(45, http_json={}),
        ]
        d = cr.component_delta(rows, "http_json", 0, 45)
        self.assertIsNotNone(d)
        self.assertEqual(d["received"], 10.0)  # only the 100->110 step is known
        self.assertGreaterEqual(d["received"], 0.0)
        self.assertFalse(d["reset"])
        self.assertEqual(d["gaps"], 1)

    def test_vanished_series_reappears_and_the_rise_across_the_gap_is_credited(self):
        # REWRITTEN (was test_vanished_series_reappears_without_double_counting_gap,
        # which asserted received == 0.0). Treating the resumed value as a fresh
        # baseline threw away a real, KNOWN increment: a Vector counter is
        # cumulative, so 500 at resumption already includes everything that
        # happened while the series was missing. 500 - 100 is the honest figure;
        # discarding it under-counts the stage by the whole gap.
        rows = [
            row(0, http_json={"": {"received": 100.0}}),
            row(15, http_json={}),
            row(30, http_json={}),
            row(45, http_json={"": {"received": 500.0}}),
        ]
        d = cr.component_delta(rows, "http_json", 0, 45)
        self.assertIsNotNone(d)
        # One gap counted (the disappearance), still reported for the quality note.
        self.assertEqual(d["gaps"], 1)
        self.assertEqual(d["received"], 400.0)
        self.assertFalse(d["reset"])

    def test_gap_mid_window_does_not_lose_the_increment_across_it(self):
        # The exact regression: 100, 110, None, 130, 140 must be 40, not 20.
        rows = [
            row(0, http_json={"": {"received": 100.0}}),
            row(15, http_json={"": {"received": 110.0}}),
            row(30, http_json={}),
            row(45, http_json={"": {"received": 130.0}}),
            row(60, http_json={"": {"received": 140.0}}),
        ]
        d = cr.component_delta(rows, "http_json", 0, 60)
        self.assertIsNotNone(d)
        self.assertEqual(d["received"], 40.0)
        self.assertEqual(d["gaps"], 1)
        self.assertFalse(d["reset"])

    def test_single_scrape_gap_credits_the_whole_rise(self):
        rows = [
            row(0, http_json={"": {"received": 100.0}}),
            row(15, http_json={}),
            row(30, http_json={"": {"received": 130.0}}),
        ]
        d = cr.component_delta(rows, "http_json", 0, 30)
        self.assertIsNotNone(d)
        self.assertEqual(d["received"], 30.0)
        self.assertEqual(d["gaps"], 1)

    def test_lower_value_after_a_gap_is_still_a_reset(self):
        # Resuming BELOW the last known value is the one case that is not a
        # continuation: the process restarted while the series was missing.
        rows = [
            row(0, http_json={"": {"received": 100.0}}),
            row(15, http_json={}),
            row(30, http_json={"": {"received": 20.0}}),
        ]
        d = cr.component_delta(rows, "http_json", 0, 30)
        self.assertIsNotNone(d)
        self.assertEqual(d["received"], 20.0)
        self.assertTrue(d["reset"])
        self.assertEqual(d["gaps"], 1)

    def test_one_observation_without_a_baseline_is_unknown_not_zero(self):
        # A single scrape gives a LEVEL, not an increment. Publishing 0.0 here
        # reads as "the component handled nothing", which is a different claim.
        rows = [row(5, http_json={"": {"received": 100.0}})]
        d = cr.component_delta(rows, "http_json", 0, 15)
        self.assertIsNotNone(d)
        self.assertIsNone(d["received"])
        self.assertTrue(d["lone_scrape"])
        self.assertIn("received", d["unknown"])

    def test_a_baseline_makes_a_single_in_window_scrape_differenceable(self):
        rows = [
            row(-15, http_json={"": {"received": 90.0}}),
            row(5, http_json={"": {"received": 100.0}}),
        ]
        d = cr.component_delta(rows, "http_json", 0, 15)
        self.assertIsNotNone(d)
        self.assertEqual(d["received"], 10.0)
        self.assertFalse(d["lone_scrape"])

    def test_two_hosts_one_resetting_other_growth_not_masked(self):
        rows = [
            row(0, sink={"gen-a": {"sent": 100.0}, "gen-b": {"sent": 200.0}}),
            row(15, sink={"gen-a": {"sent": 110.0}, "gen-b": {"sent": 220.0}}),
            row(30, sink={"gen-a": {"sent": 20.0}, "gen-b": {"sent": 240.0}}),  # gen-a resets
            row(45, sink={"gen-a": {"sent": 40.0}, "gen-b": {"sent": 260.0}}),
        ]
        d = cr.component_delta(rows, "sink", 0, 45)
        self.assertIsNotNone(d)
        self.assertTrue(d["reset"])
        # gen-a: 100->110 (+10), 110->20 (reset, +20), 20->40 (+20) = 50
        # gen-b: monotonic, 200->260 (+60) via telescoping increments
        # combined: 110
        self.assertEqual(d["sent"], 110.0)

    def test_no_scrapes_in_window_returns_none(self):
        rows = [row(-100, http_json={"": {"received": 1.0}})]
        self.assertIsNone(cr.component_delta(rows, "http_json", 0, 45))

    def test_component_absent_from_all_scrapes_gives_none_fields(self):
        rows = [row(0, other={"": {"received": 1.0}}), row(45, other={"": {"received": 2.0}})]
        d = cr.component_delta(rows, "http_json", 0, 45)
        self.assertIsNotNone(d)  # scrapes exist in the window, just not for this component
        self.assertIsNone(d["received"])
        self.assertEqual(d["gaps"], 0)
        self.assertFalse(d["reset"])

    def test_window_reports_scrapes_actually_used(self):
        rows = [
            row(-15, http_json={"": {"received": 90.0}}),  # baseline, before t0
            row(0, http_json={"": {"received": 100.0}}),
            row(15, http_json={"": {"received": 110.0}}),
            row(45, http_json={"": {"received": 130.0}}),  # not requested, outside t1
        ]
        d = cr.component_delta(rows, "http_json", 0, 15)
        self.assertIsNotNone(d)
        self.assertEqual(d["window"]["scrapes"], 3)  # baseline + the two in [0, 15]
        self.assertEqual(d["window"]["from"], cr.iso(-15))
        self.assertEqual(d["window"]["to"], cr.iso(15))

    def test_window_without_baseline_uses_only_in_window_scrapes(self):
        rows = [
            row(0, http_json={"": {"received": 100.0}}),
            row(15, http_json={"": {"received": 110.0}}),
        ]
        d = cr.component_delta(rows, "http_json", 0, 15)
        self.assertIsNotNone(d)
        self.assertEqual(d["window"]["scrapes"], 2)
        self.assertEqual(d["received"], 10.0)
        # No baseline, so the covered span is the stage's own length here.
        self.assertEqual(d["window_sec"], 15.0)
        self.assertEqual(d["nominal_sec"], 15.0)

    def test_rate_denominator_is_the_span_the_increments_actually_cover(self):
        # The baseline sits 15 s BEFORE the stage, so the counted increment
        # (90 -> 110) spans 30 s, not the stage's nominal 15 s. Dividing 20
        # events by 15 s would claim 1.33/s for work that took 30 s.
        rows = [
            row(-15, http_json={"": {"received": 90.0}}),
            row(0, http_json={"": {"received": 100.0}}),
            row(15, http_json={"": {"received": 110.0}}),
        ]
        d = cr.component_delta(rows, "http_json", 0, 15)
        self.assertIsNotNone(d)
        self.assertEqual(d["received"], 20.0)
        self.assertEqual(d["window_sec"], 30.0)      # baseline ts .. last in-window ts
        self.assertEqual(d["nominal_sec"], 15.0)     # the stage's own seconds, kept separately
        self.assertEqual(d["window"]["seconds"], 30.0)

    def test_summarize_stage_divides_received_by_the_covered_span(self):
        rows = [
            row(-15, http_json={"": {"received": 90.0}}),
            row(0, http_json={"": {"received": 100.0}}),
            row(15, http_json={"": {"received": 110.0}}),
        ]
        st = {"buckets": [bucket("1970-01-01T00:00:00Z", bucket_sec=15)]}
        out = cr.summarize_stage(st, rows, {"source": "http_json"}, None, None)
        src = out["aggregator"]["source"]
        self.assertEqual(src["received"], 20.0)
        self.assertAlmostEqual(src["received_per_sec"], 20.0 / 30.0)

    def test_span_of_a_single_scrape_stage_does_not_divide_by_zero(self):
        rows = [row(5, http_json={"": {"received": 100.0}})]
        d = cr.component_delta(rows, "http_json", 0, 15)
        self.assertEqual(d["window_sec"], 0.0)
        st = {"buckets": [bucket("1970-01-01T00:00:00Z", bucket_sec=15)]}
        out = cr.summarize_stage(st, rows, {"source": "http_json"}, None, None)
        self.assertNotIn("received_per_sec", out["aggregator"]["source"])



class CoverageNoteTests(unittest.TestCase):
    def test_no_note_for_complete_off_or_absent(self):
        from correlate_run import coverage_note
        self.assertIsNone(coverage_note(None))
        self.assertIsNone(coverage_note({"expected": 3, "present": [0, 1, 2], "missing": [], "complete": True, "configured_off": False}))
        self.assertIsNone(coverage_note({"expected": 3, "present": [], "missing": [0, 1, 2], "complete": False, "configured_off": True}))

    def test_incomplete_names_the_missing_generators(self):
        from correlate_run import coverage_note
        note = coverage_note({"expected": 3, "present": [0, 2], "missing": [1], "complete": False, "configured_off": False})
        self.assertIn("INCOMPLETE", note)
        self.assertIn("2/3", note)
        self.assertIn("gen-1", note)
        self.assertIn("no knee verdict", note)


# ---------------------------------------------------------------- schedule alignment

def bucket(start_iso, bucket_sec=15, eps=100.0):
    """One timeline bucket, only the fields the stage grid touches."""
    return {"bucket_start": start_iso, "bucket_sec": bucket_sec, "eps": eps,
            "events_sent": eps * bucket_sec, "events_attempted": eps * bucket_sec,
            "send_failures": 0, "send_samples": 10, "failure_rate": 0.0,
            "send_duration_p50": 1, "send_duration_p95": 2, "send_duration_p99": 3,
            "dropped_iterations": 0}


# A two-stage schedule: 30 s at 1000 eps, then 60 s at 4000 eps.
SCHEDULE = {
    "json-app": {
        "executor": "ramping-arrival-rate",
        "duration_scale": 1,
        "gen_count": 2,
        "batch_size": 100,
        "start_rate_per_sec": 5,
        "stages": [
            {"target_iterations_per_sec": 5, "target_eps_fleet": 1000, "duration_sec": 30},
            {"target_iterations_per_sec": 20, "target_eps_fleet": 4000, "duration_sec": 60},
        ],
    }
}

REF = "2026-09-05T14:00:00Z"
REF_EPOCH = cr.parse_iso(REF)


class ParseInstantTests(unittest.TestCase):
    def test_reads_both_forms_start_at_accepts(self):
        self.assertEqual(cr.parse_instant("2026-09-05T14:00:00Z"), REF_EPOCH)
        self.assertEqual(cr.parse_instant(str(int(REF_EPOCH))), REF_EPOCH)

    def test_none_for_absent_unknown_or_unparseable(self):
        self.assertIsNone(cr.parse_instant(None))
        self.assertIsNone(cr.parse_instant(""))
        self.assertIsNone(cr.parse_instant("unknown"))
        self.assertIsNone(cr.parse_instant("next tuesday"))


class StartReferenceTests(unittest.TestCase):
    def test_grid_anchors_on_the_actual_start_not_the_scheduled_instant(self):
        # REWRITTEN (was test_run_start_at_wins_and_carries_the_lateness_as_uncertainty,
        # which asserted epoch == run.start_at). Anchoring the intended grid on the
        # SCHEDULED instant is what produced the bug: the stages actually ran from
        # when the generators began, so a fleet that came up after START_AT had every
        # row labelled with the wrong stage and the wrong "eps offered". start_at now
        # only reports lateness and widens uncertainty; it is never the origin.
        summary = {
            "run": {"started_at": "2026-09-05T14:00:02Z", "start_at": REF},
            "fleet": {"generators": [
                {"started_at": "2026-09-05T14:00:02Z"},
                {"started_at": "2026-09-05T14:00:05Z"},
            ]},
        }
        ref = cr.start_reference(summary)
        self.assertEqual(ref["epoch"], cr.parse_iso("2026-09-05T14:00:02Z"))
        self.assertIn("fleet.generators", ref["source"])
        # Uncertainty is the OBSERVED skew between first and last generator.
        self.assertEqual(ref["uncertainty_sec"], 3.0)
        # start_at survives only as a report of how late the fleet was.
        self.assertEqual(ref["lateness_sec"], 2.0)

    def test_a_late_fleet_is_anchored_where_it_really_began(self):
        # START_AT was already 5 minutes past when the tasks came up. The old
        # code laid the grid at 14:00:00 and shifted every stage by 300 s.
        summary = {
            "run": {"started_at": "2026-09-05T14:05:00Z", "start_at": REF},
            "fleet": {"generators": [{"started_at": "2026-09-05T14:05:00Z"}]},
        }
        ref = cr.start_reference(summary)
        self.assertEqual(ref["epoch"], cr.parse_iso("2026-09-05T14:05:00Z"))
        self.assertEqual(ref["lateness_sec"], 300.0)
        self.assertEqual(ref["uncertainty_sec"], 0.0)

    def test_start_at_later_than_the_actual_start_is_impossible_and_adds_uncertainty(self):
        # A generator cannot begin before the instant it was told to wait for, so
        # this means the clocks disagree; the discrepancy becomes uncertainty.
        summary = {
            "run": {"started_at": "2026-09-05T13:59:56Z", "start_at": REF},
            "fleet": {"generators": [{"started_at": "2026-09-05T13:59:56Z"}]},
        }
        ref = cr.start_reference(summary)
        self.assertEqual(ref["epoch"], cr.parse_iso("2026-09-05T13:59:56Z"))
        self.assertEqual(ref["lateness_sec"], -4.0)
        self.assertEqual(ref["uncertainty_sec"], 4.0)

    def test_start_at_is_the_origin_only_when_no_actual_start_exists(self):
        ref = cr.start_reference({"run": {"started_at": "unknown", "start_at": REF}})
        self.assertEqual(ref["epoch"], REF_EPOCH)
        self.assertIn("run.start_at", ref["source"])
        self.assertIsNone(ref["lateness_sec"])

    def test_without_start_at_a_fleet_uses_its_earliest_generator_start(self):
        summary = {
            "run": {"started_at": "2026-09-05T14:00:05Z", "start_at": None},
            "fleet": {"generators": [
                {"started_at": "2026-09-05T14:00:02Z"},
                {"started_at": "2026-09-05T14:00:06Z"},
            ]},
        }
        ref = cr.start_reference(summary)
        self.assertEqual(ref["epoch"], cr.parse_iso("2026-09-05T14:00:02Z"))
        self.assertIn("fleet.generators", ref["source"])
        self.assertEqual(ref["uncertainty_sec"], 4.0)

    def test_single_generator_falls_back_to_run_started_at(self):
        ref = cr.start_reference({"run": {"started_at": REF, "start_at": None}})
        self.assertEqual(ref["epoch"], REF_EPOCH)
        self.assertIn("run.started_at", ref["source"])
        self.assertIn("actually began", ref["source"])
        self.assertEqual(ref["uncertainty_sec"], 0.0)
        self.assertIsNone(ref["lateness_sec"])

    def test_none_when_nothing_usable(self):
        self.assertIsNone(cr.start_reference({"run": {"started_at": "unknown"}}))


class ScheduleGridTests(unittest.TestCase):
    def test_single_type_grid_accumulates_offsets(self):
        stages, note = cr.schedule_grid(SCHEDULE, ["json-app"])
        self.assertIsNone(note)
        self.assertEqual([(s["offset_start"], s["offset_end"]) for s in stages], [(0.0, 30.0), (30.0, 90.0)])
        self.assertEqual([s["target_eps_fleet"] for s in stages], [1000.0, 4000.0])

    def test_absent_schedule_gives_no_grid_and_no_note(self):
        self.assertEqual(cr.schedule_grid(None), (None, None))
        self.assertEqual(cr.schedule_grid({}), (None, None))

    def test_shared_iterations_schedule_says_there_are_no_stages(self):
        stages, note = cr.schedule_grid({"json-app": {"executor": "shared-iterations", "iterations": 20, "vus": 1, "stages": []}})
        self.assertIsNone(stages)
        self.assertIn("no stages", note)

    def test_two_types_with_identical_boundaries_sum_the_offered_eps(self):
        two = {
            "json-app": SCHEDULE["json-app"],
            "auditd": {"executor": "ramping-arrival-rate", "duration_scale": 1, "gen_count": 2, "batch_size": 50,
                       "stages": [
                           {"target_iterations_per_sec": 2, "target_eps_fleet": 200, "duration_sec": 30},
                           {"target_iterations_per_sec": 8, "target_eps_fleet": 800, "duration_sec": 60},
                       ]},
        }
        stages, note = cr.schedule_grid(two)
        self.assertEqual([s["target_eps_fleet"] for s in stages], [1200.0, 4800.0])
        self.assertIn("SUM", note)
        self.assertEqual(stages[0]["types"], ["auditd", "json-app"])

    def test_two_types_with_different_boundaries_give_no_grid(self):
        two = {
            "json-app": SCHEDULE["json-app"],
            "auditd": {"executor": "ramping-arrival-rate", "duration_scale": 1, "gen_count": 2, "batch_size": 50,
                       "stages": [{"target_iterations_per_sec": 2, "target_eps_fleet": 200, "duration_sec": 90}]},
        }
        stages, note = cr.schedule_grid(two)
        self.assertIsNone(stages)
        self.assertIn("PER TYPE", note)
        self.assertIn("no single stage grid", note)

    def test_active_types_narrow_a_multi_type_schedule_to_one_grid(self):
        two = {
            "json-app": SCHEDULE["json-app"],
            "auditd": {"executor": "ramping-arrival-rate", "duration_scale": 1, "gen_count": 2, "batch_size": 50,
                       "stages": [{"target_iterations_per_sec": 2, "target_eps_fleet": 200, "duration_sec": 90}]},
        }
        stages, note = cr.schedule_grid(two, ["json-app"])
        self.assertIsNotNone(stages)
        self.assertEqual(len(stages), 2)
        self.assertIsNone(note)


class AssignBucketsTests(unittest.TestCase):
    def setUp(self):
        self.stages, _ = cr.schedule_grid(SCHEDULE)

    def test_each_bucket_lands_in_the_stage_containing_its_start(self):
        buckets = [bucket("2026-09-05T14:00:00Z"), bucket("2026-09-05T14:00:15Z"),
                   bucket("2026-09-05T14:00:30Z"), bucket("2026-09-05T14:01:15Z")]
        a = cr.assign_buckets(buckets, self.stages, REF_EPOCH)
        self.assertEqual([x["stage"] for x in a], [0, 0, 1, 1])

    def test_aligned_buckets_do_not_straddle_a_boundary(self):
        # 15 s buckets against a 30 s stage: every edge falls between buckets.
        buckets = [bucket("2026-09-05T14:00:00Z"), bucket("2026-09-05T14:00:15Z"),
                   bucket("2026-09-05T14:00:30Z")]
        a = cr.assign_buckets(buckets, self.stages, REF_EPOCH)
        self.assertEqual([x["boundary"] for x in a], [False, False, False])

    def test_a_bucket_spanning_a_stage_edge_is_flagged(self):
        # The run started 7 s before the bucket grid's tick, so the 30 s stage
        # boundary falls INSIDE the 14:00:22 bucket (offsets 22..37).
        buckets = [bucket("2026-09-05T14:00:22Z")]
        a = cr.assign_buckets(buckets, self.stages, REF_EPOCH)
        self.assertEqual(a[0]["stage"], 0)
        self.assertTrue(a[0]["boundary"])

    def test_uncertainty_widens_the_boundary_marking(self):
        # Bucket 14:00:15..14:00:30 does not cross the edge at 30 exactly, but a
        # 3 s uncertainty in the reference means it might have.
        buckets = [bucket("2026-09-05T14:00:15Z")]
        self.assertFalse(cr.assign_buckets(buckets, self.stages, REF_EPOCH)[0]["boundary"])
        self.assertTrue(cr.assign_buckets(buckets, self.stages, REF_EPOCH, 3.0)[0]["boundary"])

    def test_buckets_outside_the_schedule_are_stageless_and_flagged(self):
        before = bucket("2026-09-05T13:59:45Z")
        after = bucket("2026-09-05T14:01:30Z")  # offset 90 == the end of the last stage
        a = cr.assign_buckets([before, after], self.stages, REF_EPOCH)
        self.assertEqual([x["stage"] for x in a], [None, None])
        self.assertEqual([x["boundary"] for x in a], [True, True])


class StagesFromScheduleTests(unittest.TestCase):
    def setUp(self):
        self.stages, _ = cr.schedule_grid(SCHEDULE)

    def test_groups_buckets_per_intended_stage_with_offered_eps(self):
        buckets = [bucket("2026-09-05T14:00:00Z"), bucket("2026-09-05T14:00:15Z"),
                   bucket("2026-09-05T14:00:30Z"), bucket("2026-09-05T14:00:45Z"),
                   bucket("2026-09-05T14:01:00Z"), bucket("2026-09-05T14:01:15Z")]
        groups = cr.stages_from_schedule(buckets, self.stages, REF_EPOCH)
        self.assertEqual([g["stage"] for g in groups], [0, 1])
        self.assertEqual([len(g["buckets"]) for g in groups], [2, 4])
        self.assertEqual([g["eps_offered"] for g in groups], [1000.0, 4000.0])
        self.assertEqual([g["intended_seconds"] for g in groups], [30.0, 60.0])
        self.assertEqual([g["boundary_buckets"] for g in groups], [0, 0])

    def test_a_trailing_overrun_becomes_its_own_stageless_group(self):
        buckets = [bucket("2026-09-05T14:00:00Z"), bucket("2026-09-05T14:01:30Z")]
        groups = cr.stages_from_schedule(buckets, self.stages, REF_EPOCH)
        self.assertEqual([g["stage"] for g in groups], [0, None])
        self.assertIsNone(groups[1]["eps_offered"])
        self.assertEqual(groups[1]["boundary_buckets"], 1)

    def test_counts_the_straddling_buckets_of_each_stage(self):
        # Offset the grid by 7 s so the 30 s edge falls inside a bucket.
        buckets = [bucket("2026-09-05T14:00:07Z"), bucket("2026-09-05T14:00:22Z"),
                   bucket("2026-09-05T14:00:37Z")]
        groups = cr.stages_from_schedule(buckets, self.stages, REF_EPOCH)
        self.assertEqual([g["stage"] for g in groups], [0, 1])
        self.assertEqual(groups[0]["boundary_buckets"], 1)  # the 14:00:22 bucket


class SummarizeStageQualityTests(unittest.TestCase):
    """The unknown/zero distinction has to survive into the row and the note:
    a counter Vector never emitted is a real zero, one it emitted only once is
    unknown, and the reader must be able to tell which they are looking at."""

    STAGE = {"buckets": [bucket("1970-01-01T00:00:00Z", bucket_sec=15)]}

    def test_a_series_never_emitted_is_reported_as_zero(self):
        # Vector only exposes errors once something has errored, so an absent
        # errors series across a scraped window means none happened.
        rows = [
            row(0, http_json={"": {"received": 100.0}}),
            row(15, http_json={"": {"received": 110.0}}),
        ]
        out = cr.summarize_stage(self.STAGE, rows, {"source": "http_json"}, None, None)
        src = out["aggregator"]["source"]
        self.assertEqual(src["errors"], 0.0)
        self.assertEqual(src["discarded"], 0.0)
        self.assertEqual(out["quality"], [])

    def test_a_series_seen_once_is_unknown_and_noted_not_zeroed(self):
        rows = [row(5, http_json={"": {"received": 100.0, "errors": 3.0}})]
        out = cr.summarize_stage(self.STAGE, rows, {"source": "http_json"}, None, None)
        src = out["aggregator"]["source"]
        self.assertIsNone(src["received"])
        # errors WAS exposed, so it is unknown rather than a confident zero.
        self.assertIsNone(src["errors"])
        # discarded never appeared at all, so it stays a genuine zero.
        self.assertEqual(src["discarded"], 0.0)
        self.assertTrue(out["quality"])
        self.assertTrue(out["quality"][0]["lone"])

    def test_the_markdown_says_one_scrape_in_window(self):
        report = {
            "run": {"run_id": "r", "started_at": None, "ended_at": None, "duration_sec": 0,
                    "artifact": "gen-0", "generators": 1, "generators_reported": 1, "exit_code": 0},
            "config": {"profile": "p", "transport": "http", "types": {}, "active_types": []},
            "validity": {"valid": True, "dropped_iterations": 0, "reasons": []},
            "thresholds_failed": [], "rate": {"requested_eps": 1, "achieved_eps": 1},
            "totals": {"events_attempted": 1, "events_sent": 1, "send_failure_rate": 0, "send_duration_ms": {}},
            "warnings": [], "knee": None, "alignment": None, "timeline_coverage": None,
            "scrapes": {"file": None, "count": 1, "first": None, "last": None},
            "cloudwatch": {"cluster": None, "service": None, "points": 0},
            "stages": [{
                "start": "1970-01-01T00:00:00Z", "seconds": 15, "buckets": 1,
                "generator": {"eps_delivered": 0, "events_sent": 0, "events_attempted": 0,
                              "send_p99_ms_max": None, "send_p99_ms_median": None,
                              "failure_rate": 0.0, "dropped_iterations": 0},
                "aggregator": {}, "stage": 0,
                "quality": [{"role": "source", "component": "http_json",
                             "reset": False, "gaps": 0, "lone": True}],
            }],
        }
        md = cr.render(report)
        self.assertIn("one scrape in window: counters unknown", md)


class GridTooFineTests(unittest.TestCase):
    """A timeline bucket is the smallest unit the report has. A stage shorter
    than one cannot own a bucket, so the bucket would be credited whole to a
    neighbouring stage and the short stage would vanish from the table."""

    SHORT = {
        "json-app": {
            "executor": "ramping-arrival-rate", "duration_scale": 1, "gen_count": 2, "batch_size": 100,
            "stages": [
                {"target_iterations_per_sec": 5, "target_eps_fleet": 1000, "duration_sec": 10},
                {"target_iterations_per_sec": 20, "target_eps_fleet": 4000, "duration_sec": 60},
            ],
        }
    }

    def test_a_stage_shorter_than_the_bucket_width_refuses_the_grid(self):
        stages, _ = cr.schedule_grid(self.SHORT)
        note = cr.grid_too_fine(stages, [bucket("2026-09-05T14:00:00Z", bucket_sec=15)])
        self.assertIsNotNone(note)
        self.assertIn("shorter than", note)
        self.assertIn("heuristic", note)

    def test_a_grid_whose_stages_all_reach_the_bucket_width_is_kept(self):
        stages, _ = cr.schedule_grid(SCHEDULE)
        self.assertIsNone(cr.grid_too_fine(stages, [bucket("2026-09-05T14:00:00Z", bucket_sec=15)]))

    def test_a_stage_exactly_one_bucket_long_is_still_usable(self):
        exact = {"json-app": dict(self.SHORT["json-app"],
                                  stages=[{"target_iterations_per_sec": 5, "target_eps_fleet": 1000, "duration_sec": 15},
                                          {"target_iterations_per_sec": 20, "target_eps_fleet": 4000, "duration_sec": 60}])}
        stages, _ = cr.schedule_grid(exact)
        self.assertIsNone(cr.grid_too_fine(stages, [bucket("2026-09-05T14:00:00Z", bucket_sec=15)]))

    def test_the_widest_bucket_in_the_timeline_sets_the_bar(self):
        stages, _ = cr.schedule_grid(SCHEDULE)  # stages are 30 s and 60 s
        wide = [bucket("2026-09-05T14:00:00Z", bucket_sec=15),
                bucket("2026-09-05T14:00:15Z", bucket_sec=45)]
        self.assertIsNotNone(cr.grid_too_fine(stages, wide))

    def test_no_grid_or_no_buckets_is_not_a_refusal(self):
        stages, _ = cr.schedule_grid(SCHEDULE)
        self.assertIsNone(cr.grid_too_fine(None, [bucket("2026-09-05T14:00:00Z")]))
        self.assertIsNone(cr.grid_too_fine(stages, []))


class AlignmentLinesTests(unittest.TestCase):
    def test_schedule_alignment_states_its_source_and_precision(self):
        lines = cr.alignment_lines({"stages_from": "schedule", "reference": REF,
                                    "reference_source": "run.start_at (the scheduled instant every generator shared)",
                                    "uncertainty_sec": 2.5, "note": None})
        joined = " ".join(lines)
        self.assertIn("resolved `schedule`", joined)
        self.assertIn("run.start_at", joined)
        self.assertIn("±2.5s", joined)
        self.assertIn("eps offered", joined)

    def test_alignment_reports_lateness_without_moving_the_anchor(self):
        lines = cr.alignment_lines({"stages_from": "schedule", "reference": REF,
                                    "reference_source": "earliest fleet.generators[].started_at (when the fleet actually began)",
                                    "uncertainty_sec": 1.0, "note": None,
                                    "lateness_sec": 300.0, "start_at": REF})
        joined = " ".join(lines)
        self.assertIn("300.0s", joined)
        self.assertIn("ACTUAL start", joined)

    def test_no_lateness_line_when_the_run_was_not_scheduled(self):
        lines = cr.alignment_lines({"stages_from": "schedule", "reference": REF,
                                    "reference_source": "run.started_at (when the generator actually began)",
                                    "uncertainty_sec": 0.0, "note": None, "lateness_sec": None})
        self.assertNotIn("scheduled START_AT", " ".join(lines))

    def test_heuristic_alignment_is_labelled_as_such(self):
        lines = cr.alignment_lines({"stages_from": "heuristic", "note": "this artifact predates the `schedule` field"})
        self.assertEqual(len(lines), 1)
        self.assertIn("stage boundaries inferred from delivered EPS (heuristic", lines[0])
        self.assertNotIn("older artifact", lines[0])
        self.assertIn("predates", lines[0])

    def test_nothing_to_say_without_stages(self):
        self.assertEqual(cr.alignment_lines(None), [])
        self.assertEqual(cr.alignment_lines({"stages_from": "none"}), [])


if __name__ == "__main__":
    unittest.main()
