# Site audit, 2026-10-14

A full pass over the repo and the live site at ezdubsanalytics.com, looking for
errors, fragile dependencies and design improvements. This file records what was
found, what was changed and how each change was checked, plus what was left for
later and why.

State before the audit: CI and all three bot workflows green, every page 200 in
under 0.2s, HTTPS and www redirects correct, no JS errors on any page.

## Fixed

### 1. Arb cards and the calculator handoff used the wrong prices (most serious)

**Problem.** Since 2026-07-04 the puller filters and sorts arbs on upstream's
`guaranteed_return_pct`, which the scanner computes from the real fillable ask
prices, after Kalshi and Polymarket fees
(`Pred Arbitrage/scripts/arb_scanner.py`, `compute_arb`). The dashboard was never
updated to match. It kept showing:

- a "pp gap" headline built from `prob_a`/`prob_b`, which are display prices
  (last trade or mid), not what a buyer pays;
- those display prices on each leg, with no indication of which side to buy;
- a "Biggest price gap" sort on the same display prices.

The "Size this in the Calculator" button sent `prob` and `1 - prob` as the four
prices, so the calculator overstated every arb. Across the 46 arbs live on
2026-10-14, a basket listed at 1.11% opened in the calculator as 14.29%.

**Fix.**
- `scripts/pull_pred_arbs.py` now keeps the asks and the direction:
  `yes_leg` (`"a"` = buy YES on A and NO on B), `ask_yes_a`, `ask_no_a`,
  `ask_yes_b`, `ask_no_b`. It uses the depth-adjusted `fillable_*` asks first and
  the plain asks as fallback. Both upstream schemas carry them.
- Each card now leads with "X.XX% after fees" and shows the trade on each leg,
  for example "Buy YES @ 6¢" and "Buy NO @ 86¢".
- The handoff sends the four asks plus `net` (the after-fee return).
- The calculator shows a note on prefilled runs: the arbs page's after-fee figure,
  and that its own result is before fees, so it reads higher.
- Sorts are now "Best return" (after-fee) and "Best per year" (see 2), plus the
  existing "Highest volume".
- Rows without the new fields (an `arbs.json` written before this change) fall
  back to the old card, so deploying before the next bot run breaks nothing.
- The wording is "after fees", not "guaranteed", to respect the 2026-06-23
  decision to drop "guaranteed" framing.

**Checked.** In jsdom, with the gate unlocked, all 46 cards render with no errors.
Following every card's calculator link: 46 of 46 show an arb at or above the
card's after-fee return, at most 3.8 points higher (fees). Stripping the new
fields renders the old card. Gross return from the asks was at or above the
after-fee return on every row.

### 2. Annualized return was always empty

`days_to_settle` and `annualized_return_pct` were null on every row, because
pred-arbitrage, the source of nearly all arbs, sends neither. The puller now
derives them from `settle_date`. Annualized is compounded and left blank under 7
days out, where it turns into a meaningless four-digit number. Cards show it
next to the settle date, for example "Settles 2027-03-15 (17.9%/yr)".

Why it matters: one live arb on 2026-10-14 paid 1.56% but settles in 755 days,
which is 0.75% a year.

### 3. A total upstream outage would have wiped the arbs page

**Problem.** If both scanner feeds failed, `pull_pred_arbs.py` still wrote an
empty `arbs.json`, the workflow committed it, and visitors saw "the markets are
hyper-efficient today".

**Fix.** If no source succeeds, the puller exits 1 without writing. The job fails
before its commit step, so the last good file stays live and GitHub emails the
failure. One source down still publishes, with that source's `ok: false`
recorded.

**Checked.** New `scripts/test_pull_pred_arbs.py` (7 offline tests, requests
mocked). The outage test fails against the pre-fix puller and passes now. Added
to the Tests workflow.

### 4. The arbs page's "updated" time could look fresh when it wasn't

**Problem.** The page showed `generated_at`, which is when our puller ran, not
when the prices were scanned. It ignored the per-source `ok` flags.

**Fix.** The line reads "Prices as of" and uses the oldest `updated_at` among
sources that contributed arbs. Polling Agg routinely runs 5 to 11 hours behind
but usually contributes zero arbs, so counting it would flag the page stale for
no reason. A yellow note appears if those prices are more than 12 hours old or a
feed failed. Fractional seconds are trimmed before parsing because Safari rejects
more than 3 digits.

