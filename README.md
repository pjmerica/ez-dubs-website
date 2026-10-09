# EZ Dubs Analytics

Static site at **[ezdubsanalytics.com](https://ezdubsanalytics.com)**, served by
GitHub Pages from the root of this repo. No build step: every page is a
self-contained `index.html` with its CSS and JS inline.

Six dashboards, grouped the way the nav groups them.

## Best Ball

**Frozen.** The 2026 Best Ball season closed on 2026-09-04 and these two show a
snapshot of that date. The daily puller's cron is commented out in
`.github/workflows/daily-adp-pull.yml`; `workflow_dispatch` still works, so it can
be reactivated for 2027 by uncommenting the schedule.

| page | what it does |
|---|---|
| `dashboards/best-ball-prices/` | DraftKings vs Underdog ADP, with the biggest gaps surfaced |
| `dashboards/best-ball-history/` | how a player's ADP moved over the season, and the biggest risers and fallers |

Two committed history files, long-format `date,name,pos,team,adp,source`:

```
dashboards/best-ball-prices/dk_adp_history.csv
dashboards/best-ball-prices/ud_adp_history.csv
```

FFPC and Drafters were dropped on 2026-07-31 — their columns in the upstream
sheet had been byte-for-byte frozen for three months. Their CSVs are archived in
`_local/archive/` (gitignored) and `scripts/pull_adp.py` still knows how to write
them if those sources ever come back.

## Redraft / In-Season (NFL)

| page | what it does |
|---|---|
| `dashboards/nfl-start-sit/` | who to start this week, priced off betting markets rather than projections |
| `dashboards/nfl-rooting/` | which players to root for and against across all your Sleeper leagues |

Both read your Sleeper leagues in the browser; nothing is stored server-side.
They share one copy of the app — `dashboards/nfl-shared/app.js` and `style.css`
— so the two pages cannot drift apart. **Do not split that into two copies.**

Their data is mirrored from `pjmerica/AI_Agent_work`, which runs the scrapers.
See `dashboards/NFL_REDRAFT.md` for how that works and why it mirrors rather than
scraping again.

## Prediction Markets

| page | what it does |
|---|---|
| `dashboards/prediction-arbitrage/` | daily snapshot of where Kalshi, Polymarket and PredictIt disagree |
| `dashboards/arb-calculator/` | work out equal-payoff stakes across two markets |

`arbs.json` is pulled by `scripts/pull_pred_arbs.py` from the `pred-arbitrage`
scanner's Pages site.

## Layout

```
index.html                     home
contact.html
dashboards/
  <six dashboards>/index.html
  nfl-shared/                  app.js + style.css, shared by the two NFL pages
  NFL_REDRAFT.md               how the NFL pages and their data pipeline work
  UI_AUDIT.md                  accessibility audit, what was measured and fixed
scripts/
  pull_adp.py                  Best Ball ADP (cron disabled; season over)
  pull_nfl_data.py             mirrors NFL market data from AI_Agent_work
  pull_pred_arbs.py            mirrors prediction-market arbs
  verify_*.test.js             the checks CI runs; see below
  one_off_manual_snapshot_*.py 33 dated scripts, Jun-Aug 2026
  backfill_history.py          one-shot migration, already run
docs/manual-upload-playbook.md the manual ADP process, from before the puller
_local/                        gitignored: QC dumps and archived CSVs
```

The `one_off_manual_snapshot_*.py` files look like clutter but are not
boilerplate: each embeds that day's actual ADP rows, 32 distinct shapes across
326 KB. They are historical data, not dead code. Deleting them loses the data.

## What CI checks

`.github/workflows/tests.yml` runs on every push that touches a page:

| check | needs a browser | catches |
|---|---|---|
| `verify_cdn_integrity.test.js` | no | a cross-origin script with no SRI, or one pinned to a CDN-generated file |
| `verify_nav.test.js` | no | nav drift between pages, a broken nav link, `target=_blank` without `rel=noopener` |
| `verify_nfl_pages.test.js` | jsdom | the NFL pages failing to render or sign in |
| `verify_csp.test.js` | Chrome | a CSP that blocks the page's own scripts |
| `verify_mobile_layout.test.js` | Chrome | sideways scroll or a clipped scroll container at 390/360/320px |

Run them locally with `npm install` then `node scripts/<name>.test.js`.

The two Chrome checks measure inside an iframe, because headless Chrome clamps
`--window-size` to a 500px minimum viewport — both layout bugs found so far were
invisible at 500px.

## Things worth knowing before editing

- **The nav and footer are eight independent copies.** There is no template, so a
  nav change means eight edits. `verify_nav.test.js` asserts they stay in sync.
  About 39 KB of CSS is duplicated for the same reason; extracting it is a known,
  unstarted refactor. See `dashboards/UI_AUDIT.md`.
- **Colour rules.** Muted text is `#7f8c99` on the page background and `#8a97a5`
  on the lighter card. Primary buttons use dark text (`#0f1923`) on the brand
  accent `#4a9eff` — white on that accent is 2.75:1 and fails contrast.
- **`frame-ancestors` in a `<meta>` tag does nothing.** Chrome ignores it there
  and GitHub Pages cannot set response headers, so it is inert on this host.
- `CLAUDE.md` carries the fuller working notes, including which data is frozen
  and why, and the stash that must not be popped blind.
