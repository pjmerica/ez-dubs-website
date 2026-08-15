"""
One-off: snapshot today's UD + DK ADPs from two CSVs the user dropped at the
repo root. This is the first one-off after the 2026-07-31 cleanup that
archived FFPC and Drafters -- the site now only tracks DK and UD.

Writes source=manual rows for 2026-08-01 to:
  dashboards/best-ball-prices/dk_adp_history.csv
  dashboards/best-ball-prices/ud_adp_history.csv

Then rebuilds dashboards/best-ball-prices/latest.json so the Price
Differences table view picks up today's fresh values immediately.

Safe to re-run: per-file (date, source=manual) check makes it idempotent.
"""

from __future__ import annotations

import csv
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT     = Path(__file__).resolve().parents[1]
DASHBOARD_DIR = REPO_ROOT / "dashboards" / "best-ball-prices"

TODAY = "2026-08-15"

UD_DROP = REPO_ROOT / "_local" / "manual-snapshots" / "0815 rankings-a9c04e81-1ace-4b16-a31d-4c725a47f16f-ccf300b0-9197-5951-bd96-cba84ad71e86(32).csv"
DK_DROP = REPO_ROOT / "_local" / "manual-snapshots" / "0815 DkPreDraftRankings(62).csv"

DK_HISTORY      = DASHBOARD_DIR / "dk_adp_history.csv"
UD_HISTORY      = DASHBOARD_DIR / "ud_adp_history.csv"
LATEST_SNAPSHOT = DASHBOARD_DIR / "latest.json"

STACKED_HEADER = ["date", "name", "pos", "team", "adp", "source"]
ADP_FLOORS = {"DK": 240.0, "UD": 216.0}

# UD provides full team names; the rest of the system uses 3-letter codes.
NFL_TEAM_CODE = {
    "Arizona Cardinals": "ARI", "Atlanta Falcons": "ATL", "Baltimore Ravens": "BAL",
    "Buffalo Bills": "BUF", "Carolina Panthers": "CAR", "Chicago Bears": "CHI",
    "Cincinnati Bengals": "CIN", "Cleveland Browns": "CLE", "Dallas Cowboys": "DAL",
    "Denver Broncos": "DEN", "Detroit Lions": "DET", "Green Bay Packers": "GB",
    "Houston Texans": "HOU", "Indianapolis Colts": "IND", "Jacksonville Jaguars": "JAX",
    "Kansas City Chiefs": "KC", "Las Vegas Raiders": "LV", "Los Angeles Chargers": "LAC",
    "Los Angeles Rams": "LAR", "Miami Dolphins": "MIA", "Minnesota Vikings": "MIN",
    "New England Patriots": "NE", "New Orleans Saints": "NO", "New York Giants": "NYG",
    "New York Jets": "NYJ", "Philadelphia Eagles": "PHI", "Pittsburgh Steelers": "PIT",
    "San Francisco 49ers": "SF", "Seattle Seahawks": "SEA", "Tampa Bay Buccaneers": "TB",
    "Tennessee Titans": "TEN", "Washington Commanders": "WAS",
}

# Suffix + alias normalization -- keep in sync with pull_adp.py and the JS.
_SUFFIX_RE = re.compile(r"\s+(jr|sr|i{1,3}|iv|v|1st|2nd|3rd|4th|5th)\.?$", re.IGNORECASE)
_FIRST_NAME_ALIASES = {
    "kenneth": "kenny",  # Kenny Gainwell (UD) vs Kenneth Gainwell (DK)
}
def normalize_player_name(name: str) -> str:
    n = (name or "").lower().replace(".", "").replace("'", "")
    n = _SUFFIX_RE.sub("", n)
    n = _SUFFIX_RE.sub("", n)
    n = re.sub(r"\s+", " ", n).strip()
    if " " in n:
        first, rest = n.split(" ", 1)
        first = _FIRST_NAME_ALIASES.get(first, first)
        n = f"{first} {rest}"
    return n


