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

### 14. Best Ball Prices said "Last updated Sep 19" for Sep 4 numbers (fixed 2026-10-19)

The label came from `latest.json`'s `pulled_at`, which is when the file was
built. The freeze rebuilt it on Sep 19 from Sep 4's rows, so the page dated the
season-close ADPs two weeks late. It now reads "ADPs as of: Sep 4, 2026", taken
from `date`. The time is appended only when the pull happened that same day,
which is true of every live daily run, so 2027 still shows the pull time.
`latest.json` is untouched. Checked in jsdom with the real file, a same-day live
pull, and a file with no `pulled_at`.

**Also reviewed on 2026-10-19, no change needed.** The rest of this page's logic
is correct: the "cheaper on" direction, sorting with missing ADPs, the
visualizer, and no player-name collisions in the 429 rows. In the NFL app,
every storage access is wrapped, both fetch wrappers check the status, and data
is escaped where it reaches the page. External links, the Sleeper API,
Formspree and the Chart.js CDN all respond.

### 15. Five Best Ball players were split across two spellings (fixed 2026-10-19)

The manual-upload days used the DK and UD site exports, which spell some names
differently from the Google Sheet the puller reads. On Risers/Fallers each of
these players was two entries that never share a date: Kenneth/Kenny Gainwell,
Marquise/Hollywood Brown, Cameron/Cam Skattebo, Mitchell/Mitch Tinsley, and
"J. Michael"/"J.Michael" Sturdivant. Any lookback crossing a switch dropped
them, and each chart showed only part of the season.

`build_history_summary.js` now merges each pair into the season-close name (the
one `latest.json` uses), via a `SAME_PLAYER` list; `history.json` was rebuilt.
Gainwell and Skattebo now have an ADP on all 149 dates on both books, which
confirms the halves were complementary. No other player's data changed (checked
key by key). Found by pairing same-surname, same-position entries that are
almost never priced on the same day; the only other pair it flagged was two
different players named Smith, each with one day of data.

### 16. NFL league scoring ignored most of each league's settings (fixed 2026-10-19)

`leaguePoints()` used a league's reception, passing-TD and TE-premium settings
but hard-coded every yardage and rushing/receiving TD rate to Sleeper's
defaults. A league scoring 1 point per 20 passing yards was projected as if it
were 1 per 25. It now reads `pass_yd`, `rush_yd`, `rec_yd`, `rush_td` and
`rec_td` from the league, with the defaults as fallback. The data has one
combined rushing+receiving TD expectation, so when a league scores the two
differently, QBs and RBs use the rushing rate and WRs and TEs the receiving
rate. Interceptions and fumbles are still not scored, because no market in the
data prices them.

Fixed upstream in `AI_Agent_work/lineup/app.js` and re-ported, which moved the
cache-bust hash so browsers fetch the new file. New
`AI_Agent_work/tests/league_scoring.test.js` checks hand-worked scores and fails
two cases on the old code. The upstream offline suite passes except
`books_interact.test.js` (AI_Agent_work's own books page, not part of this
site), which fails identically with and without this change.

### 17. Phone menu unreachable by keyboard and unnamed (fixed 2026-10-19)

On all eight pages the menu checkbox was `display: none`, which also removes it
from the tab order. At phone widths, where the links are hidden behind it,
keyboard, switch and screen-reader users could not open the menu. Its "Menu"
name sat on the `<label>`, where it is invalid and ignored (the W3C validator's
only error on seven of the pages). Now the checkbox carries the name, and at
phone widths it is visually hidden but focusable, with a focus ring on the
hamburger. Desktop is unchanged. `verify_nav.test.js` gained 16 checks, which
fail on the old pages. The port script copies the nav from the calculator page
and reproduced the change byte for byte.

Also from the validator: the four "Top 10" titles on Best Ball Prices were
`h3` directly under the `h1`; they're `h2` now, with identical styling.

### 18. Arb calculator: unreadable input, ask precision, whole contracts (fixed 2026-10-19)

- A number box the browser can't parse ("0,42") reports an empty value, so the
  calculator said "add a price" for a filled box. It now says "Not a number. Use
  a decimal point, like 0.42 for 42 cents."
