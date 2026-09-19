# Notes for Claude

Context for future Claude sessions in this repo. Read `README.md` first for the big picture; this file covers things that are easy to get wrong.

## What this is

`ez-dubs-website` — personal site (brand: **EZ Dubs Analytics**) published via GitHub Pages at https://pjmerica.github.io/ez-dubs-website/ and the custom domain https://ezdubsanalytics.com/. Pages under the shared top nav:

- **Best Ball Price Differences** at `dashboards/best-ball-prices/`. Compares DK vs UD ADP. Frozen at 2026-09-04 as of that season's close (see "Best Ball is frozen" below). Two tabs: Table view and Chart view. Source picker was removed when only DK+UD remained — DK is always the left column, UD the right.
- **Best Ball History Risers/Fallers** at `dashboards/best-ball-history/`. Movers over a chosen lookback window on the same DK+UD history CSVs. Also frozen at 2026-09-04.
- **Today's Arbitrage Picks** at `dashboards/prediction-arbitrage/`. Password-gated. Shows a small free preview card above the gate for locked visitors.
- **Arb Calculator** at `dashboards/arb-calculator/`. Free tool. Accepts URL params (`?labelA=Kalshi&labelB=Polymarket&ayes=0.42&bno=0.55&...`) so the pred-mkt cards can hand off a prefilled setup.
- **Contact** at `/contact.html`. Formspree form.
- **Blog** — external link to Substack (`https://substack.com/@ezdubsanalytics`).

## Best Ball is frozen (2026-09-19)

The 2026 Best Ball drafting season closed on Sept 4. The two Best Ball dashboards were frozen at that snapshot:

- **CSV trim:** `dk_adp_history.csv` and `ud_adp_history.csv` were trimmed to rows dated `<= 2026-09-04`. All post-09-04 auto rows were dropped (they were noise — nobody drafts after the season closes).
- **`latest.json` is pinned to 2026-09-04.** Rebuilt from that day's rows. 429 players.
- **The daily ADP cron is disabled.** The `schedule:` block in `.github/workflows/daily-adp-pull.yml` is commented out; only `workflow_dispatch` remains. To reactivate for 2027, uncomment the two cron lines.
- **Subtitle copy** on both Best Ball dashboards reads "2026 Best Ball Season" (past tense implicit).
- The **pred-mkt page + arb calculator run year-round** and are unaffected.

If a future session sees this file and doesn't understand why `pull_adp.py` looks partially dead, this is why. Don't reactivate the cron unless the user asks. Don't touch the frozen CSVs unless they specifically want to change the snapshot date or replace 09-04's rows.

## FFPC and Drafters were archived (2026-07-31)

The site used to track four sources (DK, UD, FFPC, Drafters). FFPC and Drafters were archived on 2026-07-31 — both had been byte-for-byte frozen upstream for 3+ months. The archived CSVs live in `_local/archive/`. Everything else (puller, dashboards, workflow YAML, docs, notebook) was cleaned up to only handle DK + UD.

If you're bringing them back: (1) restore `ffpc_adp_history.csv` and `drafters_adp_history.csv` from `_local/archive/`, (2) add their entries back to `SOURCES` / `SOURCE_COLORS` / `ADP_FLOORS` / `source_cols` / `_REQUIRED_COLS` across the touched files, (3) restore the source-picker UI on both dashboards from git history (~pre commit `bfc73fb`), (4) restore the "All 4 markets" tab from git history.

## Storage model

Two long-format CSVs (one per market) hold all per-day ADPs:

- `dashboards/best-ball-prices/dk_adp_history.csv`
- `dashboards/best-ball-prices/ud_adp_history.csv`

Schema for both:

```
date,name,pos,team,adp,source
2026-05-07,Bijan Robinson,RB,ATL,1.5,auto
```

`source` is `manual` or `auto`. The dashboard prefers `manual` rows when both exist for the same date.

**Do not** reintroduce per-day CSV files (`dk_adp_2026-05-07.csv` etc.). We deliberately moved away from that.

**Append-only.** Never edit historical rows in place. The one exception was the 2026-09-19 freeze (trim rows dated after 09-04), and that was a deliberate, user-approved retention change.

## Merged snapshot: `latest.json`

The dashboard doesn't load the raw CSVs — it loads `dashboards/best-ball-prices/latest.json`, a pre-aggregated per-player snapshot. Shape:

