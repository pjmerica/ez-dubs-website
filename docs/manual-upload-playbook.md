# Manual ADP Upload Playbook

What to do when the daily auto-pull breaks and the user provides hand-pulled CSVs from DK / UD / Drafters / FFPC.

This is the **canonical procedure** — when the user says some variant of "the pull failed, here are the manual CSVs," Claude MUST follow this file rather than improvising. Future Claude sessions: read this end-to-end before touching any data.

---

## When this applies

The site's daily cron (`pull_adp.py`) fetches a Google Sheet that occasionally freezes — the Sheet keeps returning the same numbers for days. The cron now has a **staleness detector** (added 2026-06-27) that:

1. Compares today's fetched ADPs to the previous auto pull
2. If ≥95% identical (with ≥50 overlapping players) on any of the 4 sources, exits 1
3. GitHub Actions emails the user
4. The puller leaves `latest.json` untouched so the dashboard keeps the last-known-good snapshot

When the user gets that email, they pull rankings exports directly from DK / UD / Drafters / FFPC native sites and drop the CSVs in the repo root (or `_local/manual-snapshots/`). They will not necessarily provide all four sources — they'll get what they can.

---

## Procedure

### 1. Find the dropped files

```bash
ls -lat "c:/Users/pjmer/Documents/EZ Dubs Website" | head -10
```

Expected filenames (they vary slightly day-to-day — match by content not filename):
- `Underdog Rankings*.csv` (may have a date suffix like `0629`)
- `DkPreDraftRankings(NN).csv` (NN increments)
- `drafters_players(N).csv` (N increments)

If FFPC is included it will be something like `ffpc_*.csv` (no example seen yet — flag to user if it appears so we can verify the schema).

### 2. Sync with remote first

The morning cron already pushed today's (stale) auto rows. Your local copy is behind. Sync before doing anything:

```bash
cd "c:/Users/pjmer/Documents/EZ Dubs Website" && git pull --rebase --quiet
```

Then verify what's currently in the history files for today's date:

```bash
py -c "
import csv
for src in ['dk','ud','ffpc','drafters']:
    rows = list(csv.DictReader(open(f'dashboards/best-ball-prices/{src}_adp_history.csv')))
    today = [r for r in rows if r['date'] == 'YYYY-MM-DD']  # << today
    by_source = {}
    for r in today: by_source[r['source']] = by_source.get(r['source'], 0) + 1
    print(f'{src} YYYY-MM-DD: {by_source}')
"
```

Expected: each source shows `{'auto': N}` from the morning cron's stale write. If you see `manual` rows already, the upload was already done today — STOP and ask the user.

### 3. Move drop files into `_local/manual-snapshots/`

```bash
mv "Underdog Rankings*.csv" "DkPreDraftRankings*.csv" "drafters_players*.csv" \
   _local/manual-snapshots/
```

This directory is gitignored. The dropped raw CSVs are not committed (the long-format history files capture all the real data).

### 4. Clone the previous day's one-off script

Each day gets its own dated script in `scripts/` for traceability. The naming convention is `one_off_manual_snapshot_YYYY_MM_DD.py`.

Pick the most recent existing one as the template:

```bash
ls scripts/one_off_manual_snapshot_*.py
```

Copy it to today's name and bump the date:

```bash
cp scripts/one_off_manual_snapshot_2026_06_NN.py scripts/one_off_manual_snapshot_2026_06_MM.py

py -c "
p = 'scripts/one_off_manual_snapshot_2026_06_MM.py'
s = open(p, encoding='utf-8').read()
s = s.replace('TODAY = \"2026-06-NN\"', 'TODAY = \"2026-06-MM\"')
s = s.replace('2026-06-NN', '2026-06-MM')
# Update file paths if today's drop filenames differ from yesterday's:
# s = s.replace('Underdog Rankings.csv', 'Underdog Rankings 0629.csv')
# s = s.replace('DkPreDraftRankings(NN).csv', 'DkPreDraftRankings(MM).csv')
# s = s.replace('drafters_players(N).csv', 'drafters_players(N+1).csv')
open(p, 'w', encoding='utf-8').write(s)
"
```

Then `grep -n 'TODAY = \|DROP ' scripts/one_off_manual_snapshot_2026_06_MM.py` to confirm date and paths look right.

### 5. Strip today's stale auto rows for sources the user provided

Only do this for sources the user gave you a manual CSV for. **Leave the others' stale auto rows in place** — they'll show as stale in the dashboard but the History page can still compute deltas (just zero ones).

