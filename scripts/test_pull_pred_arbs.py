"""Offline tests for scripts/pull_pred_arbs.py's failure handling.

The puller runs every two hours and its output is committed straight to the
live site, so the case that matters most is upstream being down: it must leave
the last good arbs.json in place rather than publish an empty one. No network:
requests.get is replaced for every test.

Run: py scripts/test_pull_pred_arbs.py
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pull_pred_arbs as p  # noqa: E402
import requests  # noqa: E402


class _Resp:
    def __init__(self, text):
        self.text = text

    def raise_for_status(self):
        pass


def _ok(updated_at="2026-10-14T00:00:00+00:00"):
    return _Resp("const ARB = " + json.dumps({"updated_at": updated_at, "races": []}) + ";")


def _down(*_a, **_k):
    raise requests.ConnectionError("simulated outage")


class PullerFailureTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = Path(self.tmp.name) / "arbs.json"
        self.good = '{"generated_at": "earlier", "sources": [], "arbs": [{"x": 1}]}\n'
        self.out.write_text(self.good, encoding="utf-8")
        self.patches = [mock.patch.object(p, "OUTPUT_PATH", self.out),
                        mock.patch.object(p, "DASHBOARD_DIR", Path(self.tmp.name)),
                        mock.patch.object(p, "REPO_ROOT", Path(self.tmp.name))]
        for x in self.patches:
            x.start()

    def tearDown(self):
        for x in self.patches:
            x.stop()
        self.tmp.cleanup()

    def test_all_sources_down_keeps_last_good_file(self):
        with mock.patch.object(p.requests, "get", _down):
            self.assertEqual(p.main(), 1)
        self.assertEqual(self.out.read_text(encoding="utf-8"), self.good)

    def test_one_source_down_still_writes_and_flags_it(self):
        calls = iter([_ok(), None])

        def get(*_a, **_k):
            r = next(calls)
            if r is None:
                _down()
            return r

        with mock.patch.object(p.requests, "get", get):
            self.assertEqual(p.main(), 0)
        d = json.loads(self.out.read_text(encoding="utf-8"))
        self.assertEqual([s["ok"] for s in d["sources"]], [True, False])
        self.assertIn("error", d["sources"][1])

    def test_sources_up_with_no_arbs_writes_empty_list(self):
        # An honest "no arbs right now" is not an outage and should publish.
        with mock.patch.object(p.requests, "get", lambda *a, **k: _ok()):
            self.assertEqual(p.main(), 0)
        self.assertEqual(json.loads(self.out.read_text(encoding="utf-8"))["arbs"], [])


class DerivedFieldTests(unittest.TestCase):
    def test_days_until(self):
        from datetime import date
        self.assertEqual(p._days_until("2026-10-28", today=date(2026, 10, 14)), 14.0)
        self.assertIsNone(p._days_until("", today=date(2026, 10, 14)))
        self.assertIsNone(p._days_until("not a date"))

    def test_annualize_compounds(self):
        # 1% over half a year is about 2.01% a year, not 2%.
        self.assertAlmostEqual(p._annualize(1.0, 182.5), 2.01, places=2)

    def test_annualize_blank_under_a_week(self):
        self.assertIsNone(p._annualize(1.0, 3))
        self.assertIsNone(p._annualize(None, 100))

    def test_normalize_carries_asks_and_direction(self):
        row = {"arb_type": "guaranteed", "platform_a": "kalshi", "platform_b": "polymarket",
               "url_a": "https://k", "url_b": "https://p", "implied_prob_a": 0.59,
               "implied_prob_b": 0.595, "guaranteed_return_pct": 2.0, "yes_leg": "a",
               "fillable_ask_a": 0.64, "fillable_no_ask_a": 0.37,
               "fillable_ask_b": 0.67, "fillable_no_ask_b": 0.32, "settle_date": ""}
        n = p._normalize_race(row, "pred-arbitrage")
        self.assertEqual((n["yes_leg"], n["ask_yes_a"], n["ask_no_b"]), ("a", 0.64, 0.32))
        self.assertIsNone(n["annualized_return_pct"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
