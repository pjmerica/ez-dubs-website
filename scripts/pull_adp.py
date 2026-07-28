"""
Daily ADP puller.

Fetches the public Google Sheet, writes today's local QC CSVs (gitignored),
and appends today's rows to the committed long-format stacked files
dk_adp_history.csv and ud_adp_history.csv.

Run manually: py scripts/pull_adp.py
Run via Actions: see .github/workflows/daily-adp-pull.yml
"""

from __future__ import annotations

import csv
import io
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

# ---- Config ---------------------------------------------------------------

SHEET_ID = "1OMi92b1Glfb3Q8s48h4DotP6_9DQb5UwnwFELjpuccs"
GID      = "420942436"
SHEET_CSV_URL = (
    f"https://docs.google.com/spreadsheets/d/{SHEET_ID}/export"
    f"?format=csv&gid={GID}"
)

REPO_ROOT      = Path(__file__).resolve().parents[1]
DASHBOARD_DIR  = REPO_ROOT / "dashboards" / "best-ball-prices"
DK_HISTORY     = DASHBOARD_DIR / "dk_adp_history.csv"
UD_HISTORY     = DASHBOARD_DIR / "ud_adp_history.csv"
FFPC_HISTORY      = DASHBOARD_DIR / "ffpc_adp_history.csv"
DRAFTERS_HISTORY  = DASHBOARD_DIR / "drafters_adp_history.csv"
LAST_PULL_META    = DASHBOARD_DIR / "last_pull.json"
LATEST_SNAPSHOT   = DASHBOARD_DIR / "latest.json"

# Sentinel floor values for "undrafted" rows. Anything at or above the floor
# is treated as no real ADP. Matches the constants in the dashboard JS.
ADP_FLOORS = {"DK": 240.0, "UD": 216.0, "FFPC": float("inf"), "Drafters": float("inf")}

# Local-only daily snapshots kept for QC. Gitignored.
LOCAL_DIR      = REPO_ROOT / "_local" / "adp-daily"

# Anything dated on or after this is post-draft. Surfaced in the dashboard.
DRAFT_CUTOVER_DATE = "2026-04-24"

STACKED_HEADER = ["date", "name", "pos", "team", "adp", "source"]

_REQUIRED_COLS = ("Name", "Pos", "Team", "UD ADP", "DK ADP", "FFPC ADP", "Drafters ADP")


# ---- Sheet fetch ----------------------------------------------------------

def fetch_sheet_rows() -> list[list[str]]:
    resp = requests.get(SHEET_CSV_URL, timeout=30)
    resp.raise_for_status()
    return list(csv.reader(io.StringIO(resp.text)))


def _index_columns(header_row: list[str]) -> dict[str, int]:
    idx = {h: i for i, h in enumerate(header_row)}
    missing = [h for h in _REQUIRED_COLS if h not in idx]
    if missing:
        raise ValueError(f"Sheet header missing required columns: {missing}")
    return idx


# ---- Stacked-file append --------------------------------------------------

