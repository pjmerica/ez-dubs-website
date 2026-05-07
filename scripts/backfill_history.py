"""
One-shot migration: read all per-day CSVs from
dashboards/adp-arbitrage/data/{manual,auto}/, write them as long-format rows
into dk_adp_history.csv and ud_adp_history.csv, then delete the per-day data/
tree (everything is in the two stacked files now).

Idempotent: if the histories already exist, refuses to clobber them; delete
them first if you really mean to rerun.
"""

from __future__ import annotations

import csv
import re
import shutil
import sys
from pathlib import Path

from pull_adp import (
    DASHBOARD_DIR, DK_HISTORY, UD_HISTORY, STACKED_HEADER, _append_history
)

DATA_DIR = DASHBOARD_DIR / "data"

DATE_RE = re.compile(r"_(\d{4}-\d{2}-\d{2})\.csv$")


def _read_dk_csv(path: Path, date: str, source: str) -> list[list[str]]:
    """DK schema: ID,Name,Position,ADP,Team,,Instructions  (cols 1..4 used)"""
    out: list[list[str]] = []
    with path.open("r", encoding="utf-8", newline="") as f:
        r = csv.reader(f)
        next(r, None)  # header
        for row in r:
            if len(row) < 5:
                continue
            name, pos, adp, team = row[1].strip(), row[2].strip(), row[3].strip(), row[4].strip()
            if not name or not adp:
                continue
            out.append([date, name, pos, team, adp, source])
    return out


def _read_ud_csv(path: Path, date: str, source: str) -> list[list[str]]:
    """UD schema: id,firstName,lastName,adp,projectedPoints,positionRank,slotName,teamName,..."""
    out: list[list[str]] = []
    with path.open("r", encoding="utf-8", newline="") as f:
        r = csv.reader(f)
        next(r, None)  # header
        for row in r:
            if len(row) < 8:
                continue
            first, last, adp, pos, team = row[1].strip(), row[2].strip(), row[3].strip(), row[6].strip(), row[7].strip()
            name = (first + " " + last).strip()
            if not name or not adp:
                continue
            out.append([date, name, pos, team, adp, source])
    return out


def _collect(side: str, reader) -> list[list[str]]:
    rows: list[list[str]] = []
    for source in ("manual", "auto"):
        src_dir = DATA_DIR / source
        if not src_dir.exists():
            continue
        for path in sorted(src_dir.glob(f"{side}_adp_*.csv")):
            m = DATE_RE.search(path.name)
            if not m:
                continue
            rows.extend(reader(path, m.group(1), source))
    return rows


def main() -> int:
    if DK_HISTORY.exists() or UD_HISTORY.exists():
        print(f"History files already exist; refusing to overwrite. Delete "
              f"{DK_HISTORY.name} and {UD_HISTORY.name} first if you mean it.",
              file=sys.stderr)
        return 1

    dk_rows = _collect("dk", _read_dk_csv)
    ud_rows = _collect("ud", _read_ud_csv)

    # _append_history writes the header on first append.
    _append_history(DK_HISTORY, dk_rows)
    _append_history(UD_HISTORY, ud_rows)
    print(f"Wrote {len(dk_rows)} DK rows -> {DK_HISTORY.name}")
    print(f"Wrote {len(ud_rows)} UD rows -> {UD_HISTORY.name}")

    if DATA_DIR.exists():
        shutil.rmtree(DATA_DIR)
        print(f"Removed {DATA_DIR}")

    snap = DASHBOARD_DIR / "SNAPSHOTS.json"
    if snap.exists():
        snap.unlink()
        print(f"Removed {snap}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
