# Manual ADP Upload Playbook

What to do when the daily auto-pull breaks and the user provides hand-pulled CSVs from DK / UD.

This is the **canonical procedure** — when the user says some variant of "the pull failed, here are the manual CSVs," Claude MUST follow this file rather than improvising. Future Claude sessions: read this end-to-end before touching any data.

**Note (2026-07-31):** FFPC and Drafters were archived. The site now only tracks DK and UD. The old ffpc_adp_history.csv + drafters_adp_history.csv are in `_local/archive/` if we ever bring those sources back. Any references below to FFPC or Drafters in the CSV / dashboard / puller code have been removed. If a manual upload day ever includes an FFPC or Drafters file, flag it and ask the user whether they want to bring those sources back into the site before proceeding.

---

## When this applies

The site's daily cron (`pull_adp.py`) fetches a Google Sheet that occasionally freezes. The cron has a **staleness detector** that:

1. Compares today's fetched ADPs to the previous auto pull for DK and UD
2. Only exits with a failure (which emails the user) when BOTH sources look frozen — partial freezes just carry values forward silently
3. Always writes `latest.json`; stale sources get their values carried forward from the prior snapshot

When the user gets the failure email (or the site otherwise looks stuck), they pull rankings exports directly from DK and UD native sites and drop the CSVs in the repo root (or `_local/manual-snapshots/`).

---

## Two ways to run it

**Option A — user runs the notebook themselves:** `scripts/manual_update.ipynb`. Open in Jupyter or VS Code, edit the CONFIG cell (date + 2 filenames), Run All. The notebook does every step below and commits/pushes at the end.

**Option B — Claude runs it via the CLI procedure below.** This is what happens when the user says "manual files are dropped, update the website" without opening the notebook themselves.

Both paths do the same thing. Keep them in sync — if you change the procedure below, update the notebook cells too.

---

## Procedure (CLI, for Claude)

### 1. Find the dropped files

```bash
ls -lat "c:/Users/pjmer/Documents/EZ Dubs Website" | head -10
```

Expected filenames (they vary slightly day-to-day — match by content not filename):
- `Underdog Rankings*.csv` or `rankings-*.csv` (may have a date suffix like `0629`)
- `DkPreDraftRankings(NN).csv` (NN increments)

### 2. Sync with remote first

The morning cron already pushed today's (stale) auto rows. Your local copy is behind. Sync before doing anything:

```bash
cd "c:/Users/pjmer/Documents/EZ Dubs Website" && git pull --ff-only
```

Then verify what's currently in the history files for today's date:

```bash
py -c "
import csv
for src in ['dk','ud']:
    rows = list(csv.DictReader(open(f'dashboards/best-ball-prices/{src}_adp_history.csv')))
    today = [r for r in rows if r['date'] == 'YYYY-MM-DD']  # << today
    by_source = {}
    for r in today: by_source[r['source']] = by_source.get(r['source'], 0) + 1
    print(f'{src} YYYY-MM-DD: {by_source}')
"
```

Expected: each source shows `{'auto': N}` from the morning cron's stale write. If you see `manual` rows already, the upload was already done today — STOP and ask the user.

### 3. Verify DK is NFL (NOT MLB)

This exists because a DK MLB export slipped through once. NFL positions are QB/RB/WR/TE; MLB positions are P/IF/OF.

```bash
py -c "
import csv
from collections import Counter
rows = list(csv.DictReader(open('DkPreDraftRankings(NN).csv')))
positions = Counter()
for r in rows:
    if r.get('ADP', '').strip(): positions[r.get('Position', '?')] += 1
print(positions)
"
```

If you see P/IF/OF, STOP and ask the user for the NFL export.

### 4. Move drops into `_local/manual-snapshots/`

Use a date prefix (MMDD) to avoid filename collisions with previous days:

```bash
mv "Underdog Rankings*.csv" "_local/manual-snapshots/MMDD Underdog Rankings*.csv"
mv "DkPreDraftRankings*.csv" "_local/manual-snapshots/MMDD DkPreDraftRankings*.csv"
```

This directory is gitignored. The raw drop CSVs are not committed (the long-format history files capture all the real data).

### 5. Clone the previous day's one-off script

Each day gets its own dated script in `scripts/` for traceability. Naming: `one_off_manual_snapshot_YYYY_MM_DD.py`.

```bash
ls scripts/one_off_manual_snapshot_*.py | tail -3
cp scripts/one_off_manual_snapshot_2026_MM_NN.py scripts/one_off_manual_snapshot_2026_MM_MM+1.py
```

Then edit the new script — bump `TODAY`, update the two DROP filenames (matching what you moved into `_local/manual-snapshots/`).

