# EZ Dubs Website

Personal site for blogging and dashboards. First public dashboard: the **Best Ball ADP Arbitrage** tool comparing DraftKings vs Underdog ADPs for the upcoming NFL season.

## Layout

```
EZ Dubs Website/
├── README.md
├── index.html                           # site landing page
├── .gitignore                           # excludes _local/ and __pycache__/
├── _local/                              # gitignored; daily QC dumps live here
│   ├── README.md
│   └── adp-daily/sheet_YYYY-MM-DD.csv
├── dashboards/
│   └── adp-arbitrage/
│       ├── index.html                   # the dashboard
│       ├── dk_adp_history.csv           # long-format: date,name,pos,team,adp,source
│       └── ud_adp_history.csv           # same shape
├── scripts/
│   ├── pull_adp.py                      # appends today's auto rows to history files
│   ├── backfill_history.py              # one-shot migration from per-day CSVs (already run)
│   └── backfill_manual.py               # legacy helper (one-shot, only useful pre-migration)
└── .github/workflows/daily-adp-pull.yml # runs pull_adp.py daily, commits if changed
```

## Storage strategy

Two committed CSVs instead of 60+ per-day files. ~2,200 rows added per day; ~80k rows after a year. Still tiny, and the dashboard fetches them with two HTTP requests instead of one per snapshot.

Schema (both files):

```
date,name,pos,team,adp,source
2026-05-07,Bijan Robinson,RB,ATL,1.5,auto
```

`source` is `manual` or `auto`. During the parallel-run period the same date can appear from both sources; the dashboard prefers `manual`.

## Two pipelines running in parallel

For a few weeks both pipelines run side by side to validate the automated one before cutting over.

### Manual (legacy)
Drop DK and UD CSVs in the legacy folder, the existing helper renames them. The new repo doesn't accept manual drops directly during the parallel run; manual rows are already backfilled into the histories.

### Automated
Source: a public Google Sheet I control where ADPs land daily via my own automation.
- Sheet: https://docs.google.com/spreadsheets/d/1OMi92b1Glfb3Q8s48h4DotP6_9DQb5UwnwFELjpuccs/edit?gid=420942436
- Sharing: "anyone with the link can view" — the puller fetches the public CSV export with no credentials.

`scripts/pull_adp.py` runs daily via GitHub Actions:
1. Fetches the sheet as CSV.
2. Writes a raw copy to `_local/adp-daily/sheet_YYYY-MM-DD.csv` (gitignored, QC).
3. Appends today's `auto` rows to `dk_adp_history.csv` and `ud_adp_history.csv`. Skips append if today's `auto` rows are already present.
4. Commits and pushes if anything changed.

## Hosting

- New repo: `ez-dubs-website` (GitHub Pages).
- The legacy `best-ball-adp-arbitrage-testing` repo stays live as a fallback during the parallel-run period.

## Running the puller locally

```
py -m pip install requests
py scripts/pull_adp.py
```

Idempotent — re-running on the same UTC day is a no-op.
