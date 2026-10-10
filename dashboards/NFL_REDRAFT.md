# NFL Redraft/In-Season pages

**Added:** 2026-10-01 · **Source repo:** `pjmerica/AI_Agent_work`

Two in-season NFL dashboards, ported from the `lineup/` page in
[AI_Agent_work](https://github.com/pjmerica/AI_Agent_work). They project fantasy
points from betting markets rather than from a ranking model, and read a user's
real Sleeper leagues live in the browser.

| Page | URL | Opens on |
|---|---|---|
| Start/Sit | `dashboards/nfl-start-sit/` | the Sleeper Start/Sit tab |
| Root For/Against | `dashboards/nfl-rooting/` | the Root For/Against tab |

Both are in the top nav under **NFL → Redraft/In-Season**.

## The thing to understand first

**These are two URLs serving one application.** Both pages load the same
`dashboards/nfl-shared/app.js`; each only sets which tab opens first:

```html
<script>window.LINEUP_DEFAULT_VIEW = "rooting";
        window.LINEUP_DATA_DIR = "../nfl-start-sit/data/";</script>
```

Do **not** copy `app.js` into each page directory to make them independent. That
logic — Sleeper rosters, league scoring, the projection merge — is the same for
both views, and duplicating it is how the source repo got two silent drift bugs
(a fix landed in one copy and not the other; see `tests/apps_agree.test.js`
there). A reader arriving at `nfl-rooting/` and finding no `app.js` is the
intended design, not a missing file.

All three tabs are reachable from either page. The nav entries are deep links to
the two people actually want.

## Where the data lives

`dashboards/nfl-start-sit/data/` — seven JSON files, about 950 KB:

| File | What it is |
|---|---|
| `weekly.json` | Kalshi per-game player props |
| `oddsapi.json` | multi-book props (DraftKings, FanDuel, BetMGM, Bovada, …) |
| `dk_td.json` | DraftKings anytime-touchdown prices |
| `gamelines.json` | spreads and totals — this is what prices kickers and defenses |
| `sleeper_players.json` | trimmed Sleeper player map, plus injury status |
| `clay.json`, `data.json` | season projections, used to fill in unpriced players |

`nfl-rooting` points at this same directory, so the payload is stored and fetched
once.

## Keeping the data fresh

**This is wired up and automatic.** `.github/workflows/nfl-data-pull.yml` runs
`scripts/pull_nfl_data.py`, which mirrors the seven JSON files from the source
repo's Pages site and commits them only when something actually changed.

It mirrors rather than re-running the scrapers, deliberately: The Odds API bills
per event per market, so a second pipeline would double the credit burn for
identical numbers, no `ODDS_API_KEY` has to exist in this repo at all, and both
sites cannot drift apart.

Cadence follows how the upstream data moves, which is uneven: sportsbooks do not
post most Sunday props until Thursday night, so a Wednesday pull legitimately has
a third of the slate unpriced. Once a day Monday through Wednesday, twice daily
Thursday through Sunday.

### Two traps that were fixed here, do not reintroduce them

Both had the same symptom: an endless stream of empty auto-commits.

**The stamp file must not carry the run time.** `mirrored_at.json` records the
*upstream* `lastUpdated` values, not `datetime.now()`. An earlier version wrote
the run time, so the file differed on every run even when no data had moved, and
the workflow's "commit only if changed" check could never fire.

**`*.json` is `-text` in `.gitattributes`.** The puller decides whether to write a
file by comparing bytes. With `core.autocrlf=true` on a Windows checkout, every
committed LF file became CRLF on disk and so looked changed on every run, with the
same result.

If you touch either, re-check that a second `python scripts/pull_nfl_data.py`
reports `0 changed` and leaves `git status` clean.

Also: the commit-message week lookup is grep, not an interpreter, on purpose. It
runs *after* `git add`, so anything that can throw there would abort the step with
changes staged and nothing committed. (An inline multi-line `python -c` indented
inside a YAML block scalar is an `IndentationError` -- that version would have
labelled every commit `?`.)

### One upstream caveat

`dk_td.json` only refreshes from a **local** run, because DraftKings blocks
GitHub Actions runners (403). It can therefore be staler than its siblings. The
page handles this -- it drops touchdown entries whose game is not on the current
board, and the coverage banner says when the whole file has aged out -- but the
mirror inherits whatever the source repo last committed.

**Updated 2026-10-10:** this no longer costs the board the stat. The Odds
API also carries `player_anytime_td` and runs fine on CI, so touchdown prices
now refresh unattended and DraftKings is preferred only when it has been run
locally. Both sources arrive as an expected touchdown count, not P(scores at
least one), through the same conversion.

## What the port changed in this repo

### The nav gained a second level

```
before                      after
Best Ball (NFL) ▾           NFL ▾
  Price Differences           Best Ball ▸
  History Risers/Fallers        Price Differences
                                History Risers/Fallers
                              Redraft/In-Season ▸
                                Start/Sit
                                Root For/Against
```

The nav is **copy-pasted into every HTML page** in this repo rather than
templated, and it was single-level. The port added a `.nav-dd-sub` rule set and
the matching markup to all eight pages. The existing rules were not touched, so
the Prediction Markets dropdown behaves exactly as before.

On screens under 760px the submenu cannot fly out sideways, so it renders
indented in place instead.

Changing the nav means editing every page. `scripts/` in the source repo has
`port_lineup_to_ezdubs.py`, which does it idempotently — re-running it refreshes
the nav on every page rather than duplicating it.

### Files added

```
dashboards/nfl-shared/app.js        the application (one copy)
dashboards/nfl-shared/style.css     its styles
dashboards/nfl-start-sit/index.html + data/
dashboards/nfl-rooting/index.html
```

`nfl-shared/` holds no page of its own; it exists so the two pages cannot drift.

## How to re-port after an upstream change

From the source repo:

```sh
cd /path/to/AI_Agent_work
py scripts/port_lineup_to_ezdubs.py              # dry run, prints the plan
py scripts/port_lineup_to_ezdubs.py --write
```

It is idempotent: it rewrites the shared assets, both pages, and the nav on every
page. It aborts rather than shipping a page with no nav if it cannot find the
donor markup, and aborts if `app.js` no longer has the `DATA_DIR` line it needs
to rewrite — meaning the upstream page changed shape and the script needs
updating before it can be trusted.

## What the pages actually do

Worth knowing to answer questions about them:

- **Projections come from betting markets**, not rankings. A receiver's yardage
  line of 67.5 becomes 6.75 points.
- **Each league's own scoring** is read from Sleeper, so the same player scores
  differently across leagues — including D/ST, where one of these leagues pays 10
  for a shutout and another 5.
- **Kickers and defenses have no prop market anywhere**, so they are priced off
  the game line: a team's implied total is `total/2 − spread/2`, which drives the
  points-allowed buckets. Backtested against three weeks of real results.
- **A `TD ONLY` tag** means a book priced that player's touchdown and nothing
  else, so his yardage is a season estimate rather than a market price. 136 of 465
  players were in that state in week 4, so the tag is common by design.
- **An injury tag** next to a player is Sleeper's own status. When a player has no
  line at all, the page says whether an injury explains it — "IR (Hamstring)" is a
  different instruction from "no book has priced him yet".
- **Nothing is stored server-side.** The Sleeper username lives in
  `localStorage`; the API is public and needs no key.
