# Notes for Claude

Context for future Claude sessions in this repo. Read `README.md` first for the big picture; this file covers things that are easy to get wrong.

## What this is

`ez-dubs-website` — personal site published via GitHub Pages at https://pjmerica.github.io/ez-dubs-website/. First dashboard is **Best Ball ADP Arbitrage** at `dashboards/adp-arbitrage/`.

## Two pipelines run in parallel — don't conflate them

There is a **legacy** repo at `c:/Users/pjmer/Documents/AI Testing/best-ball-adp-arbitrage-testing/` (GitHub: `pjmerica/best-ball-adp-arbitrage-testing`) that the user is still updating manually. Do not touch it from this repo's session unless explicitly asked. It exists as a fallback during the parallel-run period (a few weeks). Backfilled manual history is already merged into `dk_adp_history.csv` / `ud_adp_history.csv` here, so the new repo doesn't need any further manual file drops.

The new automated pipeline pulls from a Google Sheet daily.

## Storage model — important

Two long-format CSVs hold all per-day ADPs:

- `dashboards/adp-arbitrage/dk_adp_history.csv`
- `dashboards/adp-arbitrage/ud_adp_history.csv`

Schema for both:

```
date,name,pos,team,adp,source
2026-05-07,Bijan Robinson,RB,ATL,1.5,auto
```

`source` is `manual` or `auto`. The same date can appear from both sources during the parallel-run period; the dashboard prefers `manual` rows when both exist for a date. After the parallel-run period ends, manual rows can be deleted and the dashboard falls back to auto.

**Do not** reintroduce per-day CSV files (`dk_adp_2026-05-07.csv` etc.). The previous design used those and we deliberately moved away. The dashboard reads only the two stacked files.

## The Google Sheet

- URL: https://docs.google.com/spreadsheets/d/1OMi92b1Glfb3Q8s48h4DotP6_9DQb5UwnwFELjpuccs/edit?gid=420942436
- Sharing: "anyone with the link can view." No credentials are stored anywhere. The puller fetches `…/export?format=csv&gid=420942436`.
- Schema (header row): `Name, Pos, Team, UD ADP, DK ADP, FFPC ADP, Drafters ADP, …`. The puller only consumes `Name`, `Pos`, `Team`, `UD ADP`, `DK ADP`. If those column headers change or move, `_REQUIRED_COLS` in `scripts/pull_adp.py` will fail loudly — that's intentional.

## How the auto pipeline works

`.github/workflows/daily-adp-pull.yml` runs at 14:00 UTC daily and on `workflow_dispatch`:

1. Checkout, setup Python, `pip install requests`.
2. `python scripts/pull_adp.py`:
   - Fetches the sheet.
   - Writes a raw copy to `_local/adp-daily/sheet_YYYY-MM-DD.csv` (gitignored, QC).
   - Appends today's `auto` rows to the two history files. **Skips the append** if a row with `(date=today, source=auto)` already exists, so re-running is a no-op.
3. `git add` the two history files and commit/push if anything changed.

## Local-only files

`_local/` is gitignored and exists for QC. Don't add anything there to git. Don't move legitimate state into `_local/` to "clean up."

## Common tasks

**Run the puller manually:**
```
py -m pip install requests   # one time
py scripts/pull_adp.py
```

**Trigger the workflow manually from the CLI:**
```
gh workflow run daily-adp-pull.yml -R pjmerica/ez-dubs-website
gh run list -R pjmerica/ez-dubs-website --limit 3
```

**Inspect history file shape:**
```
py -c "import csv; r=list(csv.DictReader(open('dashboards/adp-arbitrage/dk_adp_history.csv'))); print(len(r), 'rows'); print(set(x['source'] for x in r))"
```

## Things that are easy to get wrong

- **Don't edit `index.html` to add a new date.** The dashboard auto-discovers dates from the history files. If the user says "add today's snapshot," they mean run the puller (or wait for the cron), not edit HTML.
- **Don't edit history rows in place.** Append-only. If a bad row got committed, prefer a fresh commit that overwrites the file from a re-derived source rather than `sed`-ing it.
- **The `DRAFT_CUTOVER_DATE`** (`2026-04-24`) is duplicated in `pull_adp.py` and the dashboard's `DRAFT_CUTOVER`. If that date ever changes, both must change.
- **Don't bump `actions/checkout` or `actions/setup-python` versions** without verifying they still work — Node.js version warnings on cron runs are noise, not breakage.
- **GH Actions push needs `permissions: contents: write`** (already set). Don't strip it during cleanup.

## Repo facts

- GitHub: https://github.com/pjmerica/ez-dubs-website
- Pages source: `main` branch, root.
- Default branch: `main`.
- Git author for cron commits: `ezdubs-bot`.