- The price boxes had `step="0.01"`, which marks real asks like 0.0065 invalid.
  Now `step="any"`.
- Results add a whole-contracts line, since Kalshi trades only whole contracts
  and a hedge needs the same count on both legs. For example, $100 at
  0.42 + 0.55 buys 103 of each for $99.91 and pays $103. A bankroll under one
  contract per leg says so.
- The "Guaranteed" wording was left alone: the 2026-06-23 copy change kept it
  on this page on purpose.

### 19. Bot workflows could lose a run to an overlapping run (fixed 2026-10-19)

None of the three bot workflows had a `concurrency` guard. A manual dispatch
landing on a scheduled run has two jobs commit the same file, and the second's
rebase conflicts. The arbs and ADP workflows also lacked the fix the NFL
workflow got on 2026-10-10: a conflicted `git pull --rebase` left the checkout
mid-rebase, so every remaining push attempt failed. All three now queue one run
at a time, and the two retry loops abort a failed rebase before retrying.

**Also checked on 2026-10-19, no change needed:** all 118 internal links,
assets and data fetches resolve to published files. The W3C validator found no
other errors. `pull_adp.py` (for 2027) reads correctly; its only gap is the
name-spelling issue in item 15, now noted in CLAUDE.md.

### 20. Nav styles were eight inline copies (fixed 2026-10-19)

The reset, the nav, the phone menu and the NFL submenu (54 rules) were
identical inline copies in all eight pages, about 39 KB, so a nav style change
was eight edits. They now live in `assets/site.css`. Each page links it
immediately before its own `<style>`, which is where those rules sat; 1,290
duplicated lines came out of the pages. The footer styles differ from page to
page, so they stayed inline.

**Why it can't change how anything looks.**
- *Rule order:* for every page, the old inline rules are exactly site.css's
  rules plus the page's remaining rules, each side in its original order.
- *Cascade:* the only rules that moved earlier relative to page rules are the
  13 at the end (submenu and footer tap targets). A checker searched every
  element on every page for a page rule and a moved shared rule that both match
  it, set the same property and have equal specificity, the only case where
  order decides. It found none, and found both conflicts I planted to test it.
- *Rendered:* old and new sites served side by side in jsdom gave identical
  computed styles: 20,095 properties across all eight pages.
- CI's real-Chrome phone-layout and CSP checks run on the push.

`port_lineup_to_ezdubs.py` (AI_Agent_work) was updated so the next NFL port
copies the shared link with the donor's styles, and no longer pastes the
submenu CSS back into every page. Re-running it against the refactored site
changes nothing. New `verify_shared_css.test.js`, in CI, fails if a page stops
linking the file directly before its `<style>`, or if an inline copy of any
shared rule comes back.

### 21. AI_Agent_work's books test failed at the week 6 rollover (fixed 2026-10-19)

`books_interact.test.js` took a QB's surname off the board and expected no
match under the TE filter. In week 6 the QB was Josh Allen, and "allen"
correctly found Davis Allen, a Rams TE. The page was right; the test now
searches the full name. AI_Agent_work's Tests workflow had failed on it; the
offline suite and CI now pass 19 of 19.

### 22. Start/Sit showed Saturday's odds at Sunday kickoff (fixed 2026-10-19)

Checked the Odds API refresh from start to finish. The scraper works as intended:
- Upstream ran all 8 scheduled pulls for week 6, and each wrote 411-448
  player-games across 13-14 games from 7-8 books.