```json
{
  "pulled_at": "2026-09-04T...",
  "date": "2026-09-04",
  "players": [
    {"name": "Jahmyr Gibbs", "pos": "RB", "team": "DET",
     "adps": {"DK": 1.1, "UD": 1.0}}
  ],
  "stale_sources": [],
  "stale_since": {}
}
```

- **`stale_sources`** — array of source labels the puller detected as frozen upstream. The dashboard renders a ⚠ next to those sources' names in dropdowns and column headers. Empty means all sources are fresh.
- **`stale_since`** — map from source label → ISO date when it last actually moved. Powers the hover tooltip ("Stale since 2026-06-22"). Only populated for stale sources.

Merge is keyed by `normalize_player_name()`:
- Lowercase, strip `.` and `'`.
- Strip trailing suffix tokens: `jr / sr / ii / iii / iv / v / 1st..5th` (case-insensitive, with or without period).
- Collapse whitespace.
- Apply first-name aliases from `_FIRST_NAME_ALIASES` (currently just `{"kenneth": "kenny"}` for the Kenny Gainwell case).

Display-name pick rules on merge:
1. If any variant's first name is an alias TARGET ("Kenny") and another is the alias SOURCE ("Kenneth"), the target wins.
2. Otherwise, the longest variant wins ("Marvin Harrison Jr." > "Marvin Harrison").

Three implementations of this must stay in sync:
- `scripts/pull_adp.py` (cron path)
- `scripts/manual_update.ipynb` (notebook path, in the setup cell) + the one-off script template
- `normalizeName()` inside the JS on `dashboards/best-ball-prices/index.html` (client-side lookups)

## The Google Sheet

