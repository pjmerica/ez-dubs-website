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
DASHBOARD_DIR  = REPO_ROOT / "dashboards" / "adp-arbitrage"
DK_HISTORY     = DASHBOARD_DIR / "dk_adp_history.csv"
UD_HISTORY     = DASHBOARD_DIR / "ud_adp_history.csv"

# Local-only daily snapshots kept for QC. Gitignored.
LOCAL_DIR      = REPO_ROOT / "_local" / "adp-daily"

# Anything dated on or after this is post-draft. Surfaced in the dashboard.
DRAFT_CUTOVER_DATE = "2026-04-24"

STACKED_HEADER = ["date", "name", "pos", "team", "adp", "source"]

_REQUIRED_COLS = ("Name", "Pos", "Team", "UD ADP", "DK ADP")


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


# ---- Main -----------------------------------------------------------------

def main() -> int:
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    rows = fetch_sheet_rows()
    if not rows:
        print("Sheet returned no rows; aborting.", file=sys.stderr)
        return 1

    _write_local_qc(rows, today)

    if _date_already_in_history(DK_HISTORY, today, "auto"):
        print(f"DK history already has auto rows for {today}; skipping append.")
    else:
        dk_rows = _build_rows(rows, "DK ADP", today, "auto")
        _append_history(DK_HISTORY, dk_rows)
        print(f"Appended {len(dk_rows)} DK rows to {DK_HISTORY.name}.")

    if _date_already_in_history(UD_HISTORY, today, "auto"):
        print(f"UD history already has auto rows for {today}; skipping append.")
    else:
        ud_rows = _build_rows(rows, "UD ADP", today, "auto")
        _append_history(UD_HISTORY, ud_rows)
        print(f"Appended {len(ud_rows)} UD rows to {UD_HISTORY.name}.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