Default case (user gave DK/UD/Drafters but not FFPC):

```bash
py -c "
import csv
for src in ['dk','ud','drafters']:  # << only sources with manual files
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

### 6. Run today's script

```bash
py scripts/one_off_manual_snapshot_2026_06_MM.py
```

Expected output:
```
DK: appended ~380 manual rows -> dk_adp_history.csv
UD: appended ~297 manual rows -> ud_adp_history.csv
Drafters: appended ~278 manual rows -> drafters_adp_history.csv
Rewrote latest.json (~410 players, date=YYYY-MM-DD).
```

Sanity ranges (gut-check today's pull):
- **DK**: ~380 ranked players. If you see >1000, the Drafters-style sentinel filter is wrong.
- **UD**: ~295 ranked players.
- **Drafters**: ~278 ranked players. NOTE: Drafters uses ADP=`0` for "undrafted" not blank — the parser treats `<= 0` as a sentinel.
- **latest.json**: ~410 total unique players. If <300 or >600, something's off.

### 7. Verify locally

```bash
py -c "
import json, csv
from collections import Counter
d = json.load(open('dashboards/best-ball-prices/latest.json'))
print(f'date={d[\"date\"]} players={len(d[\"players\"])}')
sources = Counter()
for p in d['players']:
    for s in p['adps']: sources[s] += 1
print('source coverage:', dict(sources))
print('top 3:')
for p in d['players'][:3]:
    print(f'  {p[\"name\"]} ({p[\"pos\"]} {p[\"team\"]}): {p[\"adps\"]}')
"
```

The top 3 should be (in some order): Jahmyr Gibbs (RB DET), Bijan Robinson (RB ATL), Ja'Marr Chase (WR CIN), or Puka Nacua (WR LAR). If the top is something like "Devin Neal" or an unfamiliar player, the sentinel handling broke — STOP and debug before pushing.

Optional HTTP smoke:

```bash
py -m http.server 8765 > /dev/null 2>&1 &
sleep 2
curl -sI "http://localhost:8765/dashboards/best-ball-prices/" | head -1
curl -sI "http://localhost:8765/dashboards/best-ball-prices/latest.json" | head -1
kill %1
```

### 8. Commit and push

```bash
git add -A
git commit -m "Manual YYYY-MM-DD ADP snapshot for DK, UD, Drafters

[1-2 sentence summary including which sources got manual rows
 and which stayed as stale auto]

Counts:
  DK:       NNN manual
  UD:       NNN manual
  Drafters: NNN manual
  FFPC:     NNN stale auto (unchanged)
"
git push
```

---

## Important rules

- **Append-only.** Never delete historical rows from prior dates. Today's stale auto rows for sources getting a manual override are the one allowed exception. If you have a bug in a *prior day's* manual upload, fix it with a fresh commit that overwrites the file from a re-derived source — don't `sed` it in place.
- **Don't touch FFPC unless the user provides FFPC.** Default behavior: leave FFPC's stale auto rows alone.
- **Don't commit the dropped raw CSVs.** They go to `_local/manual-snapshots/` which is gitignored.
- **Don't touch the legacy repo.** There's an old `best-ball-adp-arbitrage-testing` repo at `c:/Users/pjmer/Documents/AI Testing/`. It is not this one. Never edit it from this session.
- **The dashboard prefers manual over auto for the same date.** So if you accidentally leave a stale auto row in place AND add a manual row, the dashboard does the right thing. But the file should still be cleaned for clarity (strip the stale auto).

---

## Schema reference

### Long-format history files

Path: `dashboards/best-ball-prices/{dk,ud,ffpc,drafters}_adp_history.csv`

Schema: `date, name, pos, team, adp, source`

Example: `2026-06-29,Jahmyr Gibbs,RB,DET,1.2,manual`

### Drop file schemas (as of 2026-06-29)

**Underdog** (`Underdog Rankings*.csv`):
- Columns: `id, firstName, lastName, adp, projectedPoints, salary, positionRank, slotName, teamName, lineupStatus, byeWeek`
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

**Drafters** (`drafters_players(N).csv`):
- Columns: `id, position, name, preferred, team abbr, ADP, AVG`
- Name: `name`
- Pos: `position`
- Team: `team abbr`
- ADP: `ADP` — **uses `0` as the undrafted sentinel** (not blank). Filter `<= 0` out.
- Sentinel floor: infinity (no real sentinel above 0; the `<= 0` filter is what drops noise)

**FFPC**: No manual schema seen yet (user has not provided one through 2026-06-29). Flag to user when one appears so the schema can be added here.