**Checked.** jsdom: no note on current data, the stale note with the clock moved
forward 20 hours, the failure note with one source marked `ok: false`.

### 5. Best Ball Risers/Fallers could hang forever

`loadHistoryData()` had no error handling, and it never checked `resp.ok`, so a
404 would be parsed as CSV. Now a failed or non-200 load says "Could not load the
ADP history (...). Refresh to try again." Checked by forcing a 404 on one CSV.

### 6. Fake endorsements from real people

The home page reviews were attributed to Barack Obama, Hue Jackson and Duane
"Dog" Chapman. That's a legal and credibility risk on a betting site, and it cuts
against the pseudonymous brand. The quotes stay; the names are now invented
("Last place, 12-team PPR", and so on).

### 7. Home page didn't show the in-season tools

The cards were Best Ball (frozen, tagged "Live"), the arbs page and the
calculator. The NFL pages, the most timely things on the site in October,
weren't there. New order: NFL Start/Sit, then Root For/Against, then the two arb
tools, then Best Ball, tagged "2026 season". The NFL cards use #9b8cff rather
than the NFL pages' #5b4cf5, which is only 3.0:1 on the card background. The new
color is 6.0:1.

### 8. Stale copy

- Best Ball Price Differences: description and link-preview text said "Updated
  daily". Now they say it's frozen at the close of the 2026 season.
- Arbs page: the description named PredictIt (every current arb is Kalshi vs
  Polymarket) and said "Daily"; the disclaimer said "once or twice daily". Both
  now say "every few hours", which matches the 2-hour cron.

### 9. Missing site files

- `404.html`: a branded not-found page listing every dashboard. All its links are
  root-relative, because GitHub Pages serves it at whatever path was missing. It
  is `noindex` and runs no scripts. It isn't in `verify_nav`'s page list and
  deliberately doesn't carry the full nav, so a nav change is still 8 edits, not 9.
- `robots.txt` and `sitemap.xml` (hand-maintained; add a URL when a page joins
  the nav).

### 10. Smaller fixes

- The calculator printed leg prices to 2 decimals, so a 0.0065 ask showed as
  "0.01". It now shows up to 4 decimals with trailing zeros dropped.
- Screen readers now announce the contact form's sent/failed message, and the
  calculator's result and errors (`aria-live` and `role="alert"`).
- `tests.yml` path triggers: three of the six `verify_*` test files weren't
  listed, so editing them never ran CI. It now uses a `scripts/verify_*.test.js`
  glob, and also triggers on `404.html`, `pull_pred_arbs.py` and its test.

### 11. NFL pages: heading, subtitle, head tags, cache-bust (fixed upstream)

The two NFL pages are generated by `scripts/port_lineup_to_ezdubs.py` in
AI_Agent_work, which rebuilds them on every port and keeps only
`<meta http-equiv>` tags. A hand edit here would have been silently reverted, so
all four fixes are in that script, and the pages here were regenerated by
running it:

- **Duplicated subtitle phrase.** Both pages read "...priced off the betting
  markets, for this week. Priced off the betting markets." The port's
  "Sister pages" replacement inserted the second copy. Each page now has its own
  subtitle.
- **Both pages were headed "Lineup".** Now "NFL Start/Sit" and
  "Root For / Against".
- **No description, favicon or link-preview tags.** Added per page from the
  port's `PAGES` / `HEAD_TMPL`, matching the other dashboards.
- **Cache-bust tag stuck at `?v=2026-10-01-tdonly`** through four changes to
  `app.js`/`style.css`. It's now a content hash of those two files, computed by
  the port.

The port now exits with an error, rather than shipping a half-patched page, if
`lineup/index.html` changes shape so the heading, subtitle or title can't be
found.

**Checked.** The port touched only the two NFL `index.html` files: the other
six pages, `app.js`, `style.css` and every data file came out byte-identical. A
second run changed nothing (idempotent). `verify_nav`, `verify_nfl_pages`,
`verify_shared_app` and `verify_cdn_integrity` all pass.