- Credits are fine: 78-84 a run (6 markets x the events that have props;
  events with none, like next week's games, cost nothing), with 18,161 of the
  account's 20,000 a month left on 10-18.
- Thursday's refreshes reached the site within about 90 minutes, before
  Thursday night's kickoff.

**The gap was Sunday.** Upstream's two Sunday pulls landed at 10:05 and 13:43
UTC, ahead of the 1pm ET (17:00 UTC) kickoffs. The site's mirror ran at 08:27,
before either, and not again until 18:26. So at kickoff Start/Sit showed
Saturday's 16:55 numbers, and the morning pulls arrived about 90 minutes into
the games. The mirror now also runs hourly on Sunday mornings (09:17-15:17
UTC). Each run is free and commits only when something changed, and with the
account's 1.5-4.5 hour cron lag several slots are needed for one to land in
the window reliably.

The fully reliable fix is for upstream to trigger the mirror as soon as it
publishes. That is wired up (AI_Agent_work `214cf42`): after its push,
`nfl-props.yml` waits until its Pages copy of `weekly.json` carries the new
stamp, then dispatches `nfl-data-pull.yml` here. It needs an
`EZDUBS_DISPATCH_TOKEN` secret in AI_Agent_work: a fine-grained token limited
to `pjmerica/ez-dubs-website` with Actions read/write. No such token existed on
2026-10-19 (checked the repos' secrets and the local project folders), and only
the owner can create one. Until it exists the step is a no-op and the hourly
Sunday slots cover the gap.

**Also fixed upstream:**
- The Kalshi "player in two matchups" warning fired on every week-6 run for
  CHI and NE D/ST, only because next week's Thursday game was already listed.
  It now flags two games in the same NFL week only, with
  `tests/matchup_conflicts.test.py`. Start/Sit itself was never affected: it
  drops games not on the current board.
- The workflow's cost notes (36 credits, a 500/month tier) and the script's
  "~120 credits" estimate now match what runs actually spend.

The concurrency comments in all three site workflows were also corrected:
GitHub keeps one run waiting and a newer one replaces it, rather than
queueing all of them. For these pulls that loses nothing.

### 23. Mid-game runs put live in-game lines on the board (fixed 2026-10-20)

Found while adding Sunday refreshes. Both prop feeds and the game-lines feed
keep quoting a game after it starts, and those quotes are the live market. Week
5's 19:43 UTC run, with the 1pm games under way, moved those games' Odds API
lines a median 40% (Alvin Kamara receiving yards 13.5 to -5.5, Brock Bowers
74.5 to 129.5) and Kalshi's 61% (Aaron Jones anytime TD 0.645 to 0.03). Games
not yet started moved 0% and 2%. Any Sunday run that GitHub's cron lag pushed
past 1pm ET had been doing this.

Fixed upstream with `scripts/kickoff_lock.py`, used by all three scrapers. A
started game's rows never come from the current run: the previous file's
pregame rows carry forward, marked `lockedAtKickoff`, for 12 hours. The Odds
API scraper also stops paying credits to fetch games in progress. Replaying
week 5's Saturday and Sunday files through it, all 247 Odds API and 178 Kalshi
started-game rows came back equal to Saturday's pregame lines, and every
unstarted row equalled the new run. New `tests/kickoff_lock.test.py`; the
upstream offline suite passes 21 of 21.

With that in place, Sunday refreshes went from 2 to 5 upstream (13:00, 16:00
and 19:00 UTC added, about 1,000 credits a month more, roughly 3,800 of
20,000), and the site's hourly Sunday mirror now runs through 00:17 UTC Monday
so the 4pm and night games get Sunday's lines.

### 24. Sunday refreshes timed to kickoff, not to cron (2026-10-20)

Asked for refreshes about 15 minutes before the 1pm, 4:15 and 8:20 ET games.
Cron can't do that here: scheduled runs start 1.5-4.5 hours late. A
`workflow_dispatch`, though, starts in seconds, and a workflow may dispatch
itself in its own repo with the built-in token. So each repo got a Sunday
chain that cron only starts, early:

- **AI_Agent_work `nfl-kickoff-refresh.yml`**: sleeps until kickoff minus 20
  minutes, refreshes Kalshi, the Odds API, game lines and the Sleeper map
  (inactives come out 90 minutes before kickoff), pushes, and dispatches
  itself for the next window.
- **This repo's `nfl-kickoff-mirror.yml`**: wakes at kickoff minus 17, waits
  until that refresh is live on upstream's Pages, then starts
  `nfl-data-pull.yml` to copy and commit it, and hands on to the next window.

`scripts/kickoff_wait.py` (identical in both repos) reads the kickoff times
from `gamelines.json`, so the November clock change, London games and flexed
night games need no edits. It merges kickoffs within 30 minutes into one
refresh (4:05 and 4:25 become one at 3:45), skips a window already served (so
the backup start and re-runs don't spend credits twice), and caps a single wait
at 5.5 hours against GitHub's 6-hour job limit. The kickoff lock (item 23)
means the 4pm and night refreshes only pay for games still to come. The three
interim Sunday cron slots from earlier the same day were removed.

**Tested live on 2026-10-20** with two injected kickoffs (14:25 and 15:05 UTC):
upstream refreshed at 14:05:00 and pushed; the site woke at 14:08:00, saw the
14:05:01 refresh live, mirrored it, and served it from ezdubsanalytics.com at
14:09:11, 16 minutes before the fake kickoff. Both chains handed on to a second
hop for the 15:05 kickoff, and both second hops refreshed, mirrored and then
stopped, since no kickoffs were left. `tests/kickoff_wait.test.py` (AI_Agent_work) pins
the timing: a real week-6 slate, the clock change, London, served windows, late
starts.

### 25. Design review from screenshots (2026-10-20)

Every page captured at 1440px and, inside a 390px iframe, at phone width.
Headless Chrome won't lay out narrower than 500px, so a phone-size window
screenshot is a cropped 500px layout; the iframe gives the real 390px one.
Fixed:

- **NFL pages looked like another site.** They're built from AI_Agent_work's
  lineup template, whose stylesheet carried its own design. Its body padding
  pushed the site nav 40px in from the top and edges, and the calculator's
  narrow `main` rule (copied over as the donor style) shrank the content under
  a wider header and opened a 40px gap. The accent was purple, the panels
  near-black, the text lavender-grey. There was no site footer, and the
  template's credits line read "data shared with the EZ Dubs Analytics". The
  port script now writes a re-themed copy of the stylesheet (`SITE_THEME`:
  navy panels, site blue, blue-grey text; every text colour re-checked, the
  weakest 5.14:1), adds a small override block (`NFL_SITE_CSS`) for layout and
  dark text on blue buttons, keeps the list of books as a plain note, and adds
  the site footer. Re-running the port changes nothing.
- **Em-dashes in on-screen text:** the two Best Ball season banners, the
  calculator's "not real" warning, the NFL pages' copy (the port swaps them for
  colons), six NFL tooltips and messages (fixed in AI_Agent_work's `app.js`),
  and the exchanges' market titles on the arbs cards (shown with a colon).
- **Best Ball Prices:** the four Top 10 lists are two per row (were four across
  at ~280px, so names and "DraftKings 148.8 / Underdog 174.0" wrapped onto up to
  three lines), with short coloured "DK"/"UD" labels and aligned position
  badges. The Diff columns are coloured by which book is cheaper (DK green, UD
  yellow, as in the lists) rather than good/bad green/red, with header tooltips.
  The description is plain text (the box looked like a disabled input), and the
  two identical position-filter rows are labelled "Lists" and "Table".
- **Risers/Fallers:** same two-per-row lists; movers read "▲ 58.1"/"▼ 47.1"
  (was "-58.1" under "Rising"); the chart opens on the top riser instead of an
  empty box; "Pre-draft/Post-draft" is labelled "NFL Draft (Apr 24)"; the
  legend said "dashed lines = Underdog", but colour marks the book and dash
  patterns mark extra players. The page order now matches Best Ball Prices.
- **Arbs cards:** the line repeating the title word for word is gone (only the
  other market's question shows); the calculator button is quieter, so the
  trade leads; the heading uses a curly apostrophe. (The gap that still shows
  in "Today's" on Windows is Segoe UI Black's apostrophe at weight 800.)
- **Calculator:** the result colours now match the cards that hand off to it
  (YES green, NO red; were blue/amber). The inputs are grouped by side, so a
  phone shows A's fields then B's (was A, B, A, B), and the three results fit
  in one row on a phone.
- **Home:** the archive card spans two columns so the last row is full (was an
  empty slot after it), and the reviews heading has room.

Checked: all site tests pass; the AI_Agent_work offline suite passes 22 of 22.
`lineup_interact.test.js` there had hard-coded "Josh Allen", who wasn't on the
early week-7 board; it now takes a player from the example roster, like the
books-test fix in item 21.

### 26. Interaction states and the signed-in NFL view (2026-10-20)

Driven with puppeteer-core against the local Chrome, to reach what plain
screenshots can't: open menus, keyboard focus, Chart view, the signed-in NFL
pages (as "commissioner", the public account the NFL CI test uses).

- **Bug: "Already played this week" before the week started.** On Tuesday,
  Start/Sit listed Jayden Daniels, Parker Washington and Stefon Diggs as played.
  A player whose team had no line and no props was assumed finished; early in
  the week that's just a thin board. Now absence counts as played only once
  Sleeper's stats show someone has played this week, so those three show under
  "No market projection" with the app's own explanation. Fixed upstream
  (AI_Agent_work `lineup/app.js`) and re-ported.
- **Console error on six pages:** `frame-ancestors` in the CSP `<meta>` is
  ignored by Chrome, which said so on every load. Removed; all six now load
  with a clean console.
- **Nav:** dropdown arrows were 0.7rem at 70% opacity and read as dashes;
  single-level menu links were grey while nested ones were bright (both now
  #cfe0f0); on a phone the nested-menu arrows pointed sideways though the
  submenus open below (rotated). All in `assets/site.css`, one edit.
- **Chart view:** an empty bordered bar sat under "Search players" until a
  player was searched; hidden while empty.
- **NFL:** the slot summary showed Sleeper's raw "WRRB_FLEX" (now "W/R", as on
  the badges), and 13 more on-screen em-dashes in the app became colons.
- **Bug: a failed Sleeper lookup left the last account on screen.** Root
  For/Against kept the previous account's full lists beside "No Sleeper user
  named ...", and Start/Sit kept its league chips. Both clear now (37 rows to
  0, 2 chips to 0 in the test).
- **NFL lineup on phones:** chips in the squeezed market-lines column stacked
  and made each row ~148px; on the bench the slot-badge rule hit the name cell
  and pushed position, game and projection off-screen. Rows are now ~50-59px
  with market lines a swipe away, and the signed-in page went from 3,731px
  tall to 2,892px.
- **Checked and fine:** the phone menu opens by keyboard (Tab to the menu
  button, focus ring shows, Space opens it), desktop dropdowns open on focus,
  and the contact page.

### 27. Accessibility audit with axe-core (2026-10-20)

Every page at 1440px and 390px in real Chrome, including the signed-in NFL
views and the unlocked arbs page. Found and fixed:

- **262 low-contrast position badges** on the Best Ball pages: on their own
  20% wash, QB red was 3.3:1 and WR blue 3.6:1 (AA needs 4.5 at 9.6pt). New
  tints are 5.6:1 or better on every card colour. The "Falling" headings and
  values on Risers/Fallers (#e74c3c, 4.0:1) moved to #ff6b75 (5.6:1).
- **No `<main>` landmark** on the two Best Ball pages, and the NFL sources
  note sat outside every landmark. The pages' wrappers are `<main>` now, and the
  port script puts the note inside `<main>`.
- **#6a6a8a was back** in 15 places in the NFL app (the grey the 2026-10-08 UI
  audit retired; 3.2-3.7:1). Now #8a97a5 upstream.
- **Phone tables were not keyboard-scrollable:** the sideways-scrolling
  `.table-wrap` couldn't take focus. It takes focus now (`tabindex="0"`), with a
  visible focus ring.

After the fixes axe reports nothing on any page at either width. New
`scripts/verify_a11y.test.js` runs it in CI (it fails on the previous commit
with exactly the issues above, and passes now). `axe-core` and
`puppeteer-core` are pinned dev dependencies; the pages themselves still load
no npm packages.

### 28. Click-everything sweep, data sanity, dead CSS (2026-10-21)

- **Every control clicked**, on every page at 1440px and 390px, with the
  calculator also fed edge inputs (0.5/0.5, 0.0001 asks, empty). No script
  errors, console errors or failed requests.
- **Data sanity, live:** arbs have no duplicate market pairs, no settle dates
  in the past, every ask is between 0 and 1, and no after-fee return exceeds
  the gross return its asks imply. NFL lines are all in plausible ranges, with
  no duplicate player-games and nobody in two games.
- **Dead CSS removed:** 44 rules (~4.4 KB) in three pages styled classes that
  no markup or script uses: the history tab that moved out of Best Ball Prices,
  the old four-book source styling, and unused home-page labels. Checked in
  real Chrome: every computed property of 21,306 elements is identical before
  and after, at both widths and in Chart view.
- **Considered and kept: the NFL app's `?t=` cache-buster.** Dropping it in
  favour of `cache: "no-cache"` would turn repeat visits into 304s (~74 KB
  saved, checked that GitHub Pages revalidates the gzip ETag). But the unique
  URL is also what gets past the CDN's 10-minute edge cache, and the pre-kickoff
  refresh (item 24) lands only ~15 minutes before kickoff. Freshness wins over
  74 KB.

### 29. Upstream season scrapers: empty scrapes and timestamp churn (2026-10-21)

In AI_Agent_work (`1257b1c`), the scrapers behind `clay.json` (Mike Clay season
projections) and `data.json` (FantasyPros consensus), both mirrored here:

- **An empty scrape could blank a file.** Run locally, FantasyPros returned 0
  players and the scraper overwrote `data.json` with an empty list (CI normally
  gets ~40). `refuse_collapse()` now keeps the existing file on an empty scrape
  or one under half its current size, with a warning, and still exits 0 so it
  can't stop the rest of the refresh.
- **Timestamp-only rewrites.** Both files were rewritten every run although 7
  of 7 recent updates changed only `lastUpdated`. `write_json_if_changed()`
  keeps the file when nothing else differs, so the stamp means "last changed".

Also checked: the season scrapers take ~25 s of each ~2-minute run, so running
them less often isn't worth the complexity. The live 404 page returns a real
404 status and renders as designed.

A local Windows note: puppeteer's default profile stopped launching Chrome 155
here (2026-10-21); `verify_a11y.test.js` now creates its own throwaway profile.

### 30. Tablet widths and cross-page consistency (2026-10-21)

Every page captured at 768px and 1024px, plus the dashboards' headings measured
in the browser.

- **The nav wrapped onto two or three rows on every tablet.** The menu button
  took over only below 720px, but the full nav needs ~990px in one row. The
  breakpoint is now 1080px (`assets/site.css`, one edit): a 55px bar with the
  menu button up to 1080px, the full 67px nav above it.
- **Best Ball lists at 768px** sat two per row at ~350px and wrapped again;
  one per row below 900px.
- **Arb titles:** the em-dash-to-colon swap produced "nominee?: James Comer";
  after ?, !, : or . the dash now becomes a space.
- **Home reviews** split 2+1 at tablet width; three across now (200px min).
- **Injury tags** broke mid-tag ("Out" / "(Groin)"); kept whole (upstream).
- **Dashboard headings were six slightly different designs:** 28px or 28.8px,
  weight 700 or 800, 87-107px below the top, 14.4px or 14.72px subtitles. Now
  one standard on all six: 1.8rem / 700, 103px down, 0.92rem subtitle, 1.5rem
  on a phone. (Home and Contact keep their larger display headings; the Best
  Ball pages stay centred, as their whole layout is.) Weight 700 also fixes the
  "Today´s" apostrophe, which was Segoe UI Black's glyph at 800.

No sideways overflow on any page at 390, 768 or 1024px. All tests pass,
including the axe audit; the CSP and mobile-layout checks now run locally too.

### 31. Failure and empty states (2026-10-21)

Each page loaded with its data request blocked or failed (puppeteer request
interception), plus the locked, wrong-password, no-arb and form-sent/form-error
states.

- **Best Ball Prices failed silently.** With `latest.json` unreachable it drew
  four empty "Top 0: Biggest % Diff..." cards and a "Showing 0 players" table,
  with nothing saying why. It now says "Could not load the ADP snapshot
  (latest.json returned HTTP 503). Refresh to try again." and hides the tabs.
- **Arb picks hid their own error from locked visitors.** The error went into
  the grid's empty state, which sits behind the password gate, so a visitor
  without the password saw a normal page with no free preview. The notice now
  also shows above the gate, where the freshness warning goes.
- **"unavailable" was link-blue** on both pages' "as of" line, so it read like
  a link. It is muted grey now.
- **NFL pages said nothing when the betting lines failed to load.** The page
  looked normal until a lookup came back with no prices. If both
  `weekly.json` and `oddsapi.json` fail, a red callout now says the lineups
  can't be priced right now (upstream `lineup/app.js` and `style.css`, ported).
  It comes down by itself if a later load succeeds.
- **Contact now uses the dashboard heading standard** (1.8rem / 700, 36px
  below the nav, 1.5rem on a phone). Item 30 left it as a display heading, but
  it is a form page rather than a landing page, and at weight 800 it rendered
  in Segoe UI Black, the only page that did.

Fine as they were: Risers/Fallers' load error, the calculator's "No arb at
these prices" card, the wrong-password message, and the contact form's sent
and error lines.

### 32. Design pass: consistency and copy (2026-10-22)

Every page captured at 1440px and 390px, signed in on the NFL pages and
unlocked on the arbs page.

- **Position colours disagreed between pages.** The NFL pages had RB blue and
  WR green; the Best Ball pages, like Sleeper, have RB green and WR blue. The
  NFL pages now match. K and DEF badges had no style; they are grey now.
- **Game codes ran together:** "GBDET", "NYGHOU". Shown as "GB@DET" now. The
  split lands only on two real team codes, because five letters can split
  either way, and lookups still use the joined code. No spaces, so Root
  For/Against's two side-by-side tables keep their width.
- **On a phone, Start/Sit cut off the projection**, the number the page exists
  for, at the right edge. Below 600px the Game column is hidden and the game
  shows under the player's name.
- **Root For/Against coloured every total green,** so "a net of -18.7" read as
  good news. Only the net is coloured now: green when ahead, red when behind.
- **The calculator said "Guaranteed $8.70" and "Guaranteed profit"** for
  numbers before fees, just under a note saying the real return after fees was
  7.07%. It says "before fees" now, in line with the site's "after fees,
  never guaranteed" copy rule.
- **The NFL pages carried the calculator's entire stylesheet** (about 190
  lines per page). The port lifted the donor page's whole `<style>`, and the
  calculator's `.verdict` rule was quietly styling lineup's verdict boxes. The
  port now lifts only the body and footer rules (`chrome_rules`), and the two
  looks the NFL pages relied on (the boxed verdicts and the header spacing)
  moved into `NFL_SITE_CSS`. A computed-style comparison of all 524 and 342
  elements, at 1440px and 390px, found 0 differences.
- **Unlocked arbs showed the free preview too,** repeating a card that also
  appears in the full list right below it. It is for locked visitors only now.
- **Risers/Fallers had no link from the home page.** The Best Ball card is a
  "2026 archive" card that links to both pages.

### 33. Best Ball table length, sticky header, contact links (2026-10-22)

- **The Best Ball Prices table drew all 429 players**, about 19,700px of page.
  It now shows the first 50 of whatever the sort, position and search give
  ("Showing 50 of 429 players"), with a "Show all 429 players" button below
  that toggles back to "Show top 50 only". Collapsing scrolls the button back
  into view, so a reader at row 400 isn't left at the footer. Page height:
  3,800px by default. Layout only: the frozen 2026 data is untouched.
- **Its sticky header never stuck.** `thead th` was `position: sticky`, but
  the container's `overflow-x: auto` made the container the scroller. From
  900px, where the table fits (it needs ~815px), the container uses
  `overflow: clip`, and the header sits just under the nav (67px, or 55px at
  1080px and below, where the menu button shows). Narrower screens keep the
  horizontal scroll, and phones the card layout.
- **Contact's "Substack" and "Buy Me a Coffee" links** were set apart from the
  surrounding text only by a slightly lighter grey. They are underlined now.

Checked and fine: the Risers/Fallers chart (it draws once Chart.js finishes
its animation; an early screenshot had caught it blank), and the live arbs
data, which was scanned within the hour. A "25 hours old" warning seen locally
came from an out-of-date local copy.

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
- **Nav markup and footers are still per page.** The nav's styles are shared
  now (item 20); its markup is kept in sync by `verify_nav.test.js` and the port
  script, and the footer styles genuinely differ per page.
- **The Chrome-based tests (`verify_csp`, `verify_mobile_layout`) don't run on
  the Windows checkout**: headless Chrome returns an empty DOM. They pass in CI.
  The new card leg text ("Buy YES @ 86¢") is wider than before, so watch the
  first CI mobile-layout run after this lands.