def _append_history(path: Path, rows: list[list[str]]) -> None:
    new_file = not path.exists()
    with path.open("a", encoding="utf-8", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        if new_file:
            w.writerow(STACKED_HEADER)
        w.writerows(rows)


def _date_already_in_history(path: Path, date: str, source: str) -> bool:
    """Return True if this (date, source) pair is already represented in the file."""
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


import re as _re

# Strips punctuation and common name suffixes so cross-source rows collapse
# ('Marvin Harrison Jr.' == 'Marvin Harrison' == 'marvin harrison jr'). Matches
# the JS normalizeName() in dashboards/best-ball-prices/index.html; keep them in sync.
_SUFFIX_RE = _re.compile(r"\s+(jr|sr|i{1,3}|iv|v|1st|2nd|3rd|4th|5th)\.?$", _re.IGNORECASE)

# Hand-curated first-name aliases: sources disagree on formal vs nickname.
# Left side is what one source writes, right side is what we normalize to.
# Add new entries here as mismatches are spotted; the list is small on purpose
# to avoid accidentally merging distinct players. Expect to refresh yearly as
# the player pool turns over.
_FIRST_NAME_ALIASES = {
    "kenneth": "kenny",   # Kenny Gainwell (UD/Drafters) vs Kenneth Gainwell (DK/FFPC)
}

def normalize_player_name(name: str) -> str:
    n = (name or "").lower().replace(".", "").replace("'", "")
    # Two passes so 'John Smith III Jr' (rare) still collapses fully.
    n = _SUFFIX_RE.sub("", n)
    n = _SUFFIX_RE.sub("", n)
    n = _re.sub(r"\s+", " ", n).strip()
    # Alias only the first token (the first name).
    if " " in n:
        first, rest = n.split(" ", 1)
        first = _FIRST_NAME_ALIASES.get(first, first)
        n = f"{first} {rest}"
    return n


def _build_latest_snapshot(
    sheet_rows: list[list[str]],
    today: str,
    carry_forward_sources: set[str] | None = None,
) -> dict:
    """Merge today's ADPs across all sources into one player-keyed snapshot.

    Output schema:
      {pulled_at, date, players: [{name, pos, team, adps: {DK, UD, FFPC, Drafters}}]}

    Sentinel-floored ADPs (e.g. DK 240, UD 216) are omitted from the adps map.
    Players are sorted by min ADP across their available sources so the table
    view is roughly draft order out of the gate.

    Merge is keyed by normalize_player_name so suffix inconsistencies across
    sources ('Marvin Harrison Jr.' vs 'Marvin Harrison') collapse to one player.
    The longest name variant seen wins as the display name.

    carry_forward_sources: source labels whose values are known-stale in the
    fetched sheet. Their columns are skipped from the merge; instead we splice
    in values from the CURRENT latest.json (if it exists) so the dashboard
    keeps showing the last-known-good numbers for those sources.
    """
    carry_forward_sources = carry_forward_sources or set()
    cols = _index_columns(sheet_rows[0])
    source_cols = {
        "DK":       "DK ADP",
        "UD":       "UD ADP",
        "FFPC":     "FFPC ADP",
        "Drafters": "Drafters ADP",
    }
    _ALIAS_TARGETS = set(_FIRST_NAME_ALIASES.values())
    _ALIAS_SOURCES = set(_FIRST_NAME_ALIASES.keys())

    def _pick_display(current: str, incoming: str) -> str:
        """Choose the better display name between two variants.

        Rules, in priority order:
          1. Prefer any variant whose first name is the alias TARGET
             (e.g. 'Kenny' beats 'Kenneth' when 'kenneth' -> 'kenny').
          2. Otherwise, prefer the longer variant (captures 'Jr.'/'III').
        """
        def _first(s: str) -> str:
            return s.strip().split(" ", 1)[0].lower().rstrip(".").replace("'", "")
        cur_first, inc_first = _first(current), _first(incoming)
        cur_is_target = cur_first in _ALIAS_TARGETS
        inc_is_target = inc_first in _ALIAS_TARGETS
        cur_is_source = cur_first in _ALIAS_SOURCES
        inc_is_source = inc_first in _ALIAS_SOURCES
        if inc_is_target and cur_is_source:
            return incoming
        if cur_is_target and inc_is_source:
            return current
        return incoming if len(incoming) > len(current) else current

    by_key: dict[str, dict] = {}
    for row in sheet_rows[1:]:
        if not row or len(row) <= cols["Name"]:
            continue
        name = row[cols["Name"]].strip()
        if not name:
            continue
        key = normalize_player_name(name)
        if not key:
            continue
        entry = by_key.setdefault(key, {
            "name": name,
            "pos":  row[cols["Pos"]].strip() if len(row) > cols["Pos"] else "",
            "team": row[cols["Team"]].strip() if len(row) > cols["Team"] else "",
            "adps": {},
        })
        entry["name"] = _pick_display(entry["name"], name)
        for src_id, col_name in source_cols.items():
            if src_id in carry_forward_sources:
                continue  # skip stale source; will splice from old snapshot below
            ci = cols.get(col_name)
            if ci is None or len(row) <= ci:
                continue
            raw = row[ci].strip()
            if not raw:
                continue
            try:
                val = float(raw)
            except ValueError:
                continue
            if val >= ADP_FLOORS.get(src_id, float("inf")):
                continue  # sentinel
            entry["adps"][src_id] = val

    # Splice stale sources' last-known-good values from the current latest.json.
    # Keyed by normalized name to survive suffix/nickname variations between
    # the old snapshot and today's sheet. Also let the old snapshot's display
    # name win when it's a better variant (e.g. 'Marvin Harrison Jr.' vs the
    # sheet's 'Marvin Harrison'), applying the same _pick_display rules.
    if LATEST_SNAPSHOT.exists():
        old = json.loads(LATEST_SNAPSHOT.read_text(encoding="utf-8"))
        old_by_key: dict[str, dict] = {}
        for p in old.get("players", []):
            k = normalize_player_name(p["name"])
            if k:
                old_by_key[k] = p
        for key, entry in by_key.items():
            old_p = old_by_key.get(key)
            if not old_p:
                continue
            # Always let the old display name compete (preserves aliases + suffixes).
            entry["name"] = _pick_display(entry["name"], old_p.get("name", ""))
            # Only splice ADP values for the stale sources.
            for src in carry_forward_sources:
                v = old_p.get("adps", {}).get(src)
                if isinstance(v, (int, float)) and v < ADP_FLOORS.get(src, float("inf")):
                    entry["adps"][src] = float(v)

    # Drop players with zero usable ADPs (all sources were missing or sentinels).
    players = [p for p in by_key.values() if p["adps"]]
    # Stable sort by min ADP across present sources.
    players.sort(key=lambda p: min(p["adps"].values()))

    return {
        "pulled_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "date":      today,
        "players":   players,
    }


def _build_rows(sheet_rows: list[list[str]], adp_col: str, date: str, source: str) -> list[list[str]]:
    cols = _index_columns(sheet_rows[0])
    out: list[list[str]] = []
    for row in sheet_rows[1:]:
        if not row or len(row) <= cols[adp_col]:
            continue
        name = row[cols["Name"]].strip()
        adp  = row[cols[adp_col]].strip()
        if not name or not adp:
            continue
        out.append([date, name, row[cols["Pos"]], row[cols["Team"]], adp, source])
    return out


# ---- Local QC dump --------------------------------------------------------

def _write_local_qc(sheet_rows: list[list[str]], date: str) -> None:
    """Drop today's raw CSV locally so I can spot-check before trusting auto."""
    LOCAL_DIR.mkdir(parents=True, exist_ok=True)
    path = LOCAL_DIR / f"sheet_{date}.csv"
    with path.open("w", encoding="utf-8", newline="") as f:
        csv.writer(f, lineterminator="\n").writerows(sheet_rows)
    print(f"Wrote local QC copy: {path}")


# ---- Staleness check ------------------------------------------------------

# If >95% of today's ADPs match the most-recent prior auto pull byte-for-byte
# AND we have at least this many overlapping players, treat as upstream freeze.
STALE_THRESHOLD_PCT = 95.0
STALE_MIN_OVERLAP   = 50


def _previous_auto_day_map(path: Path, today: str) -> dict[str, str]:
    """Return {name: adp_string} for the most recent auto pull strictly before `today`.

    Reads the history CSV once, picks rows whose date < today and source='auto',
    bins by date, returns the highest date's bin. Empty dict if no prior pull.
    """
    if not path.exists():
        return {}
    by_date: dict[str, dict[str, str]] = {}
    with path.open("r", encoding="utf-8", newline="") as f:
        for r in csv.DictReader(f):
            if r.get("source") != "auto":
                continue
            d = r.get("date") or ""
            if not d or d >= today:
                continue
            by_date.setdefault(d, {})[r["name"]] = r["adp"]
    if not by_date:
        return {}
    last = max(by_date.keys())
    return by_date[last]


def _check_staleness(sheet_rows: list[list[str]], today: str) -> tuple[list[str], set[str]]:
    """Compare today's parsed ADPs to the previous auto pull for each source.

    Returns (warnings, stale_sources) where:
      - warnings: human-readable strings, one per stale source (empty if all fresh)
      - stale_sources: set of source labels ("DK", "UD", ...) that were flagged

    A source is flagged when:
      - we have >= STALE_MIN_OVERLAP players in common with the previous pull, AND
      - >= STALE_THRESHOLD_PCT of those overlapping ADPs are identical
    """
    cols = _index_columns(sheet_rows[0])
    sources = [
        ("DK",       "DK ADP",       DK_HISTORY),
        ("UD",       "UD ADP",       UD_HISTORY),
        ("FFPC",     "FFPC ADP",     FFPC_HISTORY),
        ("Drafters", "Drafters ADP", DRAFTERS_HISTORY),
    ]
    warnings: list[str] = []
    stale_sources: set[str] = set()
    for label, col, path in sources:
        today_map: dict[str, str] = {}
        for row in sheet_rows[1:]:
            if not row or len(row) <= cols[col]:
                continue
            name = row[cols["Name"]].strip()
            adp  = row[cols[col]].strip()
            if not name or not adp:
                continue
            today_map[name] = adp
        prev_map = _previous_auto_day_map(path, today)
        if not prev_map or not today_map:
            continue
        overlap = set(today_map) & set(prev_map)
        if len(overlap) < STALE_MIN_OVERLAP:
            continue
        identical = sum(1 for n in overlap if today_map[n] == prev_map[n])
        pct = 100.0 * identical / len(overlap)
        print(f"  staleness check {label}: {identical}/{len(overlap)} identical ({pct:.1f}%)")
        if pct >= STALE_THRESHOLD_PCT:
            warnings.append(
                f"{label}: {pct:.1f}% of {len(overlap)} ADPs unchanged from previous auto pull "
                f"(threshold {STALE_THRESHOLD_PCT:.0f}%). Upstream feed may be frozen."
            )
            stale_sources.add(label)
    return warnings, stale_sources


# ---- Main -----------------------------------------------------------------

def main() -> int:
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    rows = fetch_sheet_rows()
    if not rows:
        print("Sheet returned no rows; aborting.", file=sys.stderr)
        return 1

    _write_local_qc(rows, today)

    sources = [
        ("DK",       "DK ADP",       DK_HISTORY),
        ("UD",       "UD ADP",       UD_HISTORY),
        ("FFPC",     "FFPC ADP",     FFPC_HISTORY),
        ("Drafters", "Drafters ADP", DRAFTERS_HISTORY),
    ]
    for label, col, path in sources:
        if _date_already_in_history(path, today, "auto"):
            print(f"{label} history already has auto rows for {today}; skipping append.")
            continue
        out_rows = _build_rows(rows, col, today, "auto")
        _append_history(path, out_rows)
        print(f"Appended {len(out_rows)} {label} rows to {path.name}.")

    # Surface a precise pull timestamp for the dashboard to display.
    LAST_PULL_META.write_text(
        json.dumps({
            "pulled_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "date":      today,
        }, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {LAST_PULL_META.name}.")

    # Detect upstream-feed freeze per source. When SOME sources are stale, we
    # still write latest.json using fresh sheet values for the good sources
    # and last-known-good values (from the current latest.json) for the stale
    # ones. The exit code still signals so GitHub Actions emails on any stale.
    warnings, stale_sources = _check_staleness(rows, today)

    snapshot = _build_latest_snapshot(rows, today, carry_forward_sources=stale_sources)
    LATEST_SNAPSHOT.write_text(
        json.dumps(snapshot, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {LATEST_SNAPSHOT.name} ({len(snapshot['players'])} players).")

    if warnings:
        print("STALE DATA DETECTED:", file=sys.stderr)
        for w in warnings:
            print(f"  - {w}", file=sys.stderr)
        print(
            f"latest.json was written using fresh sheet values for the good sources "
            f"and last-known-good values from the prior snapshot for: "
            f"{sorted(stale_sources)}. Exit 1 so the failure email fires.",
            file=sys.stderr,
        )
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
