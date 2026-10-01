/* Lineup — Sleeper start/sit and waiver calls priced off the betting markets.
 *
 * Split out of the nfl-props draft board on 2026-09-20. That page answers a
 * preseason question (who to draft); this one answers a weekly question (who to
 * start), and the two had no reason to share a bundle: this ships 45 KB instead
 * of 147 KB and cannot be broken by an edit to the tier charts or ADP tables.
 *
 * The board itself keeps its own copies of these tabs, so nothing was removed
 * there. Data files are read from ../nfl-props/, which the scraper workflow
 * already refreshes -- there is one source of truth, not a second copy to drift.
 */
(function () {
  // Shared data cache, keyed by the file each view needs.
  const cache = {};

  const DATA_DIR = window.LINEUP_DATA_DIR || "data/";

  async function fetchJson(file) {
    const res = await fetch(DATA_DIR + file + "?t=" + Date.now(), { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }

  // The board's global scoring toggle does not exist here; both views are
  // fixed-format (Start/Sit is half-PPR, My Leagues uses each league's own
  // settings), so this is only read by shared helpers that expect it.
  const fmt = "half";
  let search = "";

  // ── Sleeper session state ──────────────────────────────────────────────────
  // All declared here, before any renderer runs. These are read from view
  // functions that fire on tab entry, so a `const`/`let` further down leaves
  // them in the temporal dead zone.

  // Signed-in user and their leagues, once loaded.
  let sleeperLive = null;
  let sleeperBusy = false;

  // player_id -> {points} for players whose game has kicked off. Null until
  // loadSleeperPlayed fills it; every reader guards on that.
  let sleeperPlayed = null;
  let sleeperPlayedKey = null;

  // Which league each tab is currently showing.
  let sleeperLeagueIdx = 0;

  // Roster picker state. Declared up here with the other shared state because
  // renderSitStart reads it, and a `const` further down leaves it in the
  // temporal dead zone for any synchronous caller.
  const rosterSelected = new Set();
  let suggIndex = -1;

  /* Which books the projections are priced from.
   *
   * An empty set means "no filter -- use everything", which is the right
   * default but made unticking the LAST book indistinguishable from unticking
   * none: activeBooks came back empty, every box redrew ticked, and the
   * numbers jumped back to the full consensus. The click did the opposite of
   * what it looked like. booksAllOff records that the user really did clear
   * the selection.
   */
  // How much of the DraftKings file the current slate actually uses.
  let dkDropped = 0;
  let dkTotal = 0;

  const activeBooks = new Set();
  let booksAllOff = false;

  const BOOK_LABEL = {
    draftkings: "DraftKings",
    fanduel: "FanDuel",
    bovada: "Bovada",
    betrivers: "BetRivers",
    betonlineag: "BetOnline",
    betmgm: "BetMGM",
    fanatics: "Fanatics",
    espnbet: "ESPN BET",
    hardrockbet: "Hard Rock",
    williamhill_us: "Caesars",
    pointsbetus: "PointsBet",
  };

  const NONBOOK_SOURCES = { kalshi: "Kalshi", "dk-td": "DraftKings TD" };

  const KALSHI_METHODS = new Set(
    ["interpolated", "fitted", "assumed-sigma", "expected", "sigma", "fit", "kalshi"]);

  const FIRST_NAME_ALIASES = {
    "ken": "kenneth",
    "kenny": "kenneth",
    "mike": "michael",
    "matt": "matthew",
    "nick": "nicholas",
    "chris": "christopher",
    "tony": "anthony",
    "rob": "robert",
    "bob": "robert",
    "dan": "daniel",
    "danny": "daniel",
    "joe": "joseph",
    "tom": "thomas",
    "will": "william",
    "billy": "william",
    "bill": "william",
    "ben": "benjamin",
    "alex": "alexander",
    "jon": "jonathan",
    "tj": "t j",
    "dj": "d j",
    "aj": "a j",
    "cj": "c j",
    "jk": "j k",
    "dk": "d k",
  };

  /* Whole-name fixes, for splits a first-name rule cannot safely make.
   *
   * A blanket cam -> cameron would merge every Cam with every Cameron, which is
   * wrong more often than it is right, so these are listed one by one. Each was
   * found by grouping the data files on surname and looking for first names
   * where one is a prefix of the other AND the two share a team -- see
   * tests/name_matching.test.js, which re-runs that search.
   *
   * Cost of missing one: Cam Ward is "Cam Ward" to Kalshi, the books and
   * Sleeper but "Cameron Ward" to DraftKings and Clay, so his touchdown line
   * and his projection both failed to join his market lines. Joshua Palmer is
   * priced only for a touchdown, so losing Clay's "Josh Palmer" row meant
   * losing the usage fill that would have made him rankable at all.
   */
  const FULL_NAME_ALIASES = {
    "cam skattebo": "cameron skattebo",
    "quishon judkins": "quinshon judkins",
    "cam ward": "cameron ward",
    "josh palmer": "joshua palmer",
    "chig okonkwo": "chigoziem okonkwo",
  };

  const STAT_LABELS = {
    pass_yds: "Pass Yds",
    pass_tds: "Pass TDs",
    rush_yds: "Rush Yds",
    rush_tds: "Rush TDs",
    rec_yds:  "Rec Yds",
    receptions: "Rec",
    rec_tds:  "Rec TDs",
    any_tds:  "xTD",
  };

  const WEEKLY_SOURCE_LABEL = {
    interpolated: "Kalshi ladder — interpolated 50% strike",
    fitted: "Fitted estimate — ladder never crosses 50%",
    expected: "Expected count — sum of P(X ≥ k) across the ladder",
    books: "Sportsbook consensus — median across books",
    "dk-td": "DraftKings anytime-TD price, de-vigged (P of 1+, so slightly low)",
    projected: "PROJECTION, not a market price — season estimate / 17",
  };

  const LINEUP_SLOTS = [
    { key: "QB", label: "QB", accepts: ["QB"] },
    { key: "RB1", label: "RB", accepts: ["RB"] },
    { key: "RB2", label: "RB", accepts: ["RB"] },
    { key: "WR1", label: "WR", accepts: ["WR"] },
    { key: "WR2", label: "WR", accepts: ["WR"] },
    { key: "TE", label: "TE", accepts: ["TE"] },
    { key: "FLEX1", label: "FLEX", accepts: ["RB", "WR", "TE"] },
    { key: "FLEX2", label: "FLEX", accepts: ["RB", "WR", "TE"] },
  ];

  const SLOT_ACCEPTS = {
    QB: ["QB"], RB: ["RB"], WR: ["WR"], TE: ["TE"],
    FLEX: ["RB", "WR", "TE"],
    WRRB_FLEX: ["RB", "WR"],
    REC_FLEX: ["WR", "TE"],
    SUPER_FLEX: ["QB", "RB", "WR", "TE"],
    K: ["K"], DEF: ["DEF"], DST: ["DEF"],
  };

  /* Short labels for Sleeper's slot names.
   *
   * Sleeper calls a superflex slot "SUPER_FLEX" and a receiver-flex
   * "REC_FLEX". Rendered raw, a ten-character badge forced the Slot column
   * nearly twice as wide as the four slots that actually need it, and read as
   * "SUPER_FLEXKyler Murray" once the name ran into it.
   */
  const SLOT_LABELS = {
    SUPER_FLEX: "SFLEX",
    WRRB_FLEX: "W/R",
    REC_FLEX: "W/T",
    DST: "DEF",
  };

  function slotLabel(slot) {
    return SLOT_LABELS[slot] || slot;
  }


  const SLEEPER_API = "https://api.sleeper.app/v1";

  const SLEEPER_LS_KEY = "nflprops.sleeperUser";

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
    );
  }

  function normPlayerName(s) {
    if (!s) return "";
    let out = s.toLowerCase();
    out = out.replace(/\s+(jr|sr|ii|iii|iv|v)\.?$/i, "");
    out = out.replace(/[^a-z0-9 ]/g, " ");
    out = out.replace(/\s+/g, " ").trim();
    // Canonicalize the first token if it's a known nickname
    const parts = out.split(" ");
    if (parts.length >= 2 && FIRST_NAME_ALIASES[parts[0]]) {
      parts[0] = FIRST_NAME_ALIASES[parts[0]];
      out = parts.join(" ");
    }
    return FULL_NAME_ALIASES[out] || out;
  }

  function altPlayerKey(s) {
    const n = normPlayerName(s);
    if (!n) return "";
    const parts = n.split(" ");
    if (parts.length < 2) return n;
    return parts[0][0] + " " + parts[parts.length - 1];
  }

  function buildProjLookup(data) {
    const byKey = new Map();
    const byAlt = new Map();
    if (!data || !Array.isArray(data.players)) return { byKey, byAlt };
    for (const p of data.players) {
      const k = normPlayerName(p.name);
      const a = altPlayerKey(p.name);
      if (k && !byKey.has(k)) byKey.set(k, p);
      if (a && !byAlt.has(a)) byAlt.set(a, p);
    }
    return { byKey, byAlt };
  }

  function lookupProj(lut, name) {
    return lut.byKey.get(normPlayerName(name)) || lut.byAlt.get(altPlayerKey(name)) || null;
  }

  /* Exact-name lookup, for when a wrong match would be worse than no match.
   *
   * lookupProj falls back to an initial-plus-surname key, which is right for
   * reading a position -- matching the wrong Williams still yields "QB" -- but
   * wrong for copying numbers. It handed CJ Williams (0.045 expected TDs, a
   * deep bench receiver) Caleb Williams's 16.7-point quarterback projection,
   * and the same key collides A.J. Brown with Amon-Ra St. Brown.
   */
  function lookupProjExact(lut, name) {
    return lut.byKey.get(normPlayerName(name)) || null;
  }

  function lineUnderFilter(stat) {
    if (!stat || stat.line == null) return null;
    // A projected fill is not a book, so the book filter has no opinion on it.
    // Dropping it here would make unticking one sportsbook silently delete a
    // projection that sportsbook never provided.
    if (stat.lineSource === "projected") return stat.line;
    if (booksAllOff) return null;
    if (!activeBooks.size) return stat.line;
    // Detect a multi-book stat by the presence of quotes rather than by
    // lineSource, which is added during the merge and absent on raw feed data.
    const quotes = stat.quotes || [];
    if (!quotes.length) {
      // Single-source stats are in or out wholesale. Kalshi records its
      // lineSource as the METHOD used to read its ladder -- interpolated,
      // fitted, assumed-sigma, expected -- not as the venue, so those all map
      // back to the one pseudo-book the checkbox offers.
      const venue = KALSHI_METHODS.has(stat.lineSource) ? "kalshi" : stat.lineSource;
      return activeBooks.has(venue) ? stat.line : null;
    }
    const kept = quotes.filter((q) => activeBooks.has(q.book));
    if (!kept.length) return null;
    const lines = kept.map((q) => q.line).sort((x, y) => x - y);
    const mid = lines.length % 2
      ? lines[(lines.length - 1) / 2]
      : (lines[lines.length / 2 - 1] + lines[lines.length / 2]) / 2;
    return Math.round(mid * 100) / 100;
  }

  // Half-PPR points from a set of market lines.
  //
  // This reads through the book filter. It did not, which meant the Manual
  // Roster tab's "price from these books" control did nothing at all: the pool
  // caches each player's points from here, so unticking Kalshi still left Josh
  // Allen with his xTD 0.75 and an unchanged 23.3. The Sleeper tab was fine
  // because it scores through leaguePoints, which always filtered.
  function weeklyPoints(stats, format) {
    const g = (k) => {
      const v = lineUnderFilter(stats[k]);
      return v == null ? 0 : v;
    };
    let pts = 0;
    pts += g("pass_yds") * 0.04;
    pts += g("pass_tds") * 4;
    pts += g("rush_yds") * 0.1;
    pts += g("rec_yds") * 0.1;
    // any_tds is an EXPECTED count of rushing+receiving TDs, both worth 6.
    // Kalshi posts no split per-game rush/rec TD market, so this single number
    // carries all non-passing scoring. Passing TDs are separate and already
    // counted above, so there is no double count for a QB.
    pts += g("any_tds") * 6;
    if (format === "ppr") pts += g("receptions") * 1.0;
    else if (format === "half") pts += g("receptions") * 0.5;
    return Math.round(pts * 100) / 100;
  }


  function leaguePoints(stats, scoring, position) {
    // Same book filter Start/Sit uses, so a book unticked on either tab means
    // the same thing: re-derive the line from only the books still selected.
    const g = (k) => {
      const v = lineUnderFilter(stats[k]);
      return v == null ? 0 : v;
    };
    let pts = 0;
    pts += g("pass_yds") * 0.04;
    pts += g("pass_tds") * (scoring.passTd != null ? scoring.passTd : 4);
    pts += g("rush_yds") * 0.1;
    pts += g("rec_yds") * 0.1;
    pts += g("any_tds") * 6;
    const rec = g("receptions");
    pts += rec * (scoring.rec || 0);
    // A TE premium is per reception on top of the base rate.
    if (position === "TE" && scoring.bonusRecTe) pts += rec * scoring.bonusRecTe;
    return Math.round(pts * 100) / 100;
  }

  // -- Defense and kicker scoring from the game line ---------------------------
  // Neither position has a prop market worth using. Kalshi posts team-sack,
  // team-turnover and D/ST-touchdown series but leaves every rung unquoted
  // (bid=None/ask=None across the board, checked 2026-09-23), and The Odds API
  // sells no D/ST or K props at all. What both positions DO reduce to is the
  // game line, which is quoted everywhere and is what the books themselves use
  // to price team props.
  //
  // The chain is: total and spread -> each team's implied points -> the fantasy
  // components. Sleeper's own scoring settings supply the rates, so a league
  // that pays 10 for a shutout and one that pays 5 get different numbers off
  // the same line.
  //
  // Backtested against weeks 1-2 of 2026 (63 team-games). The components line
  // up: sacks 2.33 modelled against 2.32-2.41 actual, takeaways 1.11 against
  // 0.91-1.35, points-allowed SD 10.8 against 10.3-11.0. The mean sits about a
  // point low, which is the defensive touchdowns it cannot foresee.
  //
  // What it cannot do is spread: model SD is ~1.4 where real D/ST scores swing
  // ~6. That is inherent -- a game line knows the expected game script and
  // nothing about the pick-six that decides the week -- so these numbers rank
  // defenses sensibly and should not be read as forecasts of an actual score.

  const DST_TEAM_ALIASES = { JAX: "JAC", WSH: "WAS", LAR: "LAR", LA: "LAR" };

  function teamKey(t) {
    const k = String(t || "").toUpperCase();
    return DST_TEAM_ALIASES[k] || k;
  }

  // The Odds API returns every game it has posted, which runs several weeks
  // ahead -- each team appears more than once. Take the team's SOONEST game
  // that has not already kicked off, so a defense is never scored off next
  // week's line.
  function gameLineFor(team) {
    const gl = cache["gamelines"];
    if (!gl || !Array.isArray(gl.games)) return null;
    const t = teamKey(team);
    const now = Date.now();
    let best = null, bestAt = Infinity;
    for (const g of gl.games) {
      if (!g.teams || !g.teams[t]) continue;
      const at = g.kickoff ? Date.parse(g.kickoff) : NaN;
      // A game already under way is still this week's game: keep it rather
      // than skipping ahead, and let the played/locked check retire the slot.
      const score = isNaN(at) ? 0 : (at < now ? now - at : at - now);
      const future = isNaN(at) || at >= now - 4 * 3600 * 1000;
      if (!future) continue;
      if (score < bestAt) { bestAt = score; best = g; }
    }
    if (!best) return null;
    return { ...best.teams[t], matchup: best.matchup, total: best.total,
             kickoff: best.kickoff,
             opp: t === best.home ? best.away : best.home };
  }

  // Probability the opponent lands in each Sleeper points-allowed bucket.
  //
  // NFL team scores are roughly Poisson-ish in shape but overdispersed, and the
  // buckets are wide, so a normal approximation around the implied total is
  // close enough and far more stable than a discrete model fit to one number.
  // SD of ~9.7 is the long-run spread of single-team NFL scores around their
  // closing implied total.
  // SD of a single team's score around its closing implied total. Measured at
  // 10.3 across 96 team-games in weeks 1-3 of 2026 (per week: 11.25, 10.29,
  // 8.73 -- week 3 alone would argue for 8.7, which is why this is not set from
  // one slate). Was 9.7, then 10.8 on two weeks' data.
  const SCORE_SD = 10.3;

  function normCdf(x) {
    // Abramowitz & Stegun 7.1.26 via erf.
    const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t -
                    0.284496736) * t + 0.254829592) * t *
              Math.exp(-x * x / 2);
    return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
  }

  function bucketProbs(mean) {
    // Bucket edges match Sleeper's pts_allow_* keys.
    const edges = [0, 6, 13, 20, 27, 34];
    const p = (v) => normCdf((v + 0.5 - mean) / SCORE_SD);
    const c = edges.map(p);
    return {
      pts_allow_0: c[0],
      pts_allow_1_6: c[1] - c[0],
      pts_allow_7_13: c[2] - c[1],
      pts_allow_14_20: c[3] - c[2],
      pts_allow_21_27: c[4] - c[3],
      pts_allow_28_34: c[5] - c[4],
      pts_allow_35p: 1 - c[5],
    };
  }

  // Expected sacks and takeaways scale with how much the opponent trails and
  // has to throw. Baselines measured over 96 team-games in weeks 1-3 of 2026:
  // 2.20 sacks and 1.16 takeaways per team-game. Both move around by week --
  // sacks ran 2.25 / 2.41 / 1.94 and takeaways 1.31 / 0.91 / 1.25 -- so these
  // are the pooled means, not the latest week's.
  //
  // Each point of favouredness is worth a little of both, since trailing teams
  // pass more and pass worse.
  function dstVolume(spread) {
    const fav = -(spread || 0);              // +7 means a 7-point favourite
    return {
      sacks: Math.max(0.8, 2.20 + fav * 0.055),
      takeaways: Math.max(0.35, 1.16 + fav * 0.030),
    };
  }

  function dstPoints(team, scoring) {
    const line = gameLineFor(team);
    if (!line) return null;
    const sc = (scoring && scoring.raw) || {};
    const n = (k, d) => (sc[k] != null ? sc[k] : d);

    const probs = bucketProbs(line.oppImplied);
    let pts = 0;
    for (const k of Object.keys(probs)) pts += probs[k] * n(k, 0);

    const vol = dstVolume(line.spread);
    pts += vol.sacks * n("sack", 1);

    // Sleeper splits a takeaway into interception and fumble recovery. Measured
    // at 58/42 over weeks 1-2; a forced fumble is scored alongside the recovery
    // where the league pays for it.
    const ints = vol.takeaways * 0.58;
    const fums = vol.takeaways * 0.42;
    pts += ints * n("int", 2);
    pts += fums * n("fum_rec", 2);
    pts += fums * n("ff", 0);

    // Defensive and special-teams touchdowns: ~0.12 per team-game combined.
    pts += 0.08 * n("def_td", 6);
    pts += 0.04 * n("def_st_td", 6);
    pts += 0.035 * n("safe", 2) * 0.5;
    pts += 0.05 * n("blk_kick", 2);

    return {
      points: Math.round(pts * 100) / 100,
      matchup: line.matchup,
      oppImplied: line.oppImplied,
      spread: line.spread,
      detail: { sacks: vol.sacks, takeaways: vol.takeaways, probs },
    };
  }

  // A kicker's team total splits into touchdowns and stalled drives. Roughly,
  // a team scoring T points gets there via ~T/9.3 touchdowns and ~T/10.5 field
  // goals; the residual after TDs and FGs is two-point and defensive scoring,
  // which the kicker does not touch.
  function kickerPoints(team, scoring) {
    const line = gameLineFor(team);
    if (!line) return null;
    const sc = (scoring && scoring.raw) || {};
    const n = (k, d) => (sc[k] != null ? sc[k] : d);
    const T = line.implied;

    const tds = Math.max(0, T / 9.3);
    const fgs = Math.max(0, T / 10.5);
    const xps = tds * 0.94;                  // conversion rate, net of 2-pt tries

    // FG distance mix, league-average: most attempts are 30-49 yards. Leagues
    // that pay per yard instead of per bucket are handled by fgm_yds.
    const mix = { fgm_0_19: 0.02, fgm_20_29: 0.17, fgm_30_39: 0.30,
                  fgm_40_49: 0.30, fgm_50p: 0.21 };
    let pts = 0;
    let bucketed = false;
    for (const k of Object.keys(mix)) {
      let rate = n(k, null);
      if (k === "fgm_50p" && rate == null) {
        // Some leagues split 50+ into 50-59 and 60+.
        const a = n("fgm_50_59", null), b = n("fgm_60p", null);
        if (a != null || b != null) {
          rate = (a || 0) * 0.85 + (b || 0) * 0.15;
        }
      }
      if (rate) { pts += fgs * mix[k] * rate; bucketed = true; }
    }
    // Flat per-make and per-yard scoring, for leagues that use them instead.
    pts += fgs * n("fgm", 0);
    pts += fgs * 38 * n("fgm_yds", 0);
    if (!bucketed && !n("fgm", 0) && !n("fgm_yds", 0)) pts += fgs * 3;

    pts += xps * n("xpm", 1);
    pts += fgs * 0.16 * n("fgmiss", 0);      // ~16% of attempts miss

    return {
      points: Math.round(pts * 100) / 100,
      matchup: line.matchup,
      implied: T,
      detail: { fgs, xps },
    };
  }

  // One entry point so callers do not have to branch on position.
  function specialPoints(position, team, scoring) {
    if (position === "DEF") return dstPoints(team, scoring);
    if (position === "K") return kickerPoints(team, scoring);
    return null;
  }

  // -- Coverage / freshness ----------------------------------------------------
  // Sportsbooks do not post player props for Sunday games until roughly
  // Thursday night. Measured on week 2: a Saturday pull had 15 games and 206
  // player-games priced; a Wednesday pull of week 3 had the Thursday-night
  // game fully priced and four Sunday games with nothing at all.
  //
  // Without saying so, a midweek board looks like a confident projection of
  // zero for half the slate, which is how "my starter is missing" reads as the
  // page being broken. This measures how much of the slate is actually priced
  // and warns while it is still filling in.
  function coverageState() {
    const gl = cache["gamelines"];
    const wkd = cache["weekly"];
    if (!gl || !Array.isArray(gl.games) || !wkd) return null;

    const now = Date.now();
    // This week's games only: everything before the last kickoff still ahead
    // of us, which excludes the future weeks the odds feed also returns.
    const upcoming = gl.games
      .filter((g) => g.kickoff && Date.parse(g.kickoff) > now - 4 * 3600 * 1000)
      .sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff))
      .slice(0, 16);
    if (!upcoming.length) return null;

    // A game counts as priced when books quote player props for it, which is
    // what the lineup optimizer actually needs. Kalshi alone is not enough --
    // it posts ladders for games the books have not opened yet.
    const byGame = new Map();
    const od = cache["oddsapi"];
    for (const pl of ((od && od.players) || [])) {
      const m = (pl.matchup || "").trim();
      if (m) byGame.set(m, (byGame.get(m) || 0) + 1);
    }
    let priced = 0;
    const thin = [];
    for (const g of upcoming) {
      const n = byGame.get(g.matchup) || 0;
      if (n >= 6) priced++;
      else thin.push({ matchup: g.matchup, n, kickoff: g.kickoff });
    }
    const nextKick = Date.parse(upcoming[0].kickoff);
    return {
      total: upcoming.length, priced, thin,
      hoursToFirst: (nextKick - now) / 3600000,
    };
  }

  // How many players in the pool are carrying a projected fill rather than a
  // posted line. Stated alongside the coverage count, since the two together
  // are the honest picture of a midweek board.
  function projFillCount() {
    try {
      const pool = buildSitStartPoolFull();
      let n = 0;
      pool.forEach((p) => { if (p.projFilled) n++; });
      return n;
    } catch (e) {
      return 0;
    }
  }

  function coverageBanner() {
    const c = coverageState();
    if (!c || !c.thin.length) return "";
    // Close to kickoff a missing line is real information -- the book has
    // decided not to price him. Days out it is just early.
    const early = c.hoursToFirst > 20;
    const names = c.thin.map((t) => escapeHtml(t.matchup)).join(", ");
    return '<div class="coverage-note' + (early ? " early" : "") + '">' +
      "<strong>" + c.priced + " of " + c.total +
      " games have player props posted.</strong> " +
      (early
        ? "Books do not open most Sunday props until Thursday night, so the " +
          "board fills in over the next day or two. Players in an unpriced " +
          "game are listed under <em>No market projection</em> rather than " +
          "ranked &mdash; that is a missing line, not a low projection."
        : "Still waiting on: " + names + ". Players in those games are listed " +
          "under <em>No market projection</em> rather than ranked.") +
      (early ? " Waiting on " + names + "." : "") +
      (function () {
        // A source whose every entry is off-slate is stale, not empty, and the
        // difference matters: DraftKings only refreshes on a local run, so it
        // can outlive its week without anything saying so.
        if (dkTotal > 0 && dkDropped === dkTotal) {
          return ' <span class="coverage-sub">The DraftKings touchdown file is ' +
            "from a previous week &mdash; all " + dkTotal + " entries are for " +
            "games already played, so it is contributing nothing. Anytime-TD " +
            "prices are missing until it is re-run.</span>";
        }
        return "";
      })() +
      (function () {
        const n = projFillCount();
        if (!n) return "";
        return " <span class=\"coverage-sub\">" + n + " player" +
          (n === 1 ? " is" : "s are") + " ranked on a season projection " +
          "(marked ≈) because the market priced only a touchdown for " +
          "them &mdash; a baseline, not a price.</span>";
      })() +
      "</div>";
  }

  /* Chips for the game-line positions.
   *
   * These used to read "opp 20.0sk 2.5to 1.2", which is three problems at
   * once: the class was stat-chip, which does not exist in the stylesheet, so
   * they rendered as unstyled text with no spacing or borders and ran into each
   * other; the abbreviations were opaque; and nothing said these come from the
   * game line rather than a player prop. Same markup as weeklyChips now, with
   * labels that read as words.
   */
  function specialChips(p) {
    const sp = p && p.special;
    if (!sp) return "";
    const chip = (label, value, title) =>
      '<span class="market-chip src-gameline" title="' + escapeHtml(title) + '">' +
      '<span class="mk-label">' + escapeHtml(label) + "</span> " +
      escapeHtml(value) + "</span>";

    const line = "Derived from the game line, not a player prop: no book " +
      "prices kickers or defenses directly.";
    const out = [];
    if (p.position === "DEF") {
      out.push(chip("Opp pts", sp.oppImplied.toFixed(1),
        "Points the opponent is expected to score, from the spread and total. " +
        "This is what drives the points-allowed buckets, which is most of D/ST " +
        "scoring. " + line));
      out.push(chip("Sacks", sp.detail.sacks.toFixed(1),
        "Expected sacks. Scales with how big a favourite this defense is, " +
        "since trailing teams pass more. " + line));
      out.push(chip("Takeaways", sp.detail.takeaways.toFixed(1),
        "Expected interceptions plus fumble recoveries. " + line));
    } else {
      out.push(chip("Team pts", sp.implied.toFixed(1),
        "Points this kicker's own team is expected to score, from the spread " +
        "and total. It splits into the field goals and extra points below. " +
        line));
      out.push(chip("FG", sp.detail.fgs.toFixed(1),
        "Expected field goals made. " + line));
      out.push(chip("XP", sp.detail.xps.toFixed(1),
        "Expected extra points made. " + line));
    }
    return out.join("");
  }

  function weeklyChips(p) {
    const order = ["pass_yds", "pass_tds", "rush_yds", "receptions", "rec_yds", "any_tds"];
    const parts = [];
    for (const k of order) {
      const s = p.stats[k];
      if (!s || s.line == null) continue;
      const dec = k === "any_tds" ? 2
                : (k.endsWith("_tds") || k === "receptions") ? 1 : 0;
      const cls = s.lineSource === "projected" ? "src-proj"
                : s.lineSource === "fitted" ? "src-fit"
                : s.lineSource === "books" ? "src-fanduel"
                : s.lineSource === "dk-td" ? "src-bovada" : "src-kalshi";
      // A projected fill carries a distinct mark so it never reads as a
      // posted line at a glance.
      const mark = s.lineSource === "projected" ? "≈"
                 : s.lineSource === "fitted" ? "~" : "";
      // Name each book and the number it posted, so a consensus is auditable
      // rather than a black box. Books that agree collapse to one line; the
      // interesting case is the one that disagrees.
      let detail;
      if (s.lineSource === "books") {
        const q = (s.quotes || []).slice()
          .sort((x, y) => x.line - y.line || x.book.localeCompare(y.book));
        detail = q.length
          ? q.map((x) => `${BOOK_LABEL[x.book] || x.book} ${x.line}` +
                         (x.odds != null ? ` (${x.odds > 0 ? "+" : ""}${x.odds})` : ""))
             .join("\n")
          : `${s.books} book${s.books === 1 ? "" : "s"}`;
        if (s.min !== s.max) detail += `\nspread ${s.min}–${s.max}`;
      } else if (s.lineSource === "dk-td") {
        detail = `DraftKings ${s.odds}`;
      } else if (s.lineSource === "projected") {
        detail = "Mike Clay season projection / 17. No book posted this " +
          "market, so this is a neutral-matchup baseline, not a price.";
      } else {
        detail = `${s.rungs} strikes`;
      }
      // A line the book filter excluded still shows, struck through, so it is
      // obvious the number exists and why it is not counted -- rather than the
      // stat silently vanishing and the total dropping for no visible reason.
      const off = lineUnderFilter(s) == null;
      parts.push(
        `<span class="market-chip ${cls}${off ? " stat-off" : ""}${s.lineSource === "books" && s.min !== s.max ? " book-split" : ""}" ` +
        `title="${escapeHtml(WEEKLY_SOURCE_LABEL[s.lineSource] || "")}\n${escapeHtml(detail)}">` +
        `<span class="mk-label">${escapeHtml(STAT_LABELS[k] || k)}</span> ` +
        `${mark}${s.line.toFixed(dec)}</span>`
      );
    }
    return `<div class="markets">${parts.join("")}</div>`;
  }

  function bookToggleHTML() {
    const counts = new Map();
    const oa = cache["oddsapi"];
    if (oa && Array.isArray(oa.players)) {
      for (const p of oa.players) {
        for (const v of Object.values(p.stats || {})) {
          for (const q of (v.quotes || [])) {
            counts.set(q.book, (counts.get(q.book) || 0) + 1);
          }
        }
      }
    }
    if (cache["weekly"]) counts.set("kalshi", (cache["weekly"].players || []).length);
    if (cache["dktd"]) counts.set("dk-td", (cache["dktd"].players || []).length);

    // On a cold open nothing is cached yet, and returning "" left the box
    // blank until something forced a redraw -- which looked like the toggles
    // needing a click to appear. Fall back to the known sources with no counts
    // so the control is always present; real counts fill in on the redraw.
    if (!counts.size) {
      for (const b of ["fanduel", "draftkings", "bovada", "betonlineag",
                       "betrivers", "betmgm", "fanatics", "kalshi", "dk-td"]) {
        counts.set(b, 0);
      }
    }

    return [...counts.entries()].sort((x, y) => y[1] - x[1]).map(([book, n]) => {
      const label = BOOK_LABEL[book] || NONBOOK_SOURCES[book] || book;
      const on = booksAllOff ? false
               : (!activeBooks.size || activeBooks.has(book));
      return "<label><input type=\"checkbox\" data-book=\"" + escapeHtml(book) + "\"" +
        (on ? " checked" : "") + " /> " + escapeHtml(label) +
        (n ? ' <span class="book-count">' + n + "</span>" : "") + "</label>";
    }).join("");
  }

  function applyBookToggle(boxes) {
    const checked = boxes.filter((b) => b.checked);
    activeBooks.clear();
    booksAllOff = boxes.length > 0 && checked.length === 0;
    if (checked.length !== boxes.length) {
      for (const b of checked) activeBooks.add(b.dataset.book);
    }
    // The chip swap counts are derived from filtered projections, so they are
    // stale the moment the filter moves. Cleared here rather than at each call
    // site so a new toggle cannot forget to do it.
    clearSwapCounts();
  }

  /* Per-game baseline from a season projection.
   *
   * 198 of 297 players on the week 3 board had a touchdown line and nothing
   * else, which the tdOnly rule correctly refuses to rank -- 0.56 expected TDs
   * is 3.4 points, and that is not a Jonathan Taylor projection. But dropping
   * him entirely is worse than showing a floor: it emptied lineup slots while a
   * genuine starter sat in a "no market projection" list, which is how a thin
   * Wednesday board reads as a broken page.
   *
   * Mike Clay's season numbers cover 424 players, so a seventeenth of them is a
   * defensible neutral-matchup baseline. It is NOT a market price and is
   * labelled as such everywhere it surfaces: no book posted it, it ignores this
   * week's opponent, and it does not move when a book filter changes.
   */
  const GAMES_IN_SEASON = 17;

  // Only stats the weekly board also carries, so a filled gap is comparable to
  // a real line rather than introducing a category nothing else prices.
  const PROJ_FILL_STATS = ["pass_yds", "pass_tds", "rush_yds", "rec_yds",
                           "receptions"];

  function projPerGame(proj) {
    if (!proj || !proj.stats) return null;
    const out = {};
    for (const k of PROJ_FILL_STATS) {
      const v = proj.stats[k];
      if (typeof v === "number" && isFinite(v) && v > 0) {
        out[k] = Math.round((v / GAMES_IN_SEASON) * 10) / 10;
      }
    }
    return Object.keys(out).length ? out : null;
  }

  function buildSitStartPoolFull() {
    const wk = cache["weekly"], oa = cache["oddsapi"], dk = cache["dktd"];
    const merged = new Map();
    if (wk && Array.isArray(wk.players)) {
      for (const p of wk.players) {
        merged.set(normPlayerName(p.name), { ...p, stats: { ...p.stats } });
      }
    }
    if (oa && Array.isArray(oa.players)) {
      for (const p of oa.players) {
        const k = normPlayerName(p.name);
        let rec = merged.get(k);
        if (!rec) { rec = { name: p.name, matchup: p.matchup, stats: {} }; merged.set(k, rec); }
        for (const [statKey, v] of Object.entries(p.stats || {})) {
          if (v.line != null) {
            rec.stats[statKey] = {
              line: v.line, lineSource: "books", books: v.books,
              min: v.min, max: v.max, quotes: v.quotes || [],
            };
          }
        }
      }
    }
    if (dk && Array.isArray(dk.players)) {
      /* Only entries whose game is on the current board.
       *
       * The scraper refuses to overwrite a good file with nothing, which stops a
       * rate-limited run from wiping the data -- but nothing stopped that kept
       * file being served after its games had played. DraftKings blocks CI
       * runners, so this file only refreshes on a local run, and it sat two days
       * stale across the week 3/4 rollover: every entry was a week 3 game while
       * the rest of the board had moved to week 4. Without this check last
       * week's touchdown numbers merged straight into this week's lines.
       */
      const liveGames = new Set();
      for (const p of ((wk && wk.players) || [])) {
        if (p.matchup) liveGames.add(p.matchup);
      }
      for (const p of ((oa && oa.players) || [])) {
        if (p.matchup) liveGames.add(p.matchup);
      }
      let dropped = 0;
      for (const p of dk.players) {
        // shortMatchup turns "TEN Titans @ NY Giants" into "TENNYG", which is
        // how the other feeds spell it.
        if (liveGames.size && !liveGames.has(shortMatchup(p.matchup))) {
          dropped++;
          continue;
        }
        const k = normPlayerName(p.name);
        let rec = merged.get(k);
        if (!rec) { rec = { name: p.name, matchup: p.matchup, stats: {} }; merged.set(k, rec); }
        const cur = rec.stats.any_tds;
        if (!cur || cur.line == null) {
          rec.stats.any_tds = { line: p.xTD, lineSource: "dk-td", odds: p.americanOdds };
        }
      }
      // Read by the coverage banner, so a wholly stale source is stated rather
      // than silently contributing nothing.
      dkDropped = dropped;
      dkTotal = dk.players.length;
    }

    const fpLut = buildProjLookup(cache["data"]);
    const clayLut = buildProjLookup(cache["clay"]);
    const pool = new Map();
    for (const [key, p] of merged) {
      const fp = lookupProj(fpLut, p.name), clay = lookupProj(clayLut, p.name);
      const priced = Object.values(p.stats).filter((s) => s.line != null);
      const tdOnly = priced.length === 1 && p.stats.any_tds &&
                     p.stats.any_tds.line != null;

      // Fill usage from the season projection when the market priced only a
      // touchdown. Clay first because it covers 424 players against the
      // FantasyPros feed's 40 -- FantasyPros only serves a dozen rows per
      // position without JavaScript, so that file is a thin fallback.
      let filled = false;
      if (tdOnly) {
        // Exact match only: a filled stat line is a number, and the loose
        // surname key is not safe for numbers.
        const clayExact = lookupProjExact(clayLut, p.name);
        const fpExact = lookupProjExact(fpLut, p.name);
        const perGame = projPerGame(clayExact) || projPerGame(fpExact);
        if (perGame) {
          for (const [statKey, v] of Object.entries(perGame)) {
            if (p.stats[statKey] && p.stats[statKey].line != null) continue;
            p.stats[statKey] = { line: v, lineSource: "projected" };
            filled = true;
          }
        }
      }

      pool.set(key, {
        name: p.name,
        matchup: p.matchup || "",
        position: (fp && fp.position) || (clay && clay.position) || null,
        points: weeklyPoints(p.stats, "half"),
        stats: p.stats,
        // Still flagged as unpriced usage even once filled, so callers that
        // want market-only numbers can still tell the difference.
        tdOnly: tdOnly && !filled,
        projFilled: filled,
        statCount: priced.length,
      });
    }
    return pool;
  }

  function bestLineup(players) {
    let best = null;
    const n = players.length;
    const used = new Array(n).fill(false);
    const current = new Array(LINEUP_SLOTS.length).fill(null);

    function recurse(slotIdx, total) {
      if (slotIdx === LINEUP_SLOTS.length) {
        if (!best || total > best.total) best = { total, picks: current.slice() };
        return;
      }
      const slot = LINEUP_SLOTS[slotIdx];
      let filled = false;
      for (let i = 0; i < n; i++) {
        if (used[i]) continue;
        const p = players[i];
        if (!p.position || !slot.accepts.includes(p.position)) continue;
        used[i] = true;
        current[slotIdx] = p;
        filled = true;
        recurse(slotIdx + 1, total + p.points);
        used[i] = false;
        current[slotIdx] = null;
      }
      // A slot with nobody eligible stays empty rather than aborting the search
      // -- a roster with no TE should still get its other seven slots filled.
      if (!filled) {
        current[slotIdx] = null;
        recurse(slotIdx + 1, total);
      }
    }
    recurse(0, 0);
    return best;
  }

  /* Exhaustive slot assignment, with a bound so it stays fast.
   *
   * Greedy is wrong here -- a flex slot means the best player for slot N
   * depends on what slots N+1.. still need -- so the search really does have
   * to consider combinations. But plain recursion is exponential, and a
   * dynasty roster is not small: 36 players over 11 slots with five flex spots
   * took over a minute of solid blocking, which on a page reads as a freeze.
   * Measured before the bound: 12 players 19ms, 16 players 1.0s, 20 players
   * 11s, 24 players 68s.
   *
   * The bound is the standard one. Precompute, for each slot index, the sum of
   * the best remaining points any slot from there on could contribute; if the
   * running total plus that ceiling cannot beat the best complete lineup found
   * so far, the branch is abandoned. Ordering candidates best-first makes a
   * strong incumbent appear immediately, which is what makes the bound bite.
   * This prunes only branches that provably cannot win, so the answer is still
   * the exact optimum -- verified against brute force on 5,500 random rosters.
   */
  function bestLineupForSlots(players, slots) {
    // Only slots.length players can ever be placed, so keeping more than that
    // many candidates per slot cannot change the answer.
    const eligible = slots.map((slot) => {
      const accepts = SLOT_ACCEPTS[slot] || [];
      return players
        .map((p, i) => ({ p, i }))
        .filter((x) => x.p.position && accepts.includes(x.p.position))
        .sort((a, b) => b.p.points - a.p.points)
        .slice(0, slots.length)
        .map((x) => x.i);
    });

    // Ceiling for slots si..end: the best single score each could add, summed.
    // Generous on purpose -- it ignores that one player cannot fill two slots,
    // which is what keeps it a valid upper bound.
    const bestPer = eligible.map((idxs) =>
      idxs.length ? Math.max(...idxs.map((i) => players[i].points), 0) : 0);
    const suffixMax = new Array(slots.length + 1).fill(0);
    for (let i = slots.length - 1; i >= 0; i--) {
      suffixMax[i] = suffixMax[i + 1] + Math.max(bestPer[i], 0);
    }

    let best = null;
    const used = new Array(players.length).fill(false);
    const current = new Array(slots.length).fill(null);

    function recurse(si, total) {
      if (si === slots.length) {
        if (!best || total > best.total) best = { total, picks: current.slice() };
        return;
      }
      // Cannot possibly catch the incumbent: stop.
      if (best && total + suffixMax[si] <= best.total) return;

      let filled = false;
      for (const idx of eligible[si]) {
        if (used[idx]) continue;
        used[idx] = true;
        current[si] = players[idx];
        filled = true;
        recurse(si + 1, total + players[idx].points);
        used[idx] = false;
        current[si] = null;
      }
      // An empty slot is legitimate: a roster with no kicker should still get
      // the rest of its lineup rather than failing outright.
      if (!filled) {
        current[si] = null;
        recurse(si + 1, total);
      }
    }
    recurse(0, 0);
    return best || { total: 0, picks: current.slice() };
  }

  function slotTable(rows, total, unpriced, unmatched, bench) {
    let html = "";
    if (rows.length) {
      html += '<table class="slot-table"><thead><tr>' +
        '<th>Slot</th><th>Player</th><th>Pos</th><th>Game</th>' +
        '<th style="text-align:right">Proj</th>' +
        "<th>Market lines</th></tr></thead><tbody>";
      for (const r of rows) {
        const isFlex = r.slot === "FLEX";
        const badge = '<span class="slot-badge' + (isFlex ? " flex" : "") + '">' +
                      escapeHtml(slotLabel(r.slot)) + "</span>";
        if (!r.p) {
          html += '<tr class="bench-row"><td>' + badge +
                  '</td><td colspan="5">nobody eligible</td></tr>';
          continue;
        }
        html += "<tr><td>" + badge + "</td>" +
          '<td class="player-name">' + escapeHtml(r.p.name) +
          projTag(r.p) + "</td>" +
          '<td><span class="pos-badge pos-' + escapeHtml(r.p.position || "?") + '">' +
          escapeHtml(r.p.position || "?") + "</span></td>" +
          '<td class="weekly-game">' + escapeHtml(shortMatchup(r.p.matchup) || "-") + "</td>" +
          '<td style="text-align:right"><span class="market-pts">' +
          r.p.points.toFixed(1) + "</span></td>" +
          "<td>" + (r.p.stats ? weeklyChips(r.p) : specialChips(r.p)) +
          "</td></tr>";
      }
      html += "</tbody></table>";
    }
    if (total != null) {
      html += '<div class="sitstart-total">Projected lineup total: ' +
              total.toFixed(1) + " half-PPR</div>";
    }
    if (bench && bench.length) {
      html += '<div class="sitstart-section">Bench</div><table class="slot-table"><tbody>';
      for (const p of bench) {
        html += '<tr class="bench-row"><td class="player-name">' +
          escapeHtml(p.name) + projTag(p) + "</td>" +
          '<td><span class="pos-badge pos-' + escapeHtml(p.position || "?") + '">' +
          escapeHtml(p.position || "?") + "</span></td>" +
          '<td class="weekly-game">' + escapeHtml(shortMatchup(p.matchup) || "-") + "</td>" +
          '<td style="text-align:right">' + p.points.toFixed(1) + "</td>" +
          "<td>" + (p.stats ? weeklyChips(p) : specialChips(p)) + "</td></tr>";
      }
      html += "</tbody></table>";
    }
    if (unpriced && unpriced.length) {
      html += '<div class="sitstart-section">No usage priced</div>' +
        '<div class="verdict" style="font-size:13px">' +
        escapeHtml(unpriced.map((p) => p.name).join(", ")) +
        '<br /><span style="color:#6a6a8a">A book pricing a touchdown but no ' +
        "yardage usually means an unsettled role. Treat as start-at-your-own-risk, " +
        "not as a zero.</span></div>";
    }
    if (unmatched && unmatched.length) {
      html += '<div class="sitstart-section">Not recognised</div>' +
        '<div class="verdict" style="font-size:13px"><span class="unmatched">' +
        escapeHtml(unmatched.join(", ")) + "</span></div>";
    }
    return html;
  }

  function freeAgentsFor(lg, rosteredKeys, currentStarters) {
    const pool = buildSitStartPoolFull();
    const slots = lg.slots || [];

    // The honest question for a pickup is not "does he beat my worst flex
    // player" -- that compares a tight end against a running back and reads as
    // nonsense. It is "would adding him raise my optimal lineup total", so each
    // candidate is re-optimized into the actual roster and the gain measured.
    // This needs no per-position special cases and handles superflex, extra
    // flex slots and TE premiums for free.
    const baseLineup = bestLineupForSlots(currentStarters, slots);
    const base = baseLineup.total;

    // Re-optimizing for every unrostered player is wasteful: most of a 200-name
    // wire cannot possibly crack the lineup. A candidate can only help if he
    // beats the weakest starter in SOME slot he is eligible for, so that cheap
    // test prunes the list first -- it is a necessary condition for any gain,
    // so nothing that could help is discarded.
    let weakestStarter = Infinity;
    for (const p of baseLineup.picks) {
      if (p && p.points < weakestStarter) weakestStarter = p.points;
    }
    const emptySlot = baseLineup.picks.some((p) => !p);

    const candidates = [];
    for (const [key, p] of pool) {
      if (rosteredKeys.has(key)) continue;
      if (!p.position || p.tdOnly) continue;
      const pts = leaguePoints(p.stats, lg.scoring, p.position);
      if (pts <= 0) continue;
      // An unfilled slot means anyone eligible is a gain, so skip the prune.
      // Note this is why already-played players must NOT be dropped silently:
      // their absence would open a slot and make every pickup look free.
      if (!emptySlot && pts <= weakestStarter) continue;
      candidates.push({ p, pts });
    }

    /* Kickers and defenses, which the prop pool cannot supply.
     *
     * They were absent from the wire entirely: no kicker appears in the pool
     * at all, and Kalshi names a defense "ATL Falcons D/ST" where Sleeper says
     * "Atlanta Falcons", so the rostered-key check never matched and neither
     * did anything else. In a league with K and DEF slots that meant the
     * waiver list could not suggest one even with the slot empty.
     *
     * The game-line model prices both, and the Sleeper player map is the
     * authority on who exists and what they are called, so the candidates come
     * from there.
     */
    if (slots.includes("K") || slots.includes("DEF") || slots.includes("DST")) {
      const pmap = (cache["sleeperPlayers"] || {}).players || {};
      for (const pid of Object.keys(pmap)) {
        const e = pmap[pid];
        const pos = e[1] === "DST" ? "DEF" : e[1];
        if (pos !== "K" && pos !== "DEF") continue;
        if (!slots.includes(pos) && !(pos === "DEF" && slots.includes("DST"))) {
          continue;
        }
        if (rosteredKeys.has(normPlayerName(e[0]))) continue;
        // A player whose game has kicked off cannot be picked up and started.
        if (sleeperPlayed && sleeperPlayed.get(String(pid))) continue;
        const sp = specialPoints(pos, e[2], lg.scoring);
        if (!sp || sp.points <= 0) continue;
        if (!emptySlot && sp.points <= weakestStarter) continue;
        candidates.push({
          p: { name: e[0], position: pos, matchup: sp.matchup,
               stats: null, special: sp },
          pts: sp.points,
        });
      }
    }

    const out = [];
    for (const { p, pts } of candidates) {
      const withHim = bestLineupForSlots(
        currentStarters.concat([{
          name: p.name, position: p.position,
          matchup: p.matchup, points: pts, wasStarter: false,
        }]), slots);
      const gain = Math.round((withHim.total - base) * 10) / 10;
      if (gain <= 0) continue;

      // Name who he displaces, which is the part that makes the gain legible.
      const nowStarting = new Set(withHim.picks.filter(Boolean).map((x) => x.name));
      const dropped = baseLineup.picks.filter(
        (x) => x && !nowStarting.has(x.name));
      out.push({
        name: p.name,
        position: p.position,
        matchup: p.matchup,
        points: pts,
        stats: p.stats,
        special: p.special || null,
        upgrade: gain,
        replaces: dropped.length ? dropped[0] : null,
      });
    }
    out.sort((a, b) => b.upgrade - a.upgrade || b.points - a.points);

    /* Cap kickers and defenses at the best two each.
     *
     * Their projections cluster inside a couple of points of one another -- ten
     * kickers sat between +0.1 and +2.7 in one league -- so a list sorted
     * purely by gain filled with eight kickers and buried the skill-position
     * pickups that are actually worth a roster move. Two is enough to say "your
     * kicker is beatable and here is who by"; the rest is noise.
     */
    const capped = [];
    let nK = 0, nD = 0;
    for (const f of out) {
      if (f.position === "K") { if (nK >= 2) continue; nK++; }
      else if (f.position === "DEF") { if (nD >= 2) continue; nD++; }
      capped.push(f);
    }
    return capped;
  }

  function freeAgentTable(fas, lg) {
    const gains = fas.slice(0, 12);
    if (!gains.length) {
      return '<div class="sitstart-section">Free agents</div>' +
        '<div class="verdict" style="font-size:13px;color:#6a6a8a">' +
        "Nothing on the wire projects above your current starters this week." +
        (fas.length ? " (" + fas.length + " unrostered players do have lines.)" : "") +
        "</div>";
    }
    let html = '<div class="sitstart-section">Best available &mdash; ranked by ' +
      "how much they would add to your optimal lineup</div>" +
      '<div class="table-wrap"><table class="slot-table"><thead><tr>' +
      "<th>Player</th><th>Pos</th><th>Game</th>" +
      '<th style="text-align:right">Proj</th>' +
      '<th style="text-align:right">Lineup gain</th>' +
      "<th>Would bench</th></tr></thead><tbody>";
    for (const f of gains) {
      html += '<tr><td class="player-name">' + escapeHtml(f.name) + "</td>" +
        '<td><span class="pos-badge pos-' + escapeHtml(f.position) + '">' +
        escapeHtml(f.position) + "</span></td>" +
        '<td class="weekly-game">' + escapeHtml(shortMatchup(f.matchup) || "-") + "</td>" +
        '<td style="text-align:right">' + f.points.toFixed(1) + "</td>" +
        '<td style="text-align:right"><span style="color:#58d68d;font-weight:700">+' +
        f.upgrade.toFixed(1) + "</span></td>" +
        '<td class="weekly-game">' +
        (f.replaces ? escapeHtml(f.replaces.name) + " (" +
          f.replaces.points.toFixed(1) + ")"
          : '<span style="color:#6a6a8a">fills an open slot</span>') +
        "</td></tr>";
    }
    html += "</tbody></table></div>";
    return html;
  }

  // Shown wherever a lineup would be, when the book filter excludes everything.
  // "nobody eligible" in every slot is technically true and tells you nothing.
  function noBooksNotice() {
    return '<div class="coverage-note early">' +
      "<strong>No books selected.</strong> Every line is filtered out, so " +
      "nothing can be ranked. Tick a book above, or use " +
      "<strong>all</strong> to go back to the full consensus.</div>";
  }

  function renderSitStart() {
    const $out = document.getElementById("sitstart-output");
    if (!$out) return;
    if (booksAllOff) { $out.innerHTML = noBooksNotice(); return; }

    const pool = buildSitStartPoolFull();
    if (!pool.size) {
      $out.innerHTML = '<div class="empty">Market data has not loaded.</div>';
      return;
    }
    if (!rosterSelected.size) {
      $out.innerHTML = '<div class="empty">Add players to build a lineup.</div>';
      return;
    }

    const matched = [], unmatched = [], unpriced = [];
    for (const key of rosterSelected) {
      const p = pool.get(key);
      if (!p) { unmatched.push(key); continue; }
      // A player whose only market is a touchdown price has no usage priced,
      // so ranking him against a fully-priced player would mislead.
      if (p.tdOnly || p.points <= 0 || !p.position) unpriced.push(p);
      else matched.push(p);
    }

    if (!matched.length) {
      $out.innerHTML = coverageBanner() +
        '<div class="verdict">No pasted player has a priced projection yet.' +
        (unmatched.length ? " Unrecognised: " + escapeHtml(unmatched.join(", ")) + "." : "") +
        "</div>" + slotTable([], null, unpriced, unmatched);
      return;
    }

    // A two-player question reads better as a verdict than as a lineup table.
    if (matched.length === 2 && !unpriced.length) {
      const pair = matched.slice().sort((x, y) => y.points - x.points);
      const a = pair[0], b = pair[1];
      const gap = a.points - b.points;
      const verdict = gap < 0.5
        ? "<strong>" + escapeHtml(a.name) + "</strong> by a hair &mdash; " +
          a.points.toFixed(1) + " to " + b.points.toFixed(1) +
          " in half-PPR. That gap is inside the noise; play the matchup you believe in."
        : "Start <strong>" + escapeHtml(a.name) + "</strong>. The market has him at " +
          a.points.toFixed(1) + " half-PPR against " + escapeHtml(b.name) + " at " +
          b.points.toFixed(1) + " &mdash; a " + gap.toFixed(1) + "-point edge.";
      $out.innerHTML = coverageBanner() +
        '<div class="verdict">' + verdict + "</div>" +
        slotTable([{ slot: "START", p: a }, { slot: "SIT", p: b }], null, unpriced, unmatched);
      return;
    }

    const best = bestLineup(matched);
    const startingNames = new Set(best.picks.filter(Boolean).map((p) => p.name));
    const bench = matched.filter((p) => !startingNames.has(p.name))
      .sort((a, b) => b.points - a.points);
    const rows = best.picks.map((p, i) => ({ slot: LINEUP_SLOTS[i].label, p }));
    $out.innerHTML = coverageBanner() +
      slotTable(rows, best.total, unpriced, unmatched, bench);
  }

  function renderSleeper() {
    const $out = document.getElementById("sleeper-output");
    const $meta = document.getElementById("sleeper-meta");
    if (!$out) return;
    if (booksAllOff) { $out.innerHTML = noBooksNotice(); return; }

    const sl = sleeperLive;
    if (!sl || !Array.isArray(sl.leagues) || !sl.leagues.length) {
      $out.innerHTML = '<div class="empty">Enter a Sleeper username to load your leagues.</div>';
      return;
    }
    const lg = sl.leagues[Math.min(sleeperLeagueIdx, sl.leagues.length - 1)];
    const pool = buildSitStartPoolFull();
    const wkd = cache["weekly"];
    if ($meta) {
      $meta.textContent = (wkd ? "Week " + wkd.week + " · " : "") +
        lg.teams + " teams · " +
        (lg.scoring.rec === 1 ? "full PPR" : lg.scoring.rec === 0.5 ? "half PPR"
          : lg.scoring.rec ? lg.scoring.rec + " PPR" : "standard") +
        (lg.scoring.bonusRecTe ? " · +" + lg.scoring.bonusRecTe + " TE" : "");
    }

    // Teams still on this week's board. Kalshi purges a game once it kicks off,
    // so a rostered player whose team is absent has ALREADY PLAYED -- his points
    // are banked, not zero. Treating that as an empty slot made every free agent
    // look like a full-value pickup instead of a marginal one.
    const liveTeams = new Set();
    for (const p of pool.values()) {
      const mu = (p.matchup || "").trim();
      if (mu.length >= 4) liveTeams.add(mu);
    }
    // The prop pool alone is not proof of anything: a team with no priced
    // player at all -- SEA/WAS had two on the whole game in week 3 -- looked
    // to this check exactly like a team whose game had finished, and every
    // player on it was filed as already played. The game lines cover all 32
    // teams, so they answer "has this game kicked off" properly.
    const teamIsLive = (team) => {
      if (!team) return false;
      const gl = gameLineFor(team);
      if (gl) {
        if (!gl.kickoff) return true;
        return Date.parse(gl.kickoff) > Date.now();
      }
      for (const mu of liveTeams) if (mu.includes(teamKey(team))) return true;
      return false;
    };

    const scored = [], unpriced = [], noMarket = [], played = [],
          unresolved = [];
    for (const r of lg.roster) {
      // Kickers and defenses are scored off the game line rather than a player
      // prop, so they go through specialPoints() before the prop lookup. They
      // still take the same played/locked path as everyone else.
      if (r.unpriced) {
        const doneSp = sleeperPlayed && sleeperPlayed.get(r.playerId);
        if (doneSp) {
          played.push({ ...r, actual: doneSp.points, locked: r.starter });
          continue;
        }
        const sp = specialPoints(r.position === "DST" ? "DEF" : r.position,
                                 r.position === "DEF" || r.position === "DST"
                                   ? (r.team || r.playerId) : r.team,
                                 lg.scoring);
        if (sp && sp.points > 0) {
          scored.push({
            name: r.name,
            position: r.position === "DST" ? "DEF" : r.position,
            matchup: sp.matchup,
            points: sp.points,
            stats: null,
            special: sp,
            injury: r.injury,
            wasStarter: r.starter,
          });
        } else if (!teamIsLive(r.team)) {
          played.push({ ...r, actual: null });
        } else {
          noMarket.push(r);
        }
        continue;
      }

      // Already played is decided by Sleeper's own stats, not by whether a
      // betting line still exists: books keep markets up during a game, so the
      // line-based check only caught players whose game had fully settled.
      // A player who has taken a snap is locked -- his points are banked and
      // the decision is gone, so he must not compete for a slot.
      const done = sleeperPlayed && sleeperPlayed.get(r.playerId);
      if (done) {
        played.push({ ...r, actual: done.points, locked: r.starter });
        continue;
      }

      // A roster id the Sleeper player map does not know: no name, no position,
      // no team. It used to fall through to the teamIsLive check below, which
      // answers false for a null team, so an unresolvable player was reported
      // as "already played this week" -- a claim about a game that has not
      // started, about a player we could not even name.
      if (!r.position && !r.team) { unresolved.push(r); continue; }

      const p = pool.get(normPlayerName(r.name));
      if (!p || p.tdOnly || p.points <= 0 || !p.position) {
        // No line and no remaining game: treat as done even without stats,
        // which covers a player who never took a snap.
        if (!teamIsLive(r.team)) played.push({ ...r, actual: null });
        else unpriced.push(r);
        continue;
      }
      scored.push({
        name: r.name,
        position: r.position || p.position,
        matchup: p.matchup,
        points: leaguePoints(p.stats, lg.scoring, r.position || p.position),
        stats: p.stats,
        injury: r.injury,
        projFilled: p.projFilled,
        wasStarter: r.starter,
      });
    }

    const slots = lg.slots || [];
    // Slots held by a player who has already played are spent -- the optimizer
    // fills only what is still changeable, so a locked starter is not counted
    // as an opening.
    const lockedBySlot = new Map();
    const lockedStarters = played.filter((r) => r.locked && r.position);
    const freeSlots = [];
    const slotUsed = new Array(slots.length).fill(false);
    for (const r of lockedStarters) {
      const idx = slots.findIndex((sl, i) =>
        !slotUsed[i] && (SLOT_ACCEPTS[sl] || []).includes(r.position));
      if (idx >= 0) { slotUsed[idx] = true; lockedBySlot.set(idx, r); }
    }
    slots.forEach((sl, i) => { if (!slotUsed[i]) freeSlots.push({ slot: sl, i }); });

    const best = bestLineupForSlots(scored, freeSlots.map((f) => f.slot));
    const startingNames = new Set(best.picks.filter(Boolean).map((p) => p.name));
    const bench = scored.filter((p) => !startingNames.has(p.name))
      .sort((a, b) => b.points - a.points);

    let html = coverageBanner() +
      '<div class="league-scoring">' +
      escapeHtml(slots.join(" / ")) + "</div>";

    html += '<div class="table-wrap"><table class="slot-table"><thead><tr>' +
      "<th>Slot</th><th>Player</th><th>Pos</th><th>Game</th>" +
      '<th style="text-align:right">Proj</th>' +
      "<th>Market lines</th></tr></thead><tbody>";
    // Re-expand the optimizer's answer back over the full slot list, so locked
    // slots render in place rather than the lineup appearing to shift up.
    const fullPicks = new Array(slots.length).fill(null);
    freeSlots.forEach((f, k) => { fullPicks[f.i] = best.picks[k] || null; });
    for (const [idx, r] of lockedBySlot) {
      fullPicks[idx] = { ...r, points: r.actual != null ? r.actual : 0, isLocked: true };
    }

    let drawnSwaps = 0;
    fullPicks.forEach((p, i) => {
      const slot = slots[i];
      const isFlex = (SLOT_ACCEPTS[slot] || []).length > 1;
      const badge = '<span class="slot-badge' + (isFlex ? " flex" : "") + '">' +
                    escapeHtml(slotLabel(slot)) + "</span>";
      if (!p) {
        html += '<tr class="bench-row"><td>' + badge +
                '</td><td colspan="5">nobody eligible</td></tr>';
        return;
      }
      if (p.isLocked) {
        html += '<tr class="locked-row"><td>' + badge + "</td>" +
          '<td class="player-name">' + escapeHtml(p.name) +
          ' <span class="injury-tag" style="color:#6a6a8a">PLAYED</span></td>' +
          '<td><span class="pos-badge pos-' + escapeHtml(p.position || "?") + '">' +
          escapeHtml(p.position || "?") + "</span></td>" +
          '<td class="weekly-game">' + escapeHtml(p.team || "-") + "</td>" +
          '<td style="text-align:right"><span class="market-pts" style="color:#6a6a8a">' +
          (p.actual != null ? p.actual.toFixed(1) : "—") + "</span></td>" +
          '<td style="color:#6a6a8a;font-size:12px">final &mdash; slot spent</td></tr>';
        return;
      }

      // Flag a change from what is currently set in Sleeper — that is the
      // actionable part, not the lineup itself. Counted as it is drawn, so the
      // league chip cannot claim a different number.
      if (!p.wasStarter) drawnSwaps++;
      const swap = p.wasStarter ? "" :
        ' <span class="injury-tag" style="color:#58d68d">SWAP IN</span>';
      html += "<tr><td>" + badge + "</td>" +
        '<td class="player-name">' + escapeHtml(p.name) +
        projTag(p) +
        (p.injury ? ' <span class="injury-tag" title="Sleeper injury status">' +
          escapeHtml(injuryLabel(p.injury)) + "</span>" : "") +
        swap + "</td>" +
        '<td><span class="pos-badge pos-' + escapeHtml(p.position || "?") + '">' +
        escapeHtml(p.position || "?") + "</span></td>" +
        '<td class="weekly-game">' + escapeHtml(shortMatchup(p.matchup) || "-") + "</td>" +
        '<td style="text-align:right"><span class="market-pts">' +
        p.points.toFixed(1) + "</span></td>" +
        "<td>" + (p.stats ? weeklyChips(p) : specialChips(p)) + "</td></tr>";
    });
    html += "</tbody></table></div>";
    // The chip badge is derived from this, not recomputed.
    swapCountCache.set(lg.leagueId, drawnSwaps);
    const banked = [...lockedBySlot.values()]
      .reduce((t, r) => t + (r.actual != null ? r.actual : 0), 0);
    html += '<div class="sitstart-total">' +
      (banked > 0
        ? "Banked " + banked.toFixed(1) + " + projected " + best.total.toFixed(1) +
          " = " + (banked + best.total).toFixed(1)
        : "Projected starters: " + best.total.toFixed(1)) +
      " pts</div>";

    if (bench.length) {
      html += '<div class="sitstart-section">Bench</div>' +
        '<div class="table-wrap"><table class="slot-table"><tbody>';
      for (const p of bench) {
        const swap = p.wasStarter
          ? ' <span class="injury-tag">SITTING</span>' : "";
        html += '<tr class="bench-row"><td class="player-name">' +
          escapeHtml(p.name) +
          projTag(p) +
        (p.injury ? ' <span class="injury-tag" title="Sleeper injury status">' +
          escapeHtml(injuryLabel(p.injury)) + "</span>" : "") +
          swap + "</td>" +
          '<td><span class="pos-badge pos-' + escapeHtml(p.position || "?") + '">' +
          escapeHtml(p.position || "?") + "</span></td>" +
          '<td class="weekly-game">' + escapeHtml(shortMatchup(p.matchup) || "-") + "</td>" +
          '<td style="text-align:right">' + p.points.toFixed(1) + "</td>" +
          "<td>" + (p.stats ? weeklyChips(p) : specialChips(p)) + "</td></tr>";
      }
      html += "</tbody></table></div>";
    }

    if (played.length) {
      html += '<div class="sitstart-section">Already played this week</div>' +
        '<div class="verdict" style="font-size:13px">' +
        escapeHtml(played.map((r) => r.name + " (" + (r.position || "?") + ")").join(", ")) +
        '<br /><span style="color:#6a6a8a">Their games have kicked off, so the ' +
        "books no longer quote them. Points already banked &mdash; the lineup " +
        "above only covers who is left to play.</span></div>";
    }
    if (unpriced.length) {
      // These are rostered players the optimizer could not rank, and saying so
      // matters: a starter who silently vanishes reads as the tool being broken
      // rather than the market being thin. Show the position and game so the
      // gap is obvious, and say plainly that it is not a projection of zero.
      /* Split the unpriced list by WHY the line is missing.
       *
       * "No book priced him" and "he is on IR" are opposite instructions, and
       * reporting them together was the less useful half of the answer. An
       * injury status explains most of this list in practice: of 16 unpriced
       * players across these rosters in week 4, ten had one.
       */
      const hurt = unpriced.filter((r) => r.injury);
      const quiet = unpriced.filter((r) => !r.injury);
      const nameOf = (r) =>
        r.name + " (" + (r.position || "?") + (r.team ? ", " + r.team : "") + ")";

      if (hurt.length) {
        html += '<div class="sitstart-section">Injured &mdash; no line because ' +
          "he may not play (" + hurt.length + ")</div>" +
          '<div class="verdict" style="font-size:13px">' +
          hurt.map((r) =>
            escapeHtml(nameOf(r)) +
            ' <span class="injury-tag">' + escapeHtml(injuryLabel(r.injury)) +
            "</span>").join("<br />") +
          '<br /><span style="color:#6a6a8a">The books have not priced these ' +
          "players because their status is in doubt, which is a reason not to " +
          "start them rather than a gap in coverage. " +
          (hurt.some((r) => r.injury.sidelined)
            ? "Anyone marked IR, PUP, Out or NA is not playing at all."
            : "All of these are game-time decisions, so check again closer to " +
              "kickoff.") +
          "</span></div>";
      }

      if (quiet.length) {
        html += '<div class="sitstart-section">No market projection (' +
          quiet.length + ")</div>" +
          '<div class="verdict" style="font-size:13px">' +
          escapeHtml(quiet.map(nameOf).join(", ")) +
          '<br /><span style="color:#6a6a8a">No book has priced their usage this ' +
          "week and Sleeper lists no injury, so they cannot be ranked and are " +
          "left out of the lineup above. That is an unpriced role, " +
          "<strong>not</strong> a projection of zero &mdash; if one of these is " +
          "a player you would normally start, start him. Coverage is thinnest " +
          "early in the week and fills in by Sunday.</span></div>";
      }
    }
    if (unresolved.length) {
      html += '<div class="sitstart-section">Not recognised (' +
        unresolved.length + ")</div>" +
        '<div class="verdict" style="font-size:13px;color:#6a6a8a">' +
        escapeHtml(unresolved.map((r) => r.name).join(", ")) +
        "<br />These roster spots did not match a player in Sleeper's own " +
        "player list, so nothing can be said about them. Usually a very " +
        "recent signing; the list refreshes with the rest of the data.</div>";
    }
    if (noMarket.length) {
      html += '<div class="sitstart-section">No game line</div>' +
        '<div class="verdict" style="font-size:13px;color:#6a6a8a">' +
        escapeHtml(noMarket.map((r) => r.name + " (" + (r.position || "?") + ")").join(", ")) +
        "<br />Kickers and defenses are scored from the spread and total; " +
        "no line is posted for their game yet.</div>";
    }

    if (lg.rosteredKeys) {
      html += freeAgentTable(
        freeAgentsFor(lg, lg.rosteredKeys, scored), lg);
    }
    $out.innerHTML = html;
    // The chip for this league now has a real count instead of an estimate, so
    // redraw the strip. Guarded against recursion: renderSleeperChips only
    // reads the cache, it does not render a lineup.
    renderSleeperChips();
  }

  /* How many changes a league's lineup needs, for the chip badges.
   *
   * With four leagues the useful question on arriving is "which of these needs
   * attention", and answering it previously meant clicking every chip in turn.
   * This runs the same optimizer the tab does and counts the players it would
   * start who are currently benched.
   *
   * Cached per league and cleared whenever the book filter changes, since the
   * count depends on the projections and re-optimising four rosters on every
   * keystroke would be wasteful.
   */
  const swapCountCache = new Map();

  function clearSwapCounts() { swapCountCache.clear(); }

  /* The number on a league chip.
   *
   * This used to re-run the optimizer itself, duplicating the classification
   * the render does -- and the two drifted: one league's chip said 2 while its
   * table showed 1. Two copies of "which players are eligible" will always
   * diverge eventually, so the render now records what it actually drew and
   * this reads that.
   *
   * A league you have not opened yet has no recorded count, so it gets one from
   * the same estimate as before. That estimate can be off by one; opening the
   * league replaces it with the truth. Better than a blank chip, and it is no
   * longer the number the table is checked against.
   */
  function swapCountFor(lg) {
    if (swapCountCache.has(lg.leagueId)) return swapCountCache.get(lg.leagueId);
    let n = null;
    try {
      const pool = buildSitStartPoolFull();
      const slots = lg.slots || [];
      const scored = [];
      for (const r of (lg.roster || [])) {
        if (sleeperPlayed && sleeperPlayed.get(r.playerId)) continue;
        if (!r.position && !r.team) continue;
        if (r.unpriced) {
          const pos = r.position === "DST" ? "DEF" : r.position;
          const sp = specialPoints(pos, r.team, lg.scoring);
          if (sp && sp.points > 0) {
            scored.push({ name: r.name, position: pos, points: sp.points,
                          wasStarter: r.starter });
          }
          continue;
        }
        const p = pool.get(normPlayerName(r.name));
        if (!p || p.tdOnly || p.points <= 0 || !p.position) continue;
        const pts = leaguePoints(p.stats, lg.scoring, r.position || p.position);
        if (pts > 0) {
          scored.push({ name: r.name, position: r.position || p.position,
                        points: pts, wasStarter: r.starter });
        }
      }
      const lockedCount = (lg.roster || []).filter(
        (r) => r.starter && sleeperPlayed && sleeperPlayed.get(r.playerId)).length;
      const openSlots = slots.slice(0, Math.max(0, slots.length - lockedCount));
      const best = bestLineupForSlots(scored, openSlots);
      n = best.picks.filter((x) => x && !x.wasStarter).length;
    } catch (e) {
      n = null;
    }
    // Not cached: an estimate must not shadow the render's real count.
    return n;
  }

  function renderSleeperChips() {
    const $chips = document.getElementById("sleeper-league-chips");
    const sl = sleeperLive;
    if (!$chips || !sl || !Array.isArray(sl.leagues)) {
      if ($chips) $chips.innerHTML = "";
      return;
    }
    $chips.innerHTML = sl.leagues.map((lg, i) => {
      const n = swapCountFor(lg);
      const badge = n
        ? ' <span class="chip-count">' + n + "</span>"
        : n === 0
          ? ' <span class="chip-ok" title="Lineup is already optimal">&check;</span>'
          : "";
      const tip = n
        ? (n === 1 ? "1 change suggested" : n + " changes suggested")
        : n === 0 ? "Lineup is already optimal" : (lg.name || "");
      return '<button class="chip' + (i === sleeperLeagueIdx ? " active" : "") +
        (n ? " has-swaps" : "") +
        '" data-idx="' + i + '" title="' + escapeHtml(tip) + '">' +
        escapeHtml(lg.name || "League " + (i + 1)) + badge + "</button>";
    }).join("");
    $chips.querySelectorAll(".chip").forEach((c) => {
      c.addEventListener("click", () => {
        sleeperLeagueIdx = Number(c.dataset.idx) || 0;
        renderSleeperChips();
        renderSleeper();
      });
    });
  }

  function renderSleeperBookToggles() {
    const list = document.getElementById("sleeper-book-list");
    if (!list) return;
    list.innerHTML = bookToggleHTML();
    for (const cb of list.querySelectorAll("input[data-book]")) {
      cb.addEventListener("change", () => {
        applyBookToggle([...list.querySelectorAll("input[data-book]")]);
        renderSleeper();
        renderSleeperBookToggles();
      });
    }
  }

  function renderBookToggles() {
    const list = document.getElementById("book-toggle-list");
    if (!list) return;
    list.innerHTML = bookToggleHTML();
    for (const cb of list.querySelectorAll("input[data-book]")) {
      cb.addEventListener("change", () => {
        applyBookToggle([...list.querySelectorAll("input[data-book]")]);
        renderSitStart();
        renderBookToggles();
      });
    }
  }

  async function sleeperJson(path) {
    const res = await fetch(SLEEPER_API + path);
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }

  /* Sign-in lives on two tabs.
   *
   * Sleeper Start/Sit and Root For/Against both need the same account, and
   * sending someone to another tab to type a username they are already looking
   * at a box for is a pointless detour. So the markup carries two forms and
   * every helper here updates both -- one sleeperLive, two sets of controls.
   */
  const SLEEPER_FORMS = [
    { user: "sleeper-user", forget: "sleeper-forget", status: "sleeper-status" },
    { user: "rooting-user", forget: "rooting-forget", status: "rooting-status" },
  ];

  function sleeperStatus(msg, isError) {
    for (const f of SLEEPER_FORMS) {
      const $s = document.getElementById(f.status);
      if (!$s) continue;
      $s.textContent = msg || "";
      $s.classList.toggle("sleeper-error", !!isError);
    }
  }

  // Reflect signed-in state on both forms: the username in each box and the
  // Sign out button shown or hidden together.
  function syncSleeperForms() {
    const signedIn = !!sleeperLive;
    const name = signedIn ? (sleeperLive.username || "") : "";
    for (const f of SLEEPER_FORMS) {
      const $u = document.getElementById(f.user);
      // Do not clobber what someone is mid-way through typing on the form they
      // are actually using.
      if ($u && document.activeElement !== $u) $u.value = name;
      const $f = document.getElementById(f.forget);
      if ($f) $f.hidden = !signedIn;
    }
  }

  function sleeperSeason() {
    const wk = cache["weekly"];
    return (wk && wk.season) || String(new Date().getFullYear());
  }

  async function loadSleeperPlayed(season, week) {
    // Keyed by season and week, not just "already loaded". Both current callers
    // pass the same week so the old unconditional cache happened to be
    // correct, but it would have served last week's played flags after a week
    // rollover -- silently locking slots for players who have not kicked off.
    const key = season + ":" + week;
    if (sleeperPlayed && sleeperPlayedKey === key) return sleeperPlayed;
    sleeperPlayedKey = key;
    sleeperPlayed = new Map();
    try {
      const stats = await sleeperJson(
        "/stats/nfl/regular/" + season + "/" + week);
      for (const [pid, v] of Object.entries(stats || {})) {
        if (!v || !v.gp) continue;
        sleeperPlayed.set(String(pid), {
          points: v.pts_half_ppr != null ? v.pts_half_ppr : null,
          snaps: v.off_snp != null ? v.off_snp : null,
        });
      }
    } catch (e) {
      // Not fatal: without it the lineup just cannot mark played slots.
      console.warn("Sleeper stats unavailable", e);
    }
    return sleeperPlayed;
  }

  async function loadSleeperUser(username) {
    clearSwapCounts();
    const name = (username || "").trim().replace(/^@/, "");
    if (!name) { sleeperStatus("Enter a username first.", true); return; }
    if (sleeperBusy) return;
    sleeperBusy = true;
    sleeperStatus("Looking up " + name + "…");

    const $out = document.getElementById("sleeper-output");
    try {
      if (!cache["sleeperPlayers"]) {
        cache["sleeperPlayers"] = await fetchJson("sleeper_players.json");
      }
      // Sleeper returns 404 for an unknown username and, unhelpfully, 200 with
      // a null body in some cases — both mean "no such user".
      let user;
      try {
        user = await sleeperJson("/user/" + encodeURIComponent(name));
      } catch (e) {
        user = null;
      }
      if (!user || !user.user_id) {
        sleeperStatus("No Sleeper user named " + name + ".", true);
        if ($out) {
          $out.innerHTML = '<div class="verdict">No Sleeper account found for ' +
            '<span class="unmatched">' + escapeHtml(name) + "</span>. " +
            "Usernames are case-insensitive but must match exactly otherwise — " +
            "check it on your Sleeper profile.</div>";
        }
        sleeperBusy = false;
        return;
      }

      const season = sleeperSeason();
      const leagues = await sleeperJson(
        "/user/" + user.user_id + "/leagues/nfl/" + season) || [];
      if (!leagues.length) {
        sleeperStatus("No " + season + " NFL leagues for this user.", true);
        if ($out) {
          $out.innerHTML = '<div class="verdict">' + escapeHtml(user.display_name || name) +
            " has no " + escapeHtml(season) + " NFL leagues on Sleeper.</div>";
        }
        sleeperBusy = false;
        return;
      }

      sleeperStatus("Reading " + leagues.length + " league" +
                    (leagues.length === 1 ? "" : "s") + "…");

      const pmap = (cache["sleeperPlayers"] || {}).players || {};
      const built = [];
      // Rosters are one request per league; a dozen leagues is still fast, and
      // a single league failing should not lose the others.
      const rosterSets = await Promise.all(leagues.map((lg) =>
        sleeperJson("/league/" + lg.league_id + "/rosters").catch(() => null)));

      leagues.forEach((lg, i) => {
        const rosters = rosterSets[i];
        if (!Array.isArray(rosters)) return;
        const mine = rosters.find((r) => r.owner_id === user.user_id);
        if (!mine) return;
        const starters = new Set(mine.starters || []);
        // Every player on ANY roster in this league, keyed the same way the
        // market board is, so the leftovers are the free agents.
        const rosteredKeys = new Set();
        for (const r of rosters) {
          for (const pid of (r.players || [])) {
            const e = pmap[String(pid)];
            if (e) rosteredKeys.add(normPlayerName(e[0]));
          }
        }
        const roster = (mine.players || []).map((pid) => {
          const e = pmap[String(pid)];
          const pos = e ? e[1] : null;
          return {
            playerId: String(pid),
            name: e ? e[0] : "Unknown (" + pid + ")",
            position: pos,
            team: e ? e[2] : null,
            starter: starters.has(pid),
            // No book prices kickers or defenses as players. They are scored
            // from the game line instead (see specialPoints), so this flag now
            // means "score me off the spread and total", not "unscoreable".
            unpriced: pos === "K" || pos === "DEF" || pos === "DST",
            injury: injuryFor(pid),
          };
        });
        roster.sort((a, b) => (a.starter === b.starter ? 0 : a.starter ? -1 : 1) ||
                              String(a.position).localeCompare(String(b.position)) ||
                              a.name.localeCompare(b.name));
        const sc = lg.scoring_settings || {};
        built.push({
          leagueId: lg.league_id,
          name: lg.name,
          teams: lg.total_rosters,
          status: lg.status,
          slots: (lg.roster_positions || []).filter((s) => s !== "BN"),
          scoring: {
            rec: sc.rec || 0,
            passTd: sc.pass_td != null ? sc.pass_td : 4,
            bonusRecTe: sc.bonus_rec_te || 0,
            // D/ST and K scoring varies far more between leagues than skill
            // scoring does -- one league pays 10 for a shutout, another 5 --
            // so the whole settings object rides along rather than a fixed
            // handful of fields. dstPoints()/kickerPoints() read from it.
            raw: sc,
          },
          roster,
          rosteredKeys,
        });
      });

      if (!built.length) {
        sleeperStatus("Found leagues but no roster owned by this user.", true);
        sleeperBusy = false;
        return;
      }

      // Which of these players have already played this week.
      const wkNow = cache["weekly"] && cache["weekly"].week;
      if (wkNow) await loadSleeperPlayed(season, wkNow);

      sleeperLive = { username: user.display_name || name,
                      userId: user.user_id, leagues: built };
      sleeperLeagueIdx = 0;
      try { localStorage.setItem(SLEEPER_LS_KEY, name); } catch (e) { /* private mode */ }
      syncSleeperForms();
      sleeperStatus("Signed in as " + (user.display_name || name) +
                    " · " + built.length + " league" + (built.length === 1 ? "" : "s"));
      renderSleeperChips();
      renderSleeper();
      // Whichever tab signed in, the other one's view is now stale. This app
      // tracks the visible view by class rather than a variable, so ask the DOM
      // -- referencing a currentView here (as the sibling app has) threw and
      // surfaced as "Sleeper request failed".
      const $rt = document.getElementById("rooting-view");
      if ($rt && !$rt.classList.contains("hidden")) {
        loadRootingData().then(renderRooting);
      }
    } catch (e) {
      sleeperStatus("Sleeper request failed: " + (e && e.message ? e.message : e), true);
    } finally {
      sleeperBusy = false;
    }
  }



  function rosterPool() {
    return buildSitStartPoolFull();
  }

  function renderRosterTags() {
    const $tags = document.getElementById("roster-tags");
    if (!$tags) return;
    const pool = rosterPool();
    if (!rosterSelected.size) {
      $tags.innerHTML = '<span style="font-size:12px;color:#6a6a8a">No players added yet.</span>';
      return;
    }
    const parts = [];
    for (const key of rosterSelected) {
      const p = pool.get(key);
      const label = p ? p.name : key;
      // An unpriced player is chipped in amber rather than dropped, so it is
      // visible that he was added but cannot be ranked.
      const unpriced = p && (p.tdOnly || p.points <= 0 || !p.position);
      parts.push('<span class="player-tag' + (unpriced ? " unpriced" : "") +
        '" data-key="' + escapeHtml(key) + '">' + escapeHtml(label) +
        (p && p.position
          ? ' <span class="pos-badge pos-' + escapeHtml(p.position) + '">' +
            escapeHtml(p.position) + "</span>"
          : "") +
        ' <span class="remove">&times;</span></span>');
    }
    $tags.innerHTML = parts.join("");
    $tags.querySelectorAll(".player-tag").forEach((el) => {
      el.addEventListener("click", () => {
        rosterSelected.delete(el.dataset.key);
        renderRosterTags();
        renderSitStart();
      });
    });
  }

  function renderRosterSuggestions() {
    const $in = document.getElementById("roster-search");
    const $sugg = document.getElementById("roster-suggestions");
    if (!$in || !$sugg) return;
    const val = $in.value.toLowerCase().trim();
    if (!val) { $sugg.style.display = "none"; suggIndex = -1; return; }

    const pool = rosterPool();
    const matches = [...pool.entries()]
      .filter(([k, p]) => !rosterSelected.has(k) && p.position &&
                          p.name.toLowerCase().includes(val))
      // Best projection first: when someone types a surname, the starter should
      // be the top hit rather than a third-stringer who sorts earlier.
      .sort((a, b) => b[1].points - a[1].points)
      .slice(0, 10);

    if (!matches.length) {
      $sugg.innerHTML = '<div style="color:#6a6a8a;cursor:default">No match on this week’s board</div>';
      $sugg.style.display = "block";
      suggIndex = -1;
      return;
    }
    $sugg.innerHTML = matches.map(([k, p], i) =>
      '<div data-key="' + escapeHtml(k) + '"' + (i === suggIndex ? ' class="active"' : "") + ">" +
      escapeHtml(p.name) +
      ' <span class="pos-badge pos-' + escapeHtml(p.position) + '">' +
      escapeHtml(p.position) + "</span>" +
      '<span class="sugg-pts">' + p.points.toFixed(1) + "</span></div>"
    ).join("");
    $sugg.style.display = "block";
  }

  function addRosterKey(key) {
    if (!key) return;
    rosterSelected.add(key);
    const $in = document.getElementById("roster-search");
    const $sugg = document.getElementById("roster-suggestions");
    if ($in) $in.value = "";
    if ($sugg) $sugg.style.display = "none";
    suggIndex = -1;
    renderRosterTags();
    renderSitStart();
  }






  // -- Rooting guide (aggregate) -----------------------------------------------
  // One list across every league, not one per league. A player can be starting
  // for you in one matchup and against you in another, and only the NET matters
  // when you sit down to watch: the per-league view showed Malik Nabers twice
  // and left you to cancel him out by hand.
  //
  // Only players who can still change a result are listed. A starter whose game
  // has finished is history however he did, so he is excluded rather than
  // padding the list.

  async function loadRootingData() {
    if (!sleeperLive) return null;
    const wk = (cache["weekly"] && cache["weekly"].week) || null;
    if (!wk) return null;

    if (!cache["matchups"]) cache["matchups"] = {};
    for (const lg of sleeperLive.leagues) {
      if (cache["matchups"][lg.leagueId]) continue;
      try {
        const [rows, users, rosters] = await Promise.all([
          sleeperJson("/league/" + lg.leagueId + "/matchups/" + wk),
          sleeperJson("/league/" + lg.leagueId + "/users"),
          sleeperJson("/league/" + lg.leagueId + "/rosters"),
        ]);
        cache["matchups"][lg.leagueId] = { rows, users, rosters };
      } catch (e) {
        cache["matchups"][lg.leagueId] = null;
      }
    }
    await loadSleeperPlayed(sleeperSeason(), wk);
    return true;
  }

  /* Injury status, used to explain a missing line.
   *
   * A rostered player with no betting line is one of two very different things:
   * the market has not got to him yet, or he is hurt and will not play. The page
   * reported both as "no market projection", which is the less useful half of
   * the answer -- "wait and check again" and "do not start him" look identical.
   *
   * Sleeper publishes the status in the same dictionary the player map is built
   * from, so it rides along in the map at no extra fetch. The lookup only
   * matters when a line is missing, which is exactly when it is consulted.
   */
  const INJURY_SIDELINED = new Set(["IR", "PUP", "Out", "Sus", "NA", "DNR", "COV"]);

  function injuryFor(pid) {
    const e = pmapEntry(pid);
    if (!e || e.length < 4 || !e[3]) return null;
    const status = e[3];
    return {
      status,
      bodyPart: e.length > 4 ? e[4] : null,
      // Out for the week, as opposed to a game-time decision. The distinction
      // is what separates "he is not playing" from "he might not finish".
      sidelined: INJURY_SIDELINED.has(status),
    };
  }

  /* Flags a row whose usage is a projection, not a market price.
   *
   * The individual stat chips already carry an approx sign, but that is easy to
   * miss on a row whose total looks like every other total. Justin Jefferson in
   * week 4 is the case that prompted this: 17.6 points, and every bit of the
   * yardage and receptions behind it came from a season estimate divided by 17.
   * The only thing a book priced was his touchdown.
   *
   * The label says WHAT was priced rather than just "estimated", because that is
   * the actionable part -- "TD only" tells you the market has an opinion on
   * whether he scores and none on how much he does. Checked against the board:
   * all 136 filled players have exactly one market stat and it is always the
   * touchdown, so the label is literally true rather than a generalisation. The
   * fallback covers a future case where that stops holding.
   */
  function projTag(p) {
    if (!p || !p.projFilled) return "";
    const priced = Object.keys(p.stats || {}).filter((k) => {
      const st = p.stats[k];
      return st && st.line != null && st.lineSource !== "projected";
    });
    const tdOnlyPriced = priced.length === 1 && priced[0] === "any_tds";
    const label = tdOnlyPriced ? "TD ONLY" : "EST";
    const why = tdOnlyPriced
      ? "A book priced his touchdown and nothing else. The yardage and " +
        "receptions here are a season projection divided by 17, not a market " +
        "price -- the market has an opinion on whether he scores, none on how " +
        "much he does."
      : "Usage is a season projection divided by 17, not a market price: no " +
        "book has posted this player's yardage or receptions this week.";
    return ' <span class="proj-tag" title="' + escapeHtml(why) + '">' +
      label + "</span>";
  }

  // One phrase for a row or a list: "IR (Hamstring)" or "Questionable (Thigh)".
  function injuryLabel(inj) {
    if (!inj) return "";
    return inj.status + (inj.bodyPart ? " (" + inj.bodyPart + ")" : "");
  }

  function pmapEntry(pid) {
    const pm = (cache["sleeperPlayers"] || {}).players || {};
    return pm[String(pid)] || null;
  }

  // Per-league matchup facts, used both for the aggregate tally and the
  // scoreboard strip.
  function matchupFor(lg) {
    const bundle = cache["matchups"] && cache["matchups"][lg.leagueId];
    if (!bundle || !Array.isArray(bundle.rows)) return null;
    const { rows, users, rosters } = bundle;
    const me = rosters.find((r) => r.owner_id === sleeperLive.userId);
    if (!me) return null;
    const mine = rows.find((r) => r.roster_id === me.roster_id);
    if (!mine || mine.matchup_id == null) return null;
    const opp = rows.find((r) => r.matchup_id === mine.matchup_id &&
                                 r.roster_id !== me.roster_id);
    if (!opp) return null;

    const nameByUser = {};
    for (const u of (users || [])) {
      nameByUser[u.user_id] = u.display_name || u.username || "Opponent";
    }
    const ownerByRoster = {};
    for (const r of (rosters || [])) ownerByRoster[r.roster_id] = r.owner_id;

    return {
      league: lg.name,
      oppName: nameByUser[ownerByRoster[opp.roster_id]] || "Opponent",
      myScore: mine.points || 0,
      oppScore: opp.points || 0,
      mine, opp,
    };
  }

  // player_id -> { for: [league], against: [league], proj, ... } across every
  // league, counting only players still to play.
  function aggregateRooting() {
    if (!sleeperLive) return null;
    const pool = buildSitStartPoolFull();
    const tally = new Map();
    const matchups = [];

    for (const lg of sleeperLive.leagues) {
      const m = matchupFor(lg);
      if (!m) continue;
      matchups.push(m);

      for (const [entry, dir] of [[m.mine, "for"], [m.opp, "against"]]) {
        for (const pid of (entry.starters || [])) {
          if (!pid || pid === "0") continue;
          // Already played: the result is banked, so he cannot be rooted for.
          if (sleeperPlayed && sleeperPlayed.get(String(pid))) continue;
          const e = pmapEntry(pid);
          if (!e) continue;
          const key = String(pid);
          let rec = tally.get(key);
          if (!rec) {
            const pos = e[1] === "DST" ? "DEF" : e[1];
            // Kickers and defenses are started in these matchups too, so they
            // belong in the rooting list. They price off the game line rather
            // than the prop pool. The rate card is the league's own, and a
            // player can appear in several leagues at once, so this uses the
            // first league that started him -- close enough for ordering a
            // watch list, where the sign matters more than the decimal.
            const sp = (pos === "K" || pos === "DEF")
              ? specialPoints(pos, e[2], lg.scoring) : null;
            const p = sp ? null : pool.get(normPlayerName(e[0]));
            rec = {
              name: e[0], position: pos, team: e[2],
              proj: sp ? sp.points : (p && !p.tdOnly ? p.points : null),
              matchup: sp ? sp.matchup : (p ? p.matchup : null),
              stats: p ? p.stats : null,
              special: sp,
              for: [], against: [],
            };
            tally.set(key, rec);
          }
          rec[dir].push(m.league);
        }
      }
    }

    const rows = [...tally.values()].map((r) => ({
      ...r, net: r.for.length - r.against.length,
      exposure: r.for.length + r.against.length,
    }));
    // Strongest interest first: how many leagues he swings, then how much he is
    // expected to score. A conflicted player nets to zero and sinks.
    rows.sort((a, b) => Math.abs(b.net) - Math.abs(a.net) ||
                        (b.proj || 0) - (a.proj || 0));
    return { rows, matchups };
  }

  /* Matchups arrive in two shapes and the long one is unreadable in a table.
   *
   * Kalshi and The Odds API write "CARCLE"; the DraftKings scrape writes
   * "CAR Panthers @ CLE Browns", four times the width, which forced the Game
   * column wide enough to squeeze everything else. Normalising on display
   * rather than in the data keeps the name joins untouched.
   */
  function shortMatchup(m) {
    const s = String(m || "").trim();
    if (!s) return "";
    const at = s.split(" @ ");
    if (at.length !== 2) return s;
    // "CAR Panthers @ CLE Browns" -> "CARCLE", away team first, as Kalshi does.
    // The two LA and two NY clubs share a city prefix, so the nickname is what
    // separates them -- taking the prefix alone turned LAC@BUF into "LABUF"
    // and NYJ@DET into "NYDET", neither of which is a real matchup code.
    const SPLIT = {
      "LA Chargers": "LAC", "LA Rams": "LAR",
      "NY Jets": "NYJ", "NY Giants": "NYG",
    };
    const code = (side) => {
      const t = side.trim();
      for (const k of Object.keys(SPLIT)) {
        if (t.startsWith(k)) return SPLIT[k];
      }
      const hit = t.match(/^([A-Z]{2,3})(?![A-Za-z])/);
      return hit ? hit[1] : "";
    };
    // DraftKings says JAX where Kalshi says JAC, so codes go through the same
    // alias table the defense lookup uses.
    const a = teamKey(code(at[0])), h = teamKey(code(at[1]));
    return a && h ? a + h : s;
  }

  function rootingList(title, rows, forMe) {
    if (!rows.length) {
      return '<div class="sitstart-section">' + escapeHtml(title) + "</div>" +
        '<div class="verdict" style="font-size:13px;color:#6a6a8a">Nobody.</div>';
    }
    let html = '<div class="sitstart-section">' + escapeHtml(title) + "</div>" +
      '<div class="table-wrap"><table class="slot-table root-table"><thead><tr>' +
      "<th>Player</th><th>Pos</th><th class=\"col-game\">Game</th>" +
      '<th style="text-align:right">Exp</th>' +
      '<th style="text-align:right">Sw</th></tr></thead><tbody>';
    for (const r of rows) {
      const n = Math.abs(r.net);
      const where = forMe ? r.for : r.against;
      const other = forMe ? r.against : r.for;
      html += "<tr><td class=\"player-name\">" +
        '<span class="root-mark ' + (forMe ? "for" : "against") + '">' +
        (forMe ? "▲" : "▼") + "</span> " + escapeHtml(r.name) +
        (n > 1 ? ' <span class="league-count">&times;' + n + "</span>" : "") +
        "</td>" +
        '<td><span class="pos-badge pos-' + escapeHtml(r.position || "?") + '">' +
        escapeHtml(r.position || "?") + "</span></td>" +
        '<td class="weekly-game col-game">' +
        escapeHtml(shortMatchup(r.matchup) || r.team || "-") + "</td>" +
        '<td style="text-align:right">' +
        (r.proj != null ? r.proj.toFixed(1) : "&mdash;") + "</td>" +
        '<td class="league-names" style="text-align:right">' +
        n + (other.length ? ' <span style="color:#f5b041">net</span>' : "") +
        "</td></tr>";
    }
    return html + "</tbody></table></div>";
  }

  function renderRooting() {
    const $out = document.getElementById("rooting-output");
    if (!$out) return;
    if (!sleeperLive) {
      $out.innerHTML = '<div class="empty">Enter a Sleeper username above to ' +
        "see who to root for.</div>";
      return;
    }
    const agg = aggregateRooting();
    if (!agg || !agg.matchups.length) {
      $out.innerHTML = '<div class="empty">No matchups found for this week.</div>';
      return;
    }

    const { rows, matchups } = agg;
    const live = rows.filter((r) => r.exposure > 0);
    const rootFor = live.filter((r) => r.net > 0);
    const rootAgainst = live.filter((r) => r.net < 0);
    const conflicted = live.filter((r) => r.net === 0 && r.exposure > 1);

    // Scoreboard strip: every matchup at a glance, so the lists below have
    // context without needing a league picker.
    let html = "";

    // One combined position across every matchup. Listing each league would
    // put the arithmetic back on you, which is what the aggregate exists to
    // avoid -- the totals below are what you are collectively playing for.
    const myTotal = matchups.reduce((t, m) => t + m.myScore, 0);
    const oppTotal = matchups.reduce((t, m) => t + m.oppScore, 0);
    const net = myTotal - oppTotal;
    html += '<div class="verdict">Across all your matchups you have scored ' +
      "<strong>" + myTotal.toFixed(1) + "</strong> against <strong>" +
      oppTotal.toFixed(1) + "</strong>, a net of <strong>" +
      (net >= 0 ? "+" : "") + net.toFixed(1) + "</strong>. " +
      (live.length
        ? live.length + " player" + (live.length === 1 ? "" : "s") +
          " can still move that number."
        : "Every starter on every side has played &mdash; nothing left to watch.") +
      "</div>";

    // Side by side: the two lists are read against each other, not in
    // sequence -- the question is whether your side or theirs has more left to
    // come. Stacking them put a scroll between the comparison. Collapses to one
    // column on a narrow screen.
    html += '<div class="root-columns">' +
      '<div class="root-col">' + rootingList("Root FOR", rootFor, true) + "</div>" +
      '<div class="root-col">' + rootingList("Root AGAINST", rootAgainst, false) +
      "</div></div>";

    if (conflicted.length) {
      html += '<div class="sitstart-section">Cancels out</div>' +
        '<div class="verdict" style="font-size:13px;color:#6a6a8a">' +
        conflicted.map((r) => escapeHtml(r.name) + " (" + r.for.length +
          " for, " + r.against.length + " against)").join("; ") +
        " &mdash; nets to nothing, so watch without caring.</div>";
    }
    $out.innerHTML = html;
  }


  // ── Boot ───────────────────────────────────────────────────────────────────
  const $ssView = document.getElementById("sitstart-view");
  const $lgView = document.getElementById("sleeper-view");
  const $rtView = document.getElementById("rooting-view");

  function showView(name) {
    if ($ssView) $ssView.classList.toggle("hidden", name !== "sitstart");
    if ($lgView) $lgView.classList.toggle("hidden", name !== "sleeper");
    if ($rtView) $rtView.classList.toggle("hidden", name !== "rooting");
    document.querySelectorAll(".view-tab").forEach((t) =>
      t.classList.toggle("active", t.dataset.view === name));
    if (name === "sitstart") showSitStartView();
    else if (name === "rooting") showRootingView();
    else showLeaguesView();
  }

  async function showRootingView() {
    await loadData();
    // The matchup needs a signed-in user; restore one if neither tab has been
    // used yet this session.
    if (!sleeperLive) {
      let saved = null;
      try { saved = localStorage.getItem(SLEEPER_LS_KEY); } catch (e) { saved = null; }
      if (saved) await loadSleeperUser(saved);
    }
    // Show the signed-in name and the Sign out button on this tab's own form,
    // so arriving here already signed in does not look like being signed out.
    syncSleeperForms();
    if (!sleeperLive) { renderRooting(); return; }
    await loadRootingData();
    renderRooting();
  }

  async function loadData() {
    for (const [key, file] of [["weekly", "weekly.json"],
                               ["oddsapi", "oddsapi.json"],
                               ["dktd", "dk_td.json"],
                               ["gamelines", "gamelines.json"],
                               ["data", "data.json"],
                               ["clay", "clay.json"]]) {
      if (!cache[key]) {
        try { cache[key] = await fetchJson(file); }
        catch (e) { cache[key] = null; }
      }
    }
    const wk = cache["weekly"];
    const $wk = document.getElementById("week-label");
    if ($wk && wk) {
      $wk.textContent = wk.week ? "Week " + wk.week : "This week";
    }
  }

  async function showSitStartView() {
    renderBookToggles();
    await loadData();
    const $meta = document.getElementById("sitstart-meta");
    const wkd = cache["weekly"];
    if ($meta && wkd) $meta.textContent = "Week " + wkd.week + " · half-PPR";
    renderRosterTags();
    renderBookToggles();
    renderSitStart();
  }

  async function showLeaguesView() {
    renderSleeperBookToggles();
    await loadData();
    if (!sleeperLive) {
      let saved = null;
      try { saved = localStorage.getItem(SLEEPER_LS_KEY); } catch (e) { saved = null; }
      const $u = document.getElementById("sleeper-user");
      if (saved && $u) {
        $u.value = saved;
        await loadSleeperUser(saved);
        return;
      }
    }
    syncSleeperForms();
    renderSleeperChips();
    renderSleeperBookToggles();
    renderSleeper();
  }

  /* -- Event wiring -----------------------------------------------------------
   * This was missing entirely when lineup/ was split out of nfl-props: the
   * markup shipped with a search box, suggestion list, paste area, demo and
   * clear buttons, a Sleeper sign-in and two "all books" links, and not one of
   * them was connected. Only the tab switcher was. The Manual Roster tab did
   * nothing at all, and Sleeper sign-in worked only when localStorage already
   * held a username from the other site -- which is why it looked fine in
   * testing, where the functions were driven directly rather than through the
   * page.
   */
  (function initRosterPicker() {
    const $in = document.getElementById("roster-search");
    const $sugg = document.getElementById("roster-suggestions");
    if (!$in || !$sugg) return;

    $in.addEventListener("input", () => { suggIndex = -1; renderRosterSuggestions(); });
    $in.addEventListener("keydown", (e) => {
      const items = [...$sugg.querySelectorAll("[data-key]")];
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (!items.length) return;
        e.preventDefault();
        suggIndex += (e.key === "ArrowDown" ? 1 : -1);
        if (suggIndex < 0) suggIndex = items.length - 1;
        if (suggIndex >= items.length) suggIndex = 0;
        renderRosterSuggestions();
      } else if (e.key === "Enter") {
        e.preventDefault();
        // Enter with nothing highlighted takes the top hit, which is what
        // typing a full name and hitting return should obviously do.
        const pick = items[suggIndex >= 0 ? suggIndex : 0];
        if (pick) addRosterKey(pick.dataset.key);
      } else if (e.key === "Escape") {
        $sugg.style.display = "none";
        suggIndex = -1;
      }
    });
    $sugg.addEventListener("click", (e) => {
      const div = e.target.closest("[data-key]");
      if (div) addRosterKey(div.dataset.key);
    });
    document.addEventListener("click", (e) => {
      if (!$in.contains(e.target) && !$sugg.contains(e.target)) {
        $sugg.style.display = "none";
        suggIndex = -1;
      }
    });
  })();

  // The paste path stays available for a whole roster at once; each line goes
  // through the same loose matcher and becomes a chip. Lines that do not
  // resolve are left in the box so it is obvious which ones failed.
  document.getElementById("roster-go")?.addEventListener("click", () => {
    const $ta = document.getElementById("roster-input");
    if (!$ta) return;
    const pool = buildSitStartPoolFull();
    const altIndex = new Map();
    for (const [k, p] of pool) {
      const alt = altPlayerKey(p.name);
      if (!altIndex.has(alt)) altIndex.set(alt, []);
      altIndex.get(alt).push(k);
    }
    const misses = [];
    for (const line of $ta.value.split("\n").map((l) => l.trim()).filter(Boolean)) {
      const cleaned = line.replace(/\s*[-–—(].*$/, "").trim();
      const k = normPlayerName(cleaned);
      if (pool.has(k)) { rosterSelected.add(k); continue; }
      const hits = altIndex.get(altPlayerKey(cleaned));
      if (hits && hits.length === 1) { rosterSelected.add(hits[0]); continue; }
      misses.push(line);
    }
    $ta.value = misses.join("\n");
    renderRosterTags();
    renderSitStart();
  });

  document.getElementById("books-all")?.addEventListener("click", (e) => {
    e.preventDefault();
    activeBooks.clear();
    booksAllOff = false;
    clearSwapCounts();
    renderBookToggles();
    renderSitStart();
  });

  document.getElementById("roster-clear")?.addEventListener("click", () => {
    rosterSelected.clear();
    renderRosterTags();
    renderSitStart();
  });

  document.getElementById("roster-demo")?.addEventListener("click", () => {
    const pool = buildSitStartPoolFull();
    rosterSelected.clear();
    for (const n of ["Josh Allen", "Jahmyr Gibbs", "Bijan Robinson", "Puka Nacua",
                     "CeeDee Lamb", "Brock Bowers", "Chase Brown",
                     "Jaxon Smith-Njigba", "Trey McBride", "Derrick Henry"]) {
      const k = normPlayerName(n);
      if (pool.has(k)) rosterSelected.add(k);
    }
    renderRosterTags();
    renderSitStart();
  });

  function sleeperSignOut() {
    sleeperLive = null;
    sleeperPlayed = null;
    sleeperPlayedKey = null;
    clearSwapCounts();
    // Matchups are per-account, so they cannot survive a sign-out.
    cache["matchups"] = {};
    try { localStorage.removeItem(SLEEPER_LS_KEY); } catch (e) { /* ignore */ }
    for (const f of SLEEPER_FORMS) {
      const $u = document.getElementById(f.user);
      if ($u) $u.value = "";
    }
    syncSleeperForms();
    const $chips = document.getElementById("sleeper-league-chips");
    if ($chips) $chips.innerHTML = "";
    const $meta = document.getElementById("sleeper-meta");
    if ($meta) $meta.textContent = "";
    sleeperStatus("");
    const $out = document.getElementById("sleeper-output");
    if ($out) {
      $out.innerHTML = '<div class="empty">Enter a Sleeper username to load ' +
        "your leagues.</div>";
    }
    const $root = document.getElementById("rooting-output");
    if ($root) {
      $root.innerHTML = '<div class="empty">Enter a Sleeper username to see ' +
        "who to root for.</div>";
    }
  }

  // Both tabs' controls, wired the same way.
  for (const f of SLEEPER_FORMS) {
    const go = f.user === "sleeper-user" ? "sleeper-go" : "rooting-go";
    document.getElementById(go)?.addEventListener("click", () => {
      const $u = document.getElementById(f.user);
      loadSleeperUser($u ? $u.value : "");
    });
    document.getElementById(f.user)?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") loadSleeperUser(e.target.value);
    });
    document.getElementById(f.forget)?.addEventListener("click", sleeperSignOut);
  }

  document.getElementById("sleeper-books-all")?.addEventListener("click", (e) => {
    e.preventDefault();
    activeBooks.clear();
    booksAllOff = false;
    clearSwapCounts();
    renderSleeperBookToggles();
    renderSleeper();
  });

  document.getElementById("view-tabs")?.addEventListener("click", (e) => {
    const tab = e.target.closest(".view-tab");
    if (tab) showView(tab.dataset.view);
  });

  /* Which tab opens first.
   *
   * The page is served at two URLs on ez-dubs-website -- Start/Sit and Root
   * For/Against are separate nav entries and separate directories -- but both
   * load this same file, so the logic cannot drift between them. Each page sets
   * window.LINEUP_DEFAULT_VIEW; a URL hash overrides it, so an existing
   * deep-link still works. Falls back to the first tab when neither is set.
   */
  const VALID_VIEWS = new Set(["sitstart", "sleeper", "rooting"]);
  const hashView = (window.location.hash || "").replace(/^#/, "");
  const wanted = VALID_VIEWS.has(hashView) ? hashView
    : VALID_VIEWS.has(window.LINEUP_DEFAULT_VIEW) ? window.LINEUP_DEFAULT_VIEW
    : "sitstart";
  loadData().then(() => showView(wanted));
})();