def _append_history(path: Path, rows: list[list[str]]) -> None:
    new_file = not path.exists()
    with path.open("a", encoding="utf-8", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        if new_file:
            w.writerow(STACKED_HEADER)
        w.writerows(rows)


def _date_already_in_history(path: Path, date: str, source: str) -> bool:
    if not path.exists():
        return False
    with path.open("r", encoding="utf-8", newline="") as f:
        r = csv.reader(f)
        header = next(r, None)
        if not header:
            return False
        try:
            d_idx = header.index("date")
            s_idx = header.index("source")
        except ValueError:
            return False
        for row in r:
            if len(row) > max(d_idx, s_idx) and row[d_idx] == date and row[s_idx] == source:
                return True
    return False


def parse_ud(path: Path) -> list[list[str]]:
    out = []
    with path.open(encoding="utf-8", newline="") as f:
        for r in csv.DictReader(f):
            try:
                adp = float(r["adp"])
            except (TypeError, ValueError):
                continue
            if adp >= ADP_FLOORS["UD"]:
                continue
            name = (r["firstName"].strip() + " " + r["lastName"].strip()).strip()
            pos  = (r.get("slotName") or "").strip()
            team_full = (r.get("teamName") or "").strip()
            team = NFL_TEAM_CODE.get(team_full, "")
            if not name:
                continue
            out.append([TODAY, name, pos, team, f"{adp:.1f}", "manual"])
    return out


def parse_dk(path: Path) -> list[list[str]]:
    out = []
    with path.open(encoding="utf-8", newline="") as f:
        for r in csv.DictReader(f):
            try:
                adp = float(r["ADP"])
            except (TypeError, ValueError):
                continue
            if adp >= ADP_FLOORS["DK"]:
                continue
            name = (r.get("Name") or "").strip()
            pos  = (r.get("Position") or "").strip()
            team = (r.get("Team") or "").strip()
            if not name:
                continue
            out.append([TODAY, name, pos, team, f"{adp:.1f}", "manual"])
    return out


def _rebuild_latest(today: str) -> dict:
    """Merge today's manual DK+UD rows across sources into latest.json.

    Merge keyed by normalize_player_name. Display name picked to prefer alias
    TARGETS ("Kenny" over "Kenneth"), then longest variant so "Marvin Harrison
    Jr." beats "Marvin Harrison". Same rules as pull_adp.py's
    _build_latest_snapshot.
    """
    source_paths = {"DK": DK_HISTORY, "UD": UD_HISTORY}
    by_src_today: dict[str, dict[str, dict]] = {}
    for src, path in source_paths.items():
        rows = list(csv.DictReader(path.open(encoding="utf-8", newline="")))
        manual = [r for r in rows if r["date"] == today and r["source"] == "manual"]
        auto   = [r for r in rows if r["date"] == today and r["source"] == "auto"]
        chosen = manual or auto
        by_src_today[src] = {normalize_player_name(r["name"]): r for r in chosen if normalize_player_name(r["name"])}

    _ALIAS_TARGETS = set(_FIRST_NAME_ALIASES.values())
    _ALIAS_SOURCES = set(_FIRST_NAME_ALIASES.keys())
    def _pick_display(current, incoming):
        def _first(s):
            return s.strip().split(" ", 1)[0].lower().rstrip(".").replace("'", "")
        cur_first, inc_first = _first(current), _first(incoming)
        if inc_first in _ALIAS_TARGETS and cur_first in _ALIAS_SOURCES: return incoming
        if cur_first in _ALIAS_TARGETS and inc_first in _ALIAS_SOURCES: return current
        return incoming if len(incoming) > len(current) else current

    by_key: dict[str, dict] = {}
    for src in ("DK", "UD"):
        for key, row in by_src_today[src].items():
            entry = by_key.setdefault(key, {
                "name": row["name"],
                "pos":  row["pos"],
                "team": row["team"],
                "adps": {},
            })
            entry["name"] = _pick_display(entry["name"], row["name"])
            try:
                val = float(row["adp"])
            except ValueError:
                continue
            if val <= 0:
                continue
            if val >= ADP_FLOORS.get(src, float("inf")):
                continue
            entry["adps"][src] = val
            if not entry["pos"]  and row.get("pos"):  entry["pos"]  = row["pos"]
            if not entry["team"] and row.get("team"): entry["team"] = row["team"]

    players = [p for p in by_key.values() if p["adps"]]
    players.sort(key=lambda p: min(p["adps"].values()))

    return {
        "pulled_at":     datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "date":          today,
        "players":       players,
        "stale_sources": [],
        "stale_since":   {},
    }


def main() -> int:
    plan = [
        ("DK", DK_HISTORY, parse_dk(DK_DROP)),
        ("UD", UD_HISTORY, parse_ud(UD_DROP)),
    ]
    for label, path, rows in plan:
        if _date_already_in_history(path, TODAY, "manual"):
            print(f"{label}: manual rows for {TODAY} already present; skipping append.")
            continue
        if not rows:
            print(f"{label}: 0 parsed rows; SKIP (likely a schema mismatch).", file=sys.stderr)
            continue
        _append_history(path, rows)
        print(f"{label}: appended {len(rows)} manual rows -> {path.name}")

    snapshot = _rebuild_latest(TODAY)
    LATEST_SNAPSHOT.write_text(
        json.dumps(snapshot, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    print(f"Rewrote {LATEST_SNAPSHOT.name} ({len(snapshot['players'])} players, date={snapshot['date']}).")

    return 0


if __name__ == "__main__":
    sys.exit(main())
