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


if __name__ == "__main__":
    unittest.main()