### 6. Strip today's stale auto rows for DK and UD

```bash
py -c "
import csv
for src in ['dk','ud']:
    path = f'dashboards/best-ball-prices/{src}_adp_history.csv'
    rows = list(csv.DictReader(open(path, encoding='utf-8')))
    before = len(rows)
    keep = [r for r in rows if not (r['date'] == 'YYYY-MM-DD' and r['source'] == 'auto')]
    print(f'{src}: removed {before - len(keep)} stale auto rows')
    with open(path, 'w', encoding='utf-8', newline='') as f:
        w = csv.DictWriter(f, fieldnames=['date','name','pos','team','adp','source'], lineterminator='\n')
        w.writeheader()
        for r in keep: w.writerow(r)
"
```

### 7. Run today's script

```bash
py scripts/one_off_manual_snapshot_YYYY_MM_DD.py
```

Expected output:
```
DK: appended ~380 manual rows -> dk_adp_history.csv
UD: appended ~295 manual rows -> ud_adp_history.csv
Rewrote latest.json (~410 players, date=YYYY-MM-DD).
```

Sanity ranges (gut-check today's pull):
- **DK**: ~380 ranked players. If you see >1000, the sentinel filter is wrong.
- **UD**: ~295 ranked players.
- **latest.json**: ~400 total unique players. If <300 or >600, something's off.

### 8. Verify

```bash
py -c "
import json
d = json.load(open('dashboards/best-ball-prices/latest.json'))
from collections import Counter
sources = Counter()
for p in d['players']:
    for s in p['adps']: sources[s] += 1
print(f'date={d[\"date\"]}  players={len(d[\"players\"])}  sources={dict(sources)}')
print('top 3:')
for p in d['players'][:3]:
    print(f'  {p[\"name\"]} ({p[\"pos\"]} {p[\"team\"]}): {p[\"adps\"]}')
"
```

The top 3 should be some ordering of: Jahmyr Gibbs (RB DET), Bijan Robinson (RB ATL), Ja'Marr Chase (WR CIN), Puka Nacua (WR LAR). If the top is something unfamiliar, the sentinel handling broke — STOP and debug before pushing.

### 9. Commit and push (targeted `git add`, never `-A`)

```bash
git add dashboards/best-ball-prices/dk_adp_history.csv \
        dashboards/best-ball-prices/ud_adp_history.csv \
        dashboards/best-ball-prices/latest.json \
        scripts/one_off_manual_snapshot_YYYY_MM_DD.py
git commit -m "Manual YYYY-MM-DD ADP snapshot for DK, UD

[1-2 sentence summary]

Counts:
  DK: NNN manual
  UD: NNN manual
"
git pull --rebase && git push
```

---

## Important rules

- **Append-only.** Never delete historical rows from prior dates. Today's stale auto rows for sources getting a manual override are the one allowed exception.
- **Don't commit raw drop CSVs.** They go to `_local/manual-snapshots/`, which is gitignored.
- **Don't touch the legacy repo** at `c:/Users/pjmer/Documents/AI Testing/best-ball-adp-arbitrage-testing/`.
- **The dashboard prefers manual over auto for the same date.** So if a stale auto row survives alongside a fresh manual row, the dashboard does the right thing anyway. Still clean the auto out for clarity.
- **FFPC / Drafters files:** archived 2026-07-31. If the user hands you one, don't process it silently — ask whether they want to bring the source back into the site.

---

## Schema reference

### Long-format history files

Path: `dashboards/best-ball-prices/{dk,ud}_adp_history.csv`

Schema: `date, name, pos, team, adp, source`

Example: `2026-07-29,Jahmyr Gibbs,RB,DET,1.2,manual`

### Drop file schemas

**Underdog** (`Underdog Rankings*.csv` or `rankings-*.csv`):
- Columns: `id, firstName, lastName, adp, projectedPoints, salary, positionRank, slotName, teamName, lineupStatus, byeWeek` (plus possibly a leading `playerId` column)
- Name: `firstName + ' ' + lastName`
- Pos: `slotName`
- Team: `teamName` (FULL name like "Detroit Lions") — needs mapping to 3-letter code via the `NFL_TEAM_CODE` dict in the one-off script
- ADP: `adp` (blank = unranked, drop the row)
- Sentinel floor: 216

**DraftKings** (`DkPreDraftRankings(NN).csv`):
- Columns: `ID, Name, Position, ADP, Team, , Instructions` (the trailing instructions column is a Google Sheet artifact — ignore)
- Name: `Name`
- Pos: `Position`
- Team: `Team` (already 3-letter)
- ADP: `ADP` (7-decimal precision, round to 1 decimal)
- Sentinel floor: 240