**Not a bug: `dk_td.json` last updated 2026-10-01.** DraftKings blocks GitHub
Actions runners, so that file only refreshes from a local run (documented in
`NFL_REDRAFT.md`). Since 2026-10-10 the Odds API supplies touchdown prices
unattended, and the page drops DraftKings entries for games not on the current
board. To refresh it anyway, run `py scripts/fetch_dk_td_scorers.py` in
AI_Agent_work from a home connection and push.

### 12. Privacy: the site published files naming the GitHub account

The brand is pseudonymous, but GitHub Pages (a Jekyll "legacy" build here)
publishes every file in the repo by default. Live on ezdubsanalytics.com were
`/CLAUDE.md` (the owner's email and the GitHub repo link) and its rendered copies
`/CLAUDE` and `/CLAUDE.html`, plus `/README.md`, `/docs/*`, every script under
`/scripts/`, `/package.json` and `/dashboards/NFL_REDRAFT.md` (which links the
upstream repo). The NFL `mirrored_at.json` carried the account's Pages URL as its
`source`.

**Fix.**
- New `_config.yml` with an `exclude:` list for the internal docs, scripts and
  npm manifest. They stay in the repo; the site stops serving them. Jekyll 3
  replaces its default exclude list when the key is set, so the defaults are
  restated.
- `pull_nfl_data.py` no longer writes `source` to `mirrored_at.json`, and its note
  doesn't name the upstream repo. The stamp is now rewritten on every
  non-dry run, not only when data changed. It's derived from files on disk, so a
  no-op run is still byte-identical and commits nothing, but a format change like
  this one now reaches the site.
- New `scripts/verify_no_identity.test.js`, run in CI. It works out what Jekyll
  would publish (tracked files minus the exclude list and underscore/dot paths)
  and fails if any of it contains the account name or the email. It passes now
  and fails against the pre-fix tree.

**Checked.** All test suites pass. The NFL puller's dry run reports 7 unchanged
files. Jekyll can't run on this machine, so the excludes can only be confirmed
after deploying: `/CLAUDE.md`, `/CLAUDE`, `/README.md` and `/scripts/pull_adp.py`
should 404, and every dashboard should still load.

### 13. Risers/Fallers downloaded 3.1 MB on every visit (fixed 2026-10-15)

The page fetched both history CSVs (13.8 MB raw, 320K rows) and parsed them in
the browser on every visit, for data that will never change. Now
`scripts/build_history_summary.js` builds `history.json` once, using the
page's own parsing code verbatim, and the page reads that: 860 KB raw, 139 KB
gzipped. The now-unused CSV helpers came out of the page.

**Checked.** The old page (from git) and the new one were loaded side by side
in jsdom. The built data was identical, apart from key order inside each day's
lookup table, which nothing iterates. The movers list was identical in all 105
era x position x lookback combinations, and the chart series matched. The page
builds its data in under a second instead of about 3.5. New
`verify_history_summary.test.js`, in CI, checks `history.json` still matches
the CSVs and that the page renders from it with no errors and without fetching
a CSV.

## Found but not fixed here

### Privacy: what still links the site to the GitHub account

**Decided 2026-10-14: leave these as they are.** The owner considers the
remaining traceability minor; moving the repo to an org, making it private or
rewriting history were all declined. Don't re-pitch them. The site-side fixes in
item 12 stay.

- **DNS.** `www.ezdubsanalytics.com` is a CNAME to the account's `github.io`
  host, and the account's `github.io/ez-dubs-website/` redirects to the site.
- **The repo is public.** Its scripts must name the upstream Pages sites to fetch
  from them, and 162 hand commits carry the owner's university email.
- **The username itself carries the surname**, so clearing the profile's
  display name alone doesn't cut the link.


### Left for later

- **Repo history is 126 MB, about 120 MB of it old Best Ball CSV versions.** Each
  daily append stored a new 7 MB copy. It stopped growing when the cron was
  disabled. **Decided 2026-10-14:** 2027 will use fresh per-season files and the
  2026 files are permanent, so this never repeats (recorded in CLAUDE.md).
  Rewriting history to reclaim the space isn't worth the disruption.
- **Nav and footer still copied into 8 pages** (known, see `UI_AUDIT.md`).
- **The Chrome-based tests (`verify_csp`, `verify_mobile_layout`) don't run on
  the Windows checkout**: headless Chrome returns an empty DOM. They pass in CI.
  The new card leg text ("Buy YES @ 86¢") is wider than before, so watch the
  first CI mobile-layout run after this lands.
