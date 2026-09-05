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

    def test_vanished_series_reappears_without_double_counting_gap(self):
        rows = [
            row(0, http_json={"": {"received": 100.0}}),
            row(15, http_json={}),
            row(30, http_json={}),
            row(45, http_json={"": {"received": 500.0}}),  # unknown jump during the gap
        ]
        d = cr.component_delta(rows, "http_json", 0, 45)
        self.assertIsNotNone(d)
        # Only one gap counted (the disappearance); the reappearance is a
        # fresh baseline, not an extra gap, and contributes no increment.
        self.assertEqual(d["gaps"], 1)
        self.assertEqual(d["received"], 0.0)
        self.assertFalse(d["reset"])

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
    def test_run_start_at_wins_and_carries_the_lateness_as_uncertainty(self):
        summary = {
            "run": {"started_at": "2026-09-05T14:00:03Z", "start_at": REF},
            "fleet": {"generators": [
                {"started_at": "2026-09-05T14:00:02Z"},
                {"started_at": "2026-09-05T14:00:05Z"},
            ]},
        }
        ref = cr.start_reference(summary)
        self.assertEqual(ref["epoch"], REF_EPOCH)
        self.assertIn("run.start_at", ref["source"])
        # The last generator was 5 s late against the instant it was given.
        self.assertEqual(ref["uncertainty_sec"], 5.0)

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
        self.assertEqual(ref["source"], "run.started_at")
        self.assertEqual(ref["uncertainty_sec"], 0.0)

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

    def test_heuristic_alignment_is_labelled_as_such(self):
        lines = cr.alignment_lines({"stages_from": "heuristic", "note": "this artifact predates the `schedule` field"})
        self.assertEqual(len(lines), 1)
        self.assertIn("stage boundaries inferred from delivered EPS (heuristic; older artifact)", lines[0])
        self.assertIn("predates", lines[0])

    def test_nothing_to_say_without_stages(self):
        self.assertEqual(cr.alignment_lines(None), [])
        self.assertEqual(cr.alignment_lines({"stages_from": "none"}), [])


if __name__ == "__main__":
    unittest.main()