- URL: https://docs.google.com/spreadsheets/d/1OMi92b1Glfb3Q8s48h4DotP6_9DQb5UwnwFELjpuccs/edit?gid=420942436
- Sharing: "anyone with the link can view." No credentials are stored anywhere. The puller fetches `…/export?format=csv&gid=420942436`.
- Schema (header row): `Name, Pos, Team, UD ADP, DK ADP, FFPC ADP, Drafters ADP, …`. The puller consumes `Name`, `Pos`, `Team`, `UD ADP`, `DK ADP` only. FFPC ADP and Drafters ADP columns are still in the sheet (they haven't been maintained upstream in months) but the puller no longer reads them. If the FFPC/Drafters headers ever disappear from the sheet entirely, nothing here breaks.

## The ADP cron (currently disabled)

`.github/workflows/daily-adp-pull.yml`:

- **Schedule is commented out** as of 2026-09-19 freeze. `workflow_dispatch` still works.
- When running: `scripts/pull_adp.py` fetches the sheet, writes a raw QC copy to `_local/adp-daily/sheet_YYYY-MM-DD.csv` (gitignored), appends today's `auto` rows to the two history CSVs, and rebuilds `latest.json`. The puller is idempotent — it skips the append per file if `(date=today, source=auto)` already exists.
- The puller has a **staleness detector** that compares today's fresh sheet to the previous auto pull per source. If a source is ≥95% identical, it's flagged in `stale_sources` and its values are carried forward from the prior `latest.json` instead of using today's sheet data. The exit code is 1 only if BOTH sources go stale — partial staleness is a normal state.

## The prediction-market arb pipeline

`.github/workflows/daily-pred-arbs-pull.yml` runs at 14:00 UTC daily and on `workflow_dispatch` (still active):

1. `python scripts/pull_pred_arbs.py`:
   - Fetches `https://pjmerica.github.io/pred-arbitrage/arb_data.js` and `https://pjmerica.github.io/polling-agg-2026/arb_data.js` (both are JS files of the form `const ARB = {...};`).
   - Filters to `arb_type == "guaranteed"` with `guaranteed_return_pct` in 1–25% (not display-gap — upstream returns are computed from real fillable asks since 2026-07-03/04, and display-gap filtering excluded book-driven arbs where the last trade is stale).
   - Both sources contribute (polling-agg was silently contributing zero until 2026-07-04: the puller required `implied_prob_a/b` fields polling-agg's schema never had — `_display_probs()` in `pull_pred_arbs.py` now handles both schemas).
   - Normalizes to `dashboards/prediction-arbitrage/arbs.json` containing `{generated_at, sources[], arbs[]}`. Sorted: non-suspicious first, then by `return_pct` desc.
2. Commits and pushes if changed.

Dashboard behavior:
- Fetches `arbs.json` client-side.
- Password-gated (`obsession`, SHA-256 hash in source). Unlock stored in sessionStorage. Velvet-rope only — `arbs.json` is publicly fetchable.
- Above the gate, a **free daily preview** picks one non-suspicious arb (deterministic per-UTC-day, from the middle 60% of the non-suspicious list) so locked visitors see something real.
- Each arb card has a "Size this in the Calculator →" button that hands off to the Arb Calculator with all four prices (A YES, A NO, B YES, B NO) prefilled via URL params.

**About the `suspicious` flag:** rows the upstream scanner thinks may be a data error (wide spread, thin depth, one-sided book, inferred price). Shown by default with human-labeled reasons on the pill; a "Suspicious: Hide / Include" chip toggle filters them.

## Manual-upload workflow (Best Ball only, currently dormant)

When the ADP cron was active and the upstream sheet froze, the user handled it by hand-uploading rankings exports from DK.com and underdogfantasy.com. That flow is documented in `docs/manual-upload-playbook.md` and `scripts/manual_update.ipynb`. It's dormant now that the season is frozen. If the season reopens for 2027 and the cron gets flakey again, that's the same procedure to follow.

Each manual day historically gets its own dated `scripts/one_off_manual_snapshot_YYYY_MM_DD.py`. Most recent one is `2026_08_23.py`.

## Local-only files

`_local/` is gitignored and exists for QC and archives. Do not commit anything under it. Do not "clean up" real state into `_local/`.

- `_local/adp-daily/` — raw sheet QC dumps written by the puller.
- `_local/archive/` — `ffpc_adp_history.csv` + `drafters_adp_history.csv` from before the 2026-07-31 archive cleanup.
- `_local/manual-snapshots/` — the raw drop CSVs from every manual upload day, prefixed by MMDD.

## Repo facts

- GitHub: https://github.com/pjmerica/ez-dubs-website
- Custom domain: https://ezdubsanalytics.com/ (CNAME in repo root).
- Pages source: `main` branch, root.
- Default branch: `main`.
- Git author for cron commits: `ezdubs-bot`.
- Legacy repo still exists at `c:/Users/pjmer/Documents/AI Testing/best-ball-adp-arbitrage-testing/`. Do not touch it from this repo's session.

## Things that are easy to get wrong

- **Don't reactivate the ADP cron** unless the user explicitly asks. It's disabled for a reason (season is over).
- **Don't edit history rows in place.** Append-only. The 09-19 freeze trim was a deliberate exception and doesn't reset the rule.
- **Don't `git add -A`.** Use targeted `git add <path...>` because the repo root is a common staging area for manual drop files (which are gitignored) and picks-log exports (which are not). Targeted staging avoids sweeping up stray files.
- **Don't bump `actions/checkout` or `actions/setup-python` versions** without verifying they still work — Node.js version warnings on cron runs are noise, not breakage.
- **GH Actions push needs `permissions: contents: write`** on the workflow. Don't strip it during cleanup.
- **Formspree endpoint is `mojzokrg`.** The user has decided to stay on the free tier and not set an allowed-domain restriction (documented decision — don't keep flagging it as a follow-up).
- **No em-dashes in user-visible prose.** Standing style rule from the user. Code comments can keep them.
- **Pseudonymous brand.** The site never shows the user's real name. Cron commits use `ezdubs-bot`; hand commits from `pjmerica@umich.edu` are fine.

## Common tasks

**Trigger the workflow manually from the CLI (cron is disabled, so this is the only path):**
```
gh workflow run daily-adp-pull.yml -R pjmerica/ez-dubs-website
gh run list -R pjmerica/ez-dubs-website --limit 3
```

**Run the puller locally:**
```
py -m pip install requests   # one time
py scripts/pull_adp.py
```

**Inspect a history file's shape:**
```
py -c "import csv; r=list(csv.DictReader(open('dashboards/best-ball-prices/dk_adp_history.csv'))); print(len(r), 'rows'); print(set(x['source'] for x in r)); print(sorted({x['date'] for x in r})[-3:])"
```

**Inspect the current merged snapshot:**
```
py -c "import json; d=json.load(open('dashboards/best-ball-prices/latest.json')); print(d['date'], len(d['players']), 'players; stale:', d.get('stale_sources'))"
```

**Re-run today's manual-upload script (dormant, but if needed):** see `scripts/one_off_manual_snapshot_2026_08_23.py` as the template.
