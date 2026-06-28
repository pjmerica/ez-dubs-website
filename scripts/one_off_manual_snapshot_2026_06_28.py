"""
One-off: snapshot today's UD, DK, Drafters ADPs from three CSVs the user
dropped at the repo root. FFPC stays stale (no source provided).

Writes source=manual rows for 2026-06-28 to:
  dashboards/best-ball-prices/dk_adp_history.csv
  dashboards/best-ball-prices/ud_adp_history.csv
  dashboards/best-ball-prices/drafters_adp_history.csv

Then rebuilds dashboards/best-ball-prices/latest.json so the Price
Differences table view picks up today's fresh values immediately.
FFPC values in latest.json are carried forward from whatever is currently
in the file (which is 2026-06-22 values frozen-in by the upstream Sheet).

Safe to re-run: per-file _date_already_in_history (date,source=manual)
check makes it idempotent.
"""

from __future__ import annotations

import csv
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT     = Path(__file__).resolve().parents[1]
DASHBOARD_DIR = REPO_ROOT / "dashboards" / "best-ball-prices"

TODAY = "2026-06-28"

UD_DROP        = REPO_ROOT / "_local" / "manual-snapshots" / "Underdog Rankings.csv"
DK_DROP        = REPO_ROOT / "_local" / "manual-snapshots" / "DkPreDraftRankings(31).csv"
DRAFTERS_DROP  = REPO_ROOT / "_local" / "manual-snapshots" / "drafters_players(1).csv"

DK_HISTORY        = DASHBOARD_DIR / "dk_adp_history.csv"
UD_HISTORY        = DASHBOARD_DIR / "ud_adp_history.csv"
DRAFTERS_HISTORY  = DASHBOARD_DIR / "drafters_adp_history.csv"
LATEST_SNAPSHOT   = DASHBOARD_DIR / "latest.json"

STACKED_HEADER = ["date", "name", "pos", "team", "adp", "source"]
ADP_FLOORS = {"DK": 240.0, "UD": 216.0, "FFPC": float("inf"), "Drafters": float("inf")}

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


def parse_drafters(path: Path) -> list[list[str]]:
    out = []
    with path.open(encoding="utf-8", newline="") as f:
        for r in csv.DictReader(f):
            try:
                adp = float(r["ADP"])
            except (TypeError, ValueError):
                continue
            # Drafters encodes "undrafted" as ADP=0 (vs UD/DK which leave it blank).
            # Treat any non-positive ADP as a sentinel and drop it.
            if adp <= 0:
                continue
            if adp >= ADP_FLOORS["Drafters"]:
                continue
            name = (r.get("name") or "").strip()
            pos  = (r.get("position") or "").strip()
            team = (r.get("team abbr") or "").strip()
            if not name:
                continue
            out.append([TODAY, name, pos, team, f"{adp:.1f}", "manual"])
    return out


def _rebuild_latest(today: str) -> dict:
    """Build the same {pulled_at, date, players[]} snapshot the puller writes.

    For DK/UD/Drafters, prefer today's manual rows (the freshly committed
    ones). For FFPC, fall back to whatever's currently in latest.json
    (which is the last-known-good FFPC values, frozen since 2026-06-22).
    """
    # Read each history file and find best per-source map for today.
    source_paths = {
        "DK":       DK_HISTORY,
        "UD":       UD_HISTORY,
        "Drafters": DRAFTERS_HISTORY,
    }
    by_src_today: dict[str, dict[str, dict]] = {}
    for src, path in source_paths.items():
        rows = list(csv.DictReader(path.open(encoding="utf-8", newline="")))
        manual = [r for r in rows if r["date"] == today and r["source"] == "manual"]
        auto   = [r for r in rows if r["date"] == today and r["source"] == "auto"]
        chosen = manual or auto
        by_src_today[src] = {r["name"].strip(): r for r in chosen}

    # Pull existing FFPC values from the current latest.json
    ffpc_carryover: dict[str, float] = {}
    if LATEST_SNAPSHOT.exists():
        old = json.loads(LATEST_SNAPSHOT.read_text(encoding="utf-8"))
        for p in old.get("players", []):
            v = p.get("adps", {}).get("FFPC")
            if isinstance(v, (int, float)):
                ffpc_carryover[p["name"]] = float(v)

    # Merge by player name across all sources we care about for this rebuild.
    by_name: dict[str, dict] = {}
    for src in ("DK", "UD", "Drafters"):
        for name, row in by_src_today[src].items():
            entry = by_name.setdefault(name, {
                "name": name,
                "pos":  row["pos"],
                "team": row["team"],
                "adps": {},
            })
            try:
                val = float(row["adp"])
            except ValueError:
                continue
            if val <= 0:
                continue
            if val >= ADP_FLOORS.get(src, float("inf")):
                continue
            entry["adps"][src] = val
            # Best available pos/team if the seed was missing them.
            if not entry["pos"]  and row.get("pos"):  entry["pos"]  = row["pos"]
            if not entry["team"] and row.get("team"): entry["team"] = row["team"]

    # Splice carried-forward FFPC values onto existing players where we can.
    for name, ffpc_adp in ffpc_carryover.items():
        if ffpc_adp >= ADP_FLOORS["FFPC"]:
            continue
        if name in by_name:
            by_name[name]["adps"]["FFPC"] = ffpc_adp
        else:
            # Player exists only in carryover. Pull pos/team from old snapshot.
            # Cheap second pass — old snapshot already in memory above.
            pass  # rare; not worth a second loop

    players = [p for p in by_name.values() if p["adps"]]
    players.sort(key=lambda p: min(p["adps"].values()))

    return {
        "pulled_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "date":      today,
        "players":   players,
    }


def main() -> int:
    plan = [
        ("DK",       DK_HISTORY,       parse_dk(DK_DROP)),
        ("UD",       UD_HISTORY,       parse_ud(UD_DROP)),
        ("Drafters", DRAFTERS_HISTORY, parse_drafters(DRAFTERS_DROP)),
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
