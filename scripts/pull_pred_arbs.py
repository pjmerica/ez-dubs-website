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

# Filter on guaranteed_return_pct (2026-07-04; was display-gap 3-15pp).
#
# Why the change: both upstream scanners now compute guaranteed_return_pct
# from REAL fillable ask prices (live orderbooks), not midpoints — the old
# "return % blows up when both prices are small" failure mode is gone.
# Meanwhile the display-gap filter was excluding exactly the best arb
# class: when a book moves without a trade printing, the display gap can
# be 0.0pp while a genuine 17% Buy-Yes+Buy-No basket exists (e.g. Kalshi
# last trade 8c, book bidding 30c, Polymarket asking 9c). Returns above
# MAX are still treated as upstream noise (criteria-mismatch survivors).
MIN_RETURN_PCT = 1.0
MAX_RETURN_PCT = 25.0

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


def _display_probs(r: dict) -> tuple[float | None, float | None]:
    """Display probabilities for the A/B legs, handling both upstream schemas.

    - pred-arbitrage rows: implied_prob_a / implied_prob_b.
    - polling-agg-2026 rows: general pairs use f"{platform}_dem" keys
      (e.g. kalshi_dem / pm... no — polymarket_dem), candidate pairs use
      prob_a / prob_b. The old code only looked for implied_prob_a/b, so
      EVERY polling-agg row was silently dropped since the source was
      wired up (its source_meta always showed guaranteed_kept: 0).
    """
    def _f(v):
        try:
            return float(v) if v is not None and v != "" else None
        except (TypeError, ValueError):
            return None
    pa = _f(r.get("implied_prob_a"))
    pb = _f(r.get("implied_prob_b"))
    if pa is None:
        pa = _f(r.get("prob_a"))
    if pb is None:
        pb = _f(r.get("prob_b"))
    if pa is None and r.get("platform_a"):
        pa = _f(r.get(f"{r['platform_a']}_dem"))
    if pb is None and r.get("platform_b"):
        pb = _f(r.get(f"{r['platform_b']}_dem"))
    return pa, pb


def _normalize_race(r: dict, source_id: str) -> dict | None:
    """Pick the fields the dashboard needs; skip rows missing essentials."""
    if r.get("arb_type") != "guaranteed":
        return None
    if any(r.get(k) in (None, "") for k in ("platform_a", "platform_b", "url_a", "url_b")):
        return None
    prob_a, prob_b = _display_probs(r)
    if prob_a is None or prob_b is None:
        return None
    # Defensive: drop rows whose links aren't real http(s) URLs. Protects
    # against a compromised upstream injecting javascript:/data: URIs that
    # would otherwise reach the dashboard's anchor hrefs.
    for k in ("url_a", "url_b"):
        u = str(r[k])
        if not (u.startswith("https://") or u.startswith("http://")):
            return None
    # Filter on locked return (real fillable-ask basket math upstream).
    ret = _to_float(r.get("guaranteed_return_pct"))
    if ret is None or ret < MIN_RETURN_PCT or ret > MAX_RETURN_PCT:
        return None
    gap_pp = abs(prob_a - prob_b) * 100.0
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
        "prob_a":     prob_a,
        "prob_b":     prob_b,
        "stake_a":    _to_float(r.get("stake_a_dollars")),
        "stake_b":    _to_float(r.get("stake_b_dollars")),
        "return_pct": ret,
        "gap_pp":     gap_pp,
        "settle_date": r.get("settle_date", ""),
        # Present on polling-agg rows (2026-07-03+); None elsewhere. The
        # annualized number is the "sooner they cash" ranking metric.
        "days_to_settle": _to_float(r.get("days_to_settle")),
        "annualized_return_pct": _to_float(r.get("annualized_return_pct")),
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

    # Sort: non-suspicious first, then by locked return % desc (matches
    # the upstream dashboards' ranking since 2026-07-04).
    arbs.sort(key=lambda a: (a["suspicious"], -(a["return_pct"] or 0)))

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
