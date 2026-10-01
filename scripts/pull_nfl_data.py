"""Mirror the NFL market data from AI_Agent_work into dashboards/nfl-start-sit/data/.

The NFL pages read seven JSON files. Those are built in pjmerica/AI_Agent_work,
which already runs the scrapers -- Kalshi ladders, The Odds API across seven
sportsbooks, the DraftKings touchdown board, game lines -- and publishes the
results to its own GitHub Pages site. This copies them across.

Mirroring rather than scraping again, deliberately:

  - The Odds API bills per event per market. Running the player-prop pull twice
    over would double the credit burn for identical numbers.
  - No ODDS_API_KEY needs to exist in this repo at all.
  - Both sites then show the same projections. Two independent pipelines would
    drift apart within a week and there would be no way to tell which was right.

Same shape as pull_pred_arbs.py, which already pulls JSON off another Pages site
on a cron.

A file is only written when its content actually changed, so the workflow commits
nothing on a no-op run.

Usage:
    python scripts/pull_nfl_data.py
    python scripts/pull_nfl_data.py --dry-run
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

BASE = "https://pjmerica.github.io/AI_Agent_work/nfl-props/"
OUT_DIR = Path(__file__).resolve().parent.parent / "dashboards" / "nfl-start-sit" / "data"

# Every file the pages fetch. A missing one is not fatal on its own -- the pages
# degrade rather than break -- but weekly.json carrying the slate is, so it is
# marked required.
FILES = [
    ("weekly.json", True),            # Kalshi per-game props; carries the week
    ("oddsapi.json", True),           # multi-book props
    ("dk_td.json", False),            # DraftKings anytime TD
    ("gamelines.json", False),        # spreads/totals -> kickers and defenses
    ("sleeper_players.json", True),   # player map + injury status
    ("clay.json", False),             # season projections, used as a fallback
    ("data.json", False),             # FantasyPros consensus, thin fallback
]

TIMEOUT = 45
# A file this small is a failed build or an error page, not data.
MIN_BYTES = 200


def fetch(name: str) -> bytes | None:
    url = BASE + name
    try:
        r = requests.get(url, timeout=TIMEOUT)
    except requests.RequestException as e:
        print(f"  {name}: request failed ({e})", file=sys.stderr)
        return None
    if r.status_code != 200:
        print(f"  {name}: HTTP {r.status_code}", file=sys.stderr)
        return None
    if len(r.content) < MIN_BYTES:
        print(f"  {name}: only {len(r.content)} bytes, treating as bad",
              file=sys.stderr)
        return None
    # Must be JSON. Pages serves a styled 404 page with status 200 in some
    # configurations, which would otherwise be written straight over good data.
    try:
        parsed = json.loads(r.content.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        print(f"  {name}: not valid JSON ({e})", file=sys.stderr)
        return None
    if not isinstance(parsed, dict):
        print(f"  {name}: JSON is {type(parsed).__name__}, expected an object",
              file=sys.stderr)
        return None
    return r.content


def describe(name: str, raw: bytes) -> str:
    try:
        d = json.loads(raw.decode("utf-8"))
    except Exception:  # noqa: BLE001
        return ""
    bits = []
    if d.get("week"):
        bits.append(f"week {d['week']}")
    n = d.get("playerCount") or d.get("gameCount")
    if n is None and isinstance(d.get("players"), list):
        n = len(d["players"])
    if n is not None:
        bits.append(f"{n} rows")
    if d.get("lastUpdated"):
        bits.append(d["lastUpdated"][:16])
    return "  (" + ", ".join(bits) + ")" if bits else ""


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="fetch and report, write nothing")
    args = ap.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Mirroring NFL data from {BASE}")

    changed, unchanged, failed, missing_required = 0, 0, 0, []
    for name, required in FILES:
        raw = fetch(name)
        if raw is None:
            failed += 1
            if required:
                missing_required.append(name)
            continue

        dest = OUT_DIR / name
        if dest.exists() and dest.read_bytes() == raw:
            print(f"  {name}: unchanged{describe(name, raw)}")
            unchanged += 1
            continue

        if args.dry_run:
            print(f"  {name}: WOULD UPDATE{describe(name, raw)}")
        else:
            dest.write_bytes(raw)
            print(f"  {name}: updated{describe(name, raw)}")
        changed += 1

    print(f"\n{changed} changed, {unchanged} unchanged, {failed} failed")

    if missing_required:
        # Leaving the old files in place is right -- the pages keep working on
        # last week's numbers and say so -- but the run should go red, because a
        # required file failing is not a normal outcome.
        print(f"ERROR: required file(s) unavailable: {', '.join(missing_required)}."
              f" Existing data left untouched.", file=sys.stderr)
        sys.exit(1)

    if changed and not args.dry_run:
        stamp = OUT_DIR / "mirrored_at.json"
        stamp.write_text(json.dumps({
            "mirrored_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "source": BASE,
            "note": ("Written by scripts/pull_nfl_data.py. The files beside this "
                     "one are mirrored from AI_Agent_work, which runs the "
                     "scrapers. Do not edit them here -- the next run overwrites "
                     "them."),
        }, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
