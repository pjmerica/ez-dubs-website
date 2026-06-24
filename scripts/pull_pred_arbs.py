"""
Daily prediction-market arbitrage puller.

Fetches the public arb_data.js files from two sibling GitHub Pages sites,
filters to 100% (guaranteed) arbs, and writes a normalized JSON to the
Prediction Market Arbitrage dashboard for the EZ Dubs Analytics site to
render.

Sources:
- https://pjmerica.github.io/pred-arbitrage/arb_data.js
- https://pjmerica.github.io/polling-agg-2026/arb_data.js

Run manually: py scripts/pull_pred_arbs.py
Run via Actions: see .github/workflows/daily-pred-arbs-pull.yml
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

REPO_ROOT     = Path(__file__).resolve().parents[1]
DASHBOARD_DIR = REPO_ROOT / "dashboards" / "prediction-arbitrage"
OUTPUT_PATH   = DASHBOARD_DIR / "arbs.json"

# Filter on raw price gap (in percentage points) rather than guaranteed_return_pct.
# raw_gap_pp = |implied_prob_a - implied_prob_b| * 100 — i.e., how many cents
# apart the two markets price the same outcome. This is a more honest filter
# than return %, which blows up when both prices are small (a 5pp gap on 10c
# vs 13c looks like 72% return because the denominators are tiny, but the real
# edge is just 5 cents).
#
# Gaps above MAX are almost always upstream data noise (settlement-window
# mismatches, fuzzy-match false positives). Gaps below MIN aren't worth the
# fee/execution-risk surface area.
MIN_GAP_PP = 3.0
MAX_GAP_PP = 15.0

# Hand-curated list of pairs the upstream scanner matches but where the two
# contracts have materially different settlement criteria. Keyed by the
# (url_a, url_b) pair so it survives upstream re-IDs of the underlying markets.
EXCLUDED_URL_PAIRS = {
    # US-Iran nuclear deal before 2027 — different settlement bars. Kalshi
    # requires a formal signed agreement with verifiable enrichment limits;
    # Polymarket only requires a publicly announced mutual agreement.
    ("https://kalshi.com/markets/KXUSAIRANAGREEMENT",
     "https://polymarket.com/event/us-iran-nuclear-deal-before-2027"),

    # Trump pardons Elon Musk — different resolution windows. Kalshi's
    # KXTRUMPPARDONS series resolves any time before Trump leaves office
    # (Jan 21, 2029); PredictIt market 8549 only covers calendar year 2026.
    # Kalshi's higher price is correct probability under its longer window,
    # not an arb against the shorter PredictIt window.
    ("https://kalshi.com/markets/KXTRUMPPARDONS",
     "https://www.predictit.org/markets/detail/8549"),
}

SOURCES = [
    {
        "id":   "pred-arbitrage",
        "name": "Pred Arbitrage Scanner",
        "url":  "https://pjmerica.github.io/pred-arbitrage/arb_data.js",
    },
    {
        "id":   "polling-agg-2026",
        "name": "Polling Agg 2026 Arb Scanner",
        "url":  "https://pjmerica.github.io/polling-agg-2026/arb_data.js",
    },
]


def _parse_arb_js(text: str) -> dict:
    """Strip the `const ARB = ` prefix and trailing `;` to load as JSON."""
    body = text.strip()
    eq = body.find("=")
    if eq < 0:
        raise ValueError("arb_data.js missing '=' separator")
    return json.loads(body[eq + 1 :].strip().rstrip(";"))


def _normalize_race(r: dict, source_id: str) -> dict | None:
    """Pick the fields the dashboard needs; skip rows missing essentials."""
    if r.get("arb_type") != "guaranteed":
        return None
    needed = ("platform_a", "platform_b", "implied_prob_a", "implied_prob_b",
              "url_a", "url_b")
    if any(r.get(k) in (None, "") for k in needed):
        return None
    # Defensive: drop rows whose links aren't real http(s) URLs. Protects
    # against a compromised upstream injecting javascript:/data: URIs that
    # would otherwise reach the dashboard's anchor hrefs.
    for k in ("url_a", "url_b"):
        u = str(r[k])
        if not (u.startswith("https://") or u.startswith("http://")):
            return None
    # Filter on raw price gap (in cents) rather than the return % the upstream
    # publishes. The return % balloons when both probs are small.
    gap_pp = abs(float(r["implied_prob_a"]) - float(r["implied_prob_b"])) * 100.0
    if gap_pp < MIN_GAP_PP or gap_pp > MAX_GAP_PP:
        return None
    if (r["url_a"], r["url_b"]) in EXCLUDED_URL_PAIRS:
        return None
    return {
        "source":   source_id,
        "category": r.get("category") or r.get("office") or "",
        "label":    r.get("label") or r.get("race_id") or "",
        "platform_a": r["platform_a"],
        "platform_b": r["platform_b"],
        "question_a": r.get("question_a", ""),
        "question_b": r.get("question_b", ""),
        "url_a":      r["url_a"],
        "url_b":      r["url_b"],
        "market_id_a": r.get("market_id_a", ""),
        "market_id_b": r.get("market_id_b", ""),
        "prob_a":     float(r["implied_prob_a"]),
        "prob_b":     float(r["implied_prob_b"]),
        "stake_a":    _to_float(r.get("stake_a_dollars")),
        "stake_b":    _to_float(r.get("stake_b_dollars")),
        "return_pct": _to_float(r.get("guaranteed_return_pct")),
        "gap_pp":     gap_pp,
        "settle_date": r.get("settle_date", ""),
        "volume_a":   _to_float(r.get("volume_a")),
        "volume_b":   _to_float(r.get("volume_b")),
        "suspicious": bool(r.get("suspicious")),
        "suspicion_reasons": r.get("suspicion_reasons") or [],
    }


def _to_float(v):
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def main() -> int:
    arbs: list[dict] = []
    source_meta: list[dict] = []
    for src in SOURCES:
        try:
            resp = requests.get(src["url"], timeout=30)
            resp.raise_for_status()
            data = _parse_arb_js(resp.text)
        except Exception as e:
            print(f"WARN: {src['id']} fetch/parse failed: {e}", file=sys.stderr)
            source_meta.append({"id": src["id"], "name": src["name"],
                                "ok": False, "error": str(e)})
            continue
        races = data.get("races") or []
        kept = [n for n in (_normalize_race(r, src["id"]) for r in races) if n]
        arbs.extend(kept)
        source_meta.append({
            "id":         src["id"],
            "name":       src["name"],
            "ok":         True,
            "updated_at": data.get("updated_at"),
            "total":      data.get("total") or len(races),
            "guaranteed_kept": len(kept),
        })
        print(f"{src['id']}: kept {len(kept)} guaranteed arbs of {len(races)} races")

    # Sort: non-suspicious first, then by guaranteed return % desc.
    # Non-suspicious first, then biggest raw gap first.
    arbs.sort(key=lambda a: (a["suspicious"], -(a["gap_pp"] or 0)))

    out = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "sources":      source_meta,
        "arbs":         arbs,
    }
    DASHBOARD_DIR.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(arbs)} arbs to {OUTPUT_PATH.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
