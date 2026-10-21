/**
 * The shared NFL app is a copy. Check it is not a STALE copy.
 *
 * dashboards/nfl-shared/app.js is copied verbatim from pjmerica/AI_Agent_work
 * by scripts/port_lineup_to_ezdubs.py (style.css is a re-themed copy; see
 * SITE_THEME in that script). Nothing here tests
 * the model inside it, so a port that fails halfway, or an upstream fix that was
 * never ported, leaves this site quietly serving different numbers from the
 * source of truth — and the pages look identical either way.
 *
 * That is not hypothetical. On 2026-10-10 the port silently stripped
 * aria-hidden from 24 nav carets, and the only reason it was caught is that
 * someone happened to diff the output. On the same day a kicker fix worth ~1.4
 * fantasy points a week sat upstream for an hour before being ported.
 *
 * This asserts the model constants that carry real weight, by value. It needs no
 * network and no browser: if upstream changes a constant, this fails until the
 * port runs, which is exactly the signal wanted.
 *
 * WHEN THIS FAILS: run the port from the upstream repo —
 *     py scripts/port_lineup_to_ezdubs.py --write
 * then re-run. Do not hand-edit nfl-shared/app.js; it is overwritten.
 */
const fs = require("fs");
const path = require("path");

const ROOT = process.env.EZ_REPO || process.cwd();
const APP = path.join(ROOT, "dashboards", "nfl-shared", "app.js");

let pass = 0;
const fails = [];
const check = (label, cond, detail) => {
  if (cond) { pass++; }
  else { fails.push(label); console.log("  FAIL  " + label + (detail ? "\n        " + detail : "")); }
};

check("the shared app exists", fs.existsSync(APP), APP);
if (!fs.existsSync(APP)) {
  console.log(`\n${pass} passed, ${fails.length} failed`);
  process.exit(1);
}

const src = fs.readFileSync(APP, "utf8");

// Each entry: a regex capturing the constant, the value expected, and why it
// matters. Keep the *reason* here, so a failure explains itself rather than
// reading as a magic number mismatch.
const CONSTANTS = [
  {
    what: "kicker FG make rate",
    re: /const FG_MAKE_RATE = ([\d.]+);/,
    expect: 0.867,
    why: "fgs is an ATTEMPT count; without this every attempt scores as a make, "
       + "overstating kickers by ~1.4 points a week",
  },
  {
    what: "kicker FG divisor",
    re: /const fgs = Math\.max\(0, T \/ ([\d.]+)\);/,
    expect: 11.6,
    why: "22.72 mean points scored / 1.95 attempts per team-game, measured over "
       + "128 team-games of 2026",
  },
  {
    what: "kicker TD divisor",
    re: /const tds = Math\.max\(0, T \/ ([\d.]+)\);/,
    expect: 9.3,
    why: "drives the extra-point term",
  },
  {
    what: "DST interception share",
    re: /const ints = vol\.takeaways \* ([\d.]+);/,
    expect: 0.58,
    why: "splits a takeaway into interception and fumble recovery; only matters "
       + "in a league that pays them differently",
  },
  {
    what: "DST defensive-TD rate",
    re: /pts \+= ([\d.]+) \* n\("def_td", 6\);/,
    expect: 0.08,
    why: "a decimal slip here inflates every defense by several points",
  },
];

for (const c of CONSTANTS) {
  const m = src.match(c.re);
  if (!m) {
    check(`${c.what} is present in the shared app`, false,
          `pattern not found: ${c.re}\n        ${c.why}`);
    continue;
  }
  const got = Number(m[1]);
  check(`${c.what} is ${c.expect}`, Math.abs(got - c.expect) < 1e-9,
        `found ${got}, expected ${c.expect}\n        ${c.why}\n`
        + `        If upstream changed this deliberately, re-run the port and `
        + `update this test.`);
}

// The two NFL pages must keep sharing ONE app. Splitting them into two copies is
// the obvious-looking "cleanup" that would let them drift apart silently.
for (const page of ["nfl-start-sit", "nfl-rooting"]) {
  const p = path.join(ROOT, "dashboards", page, "index.html");
  if (!fs.existsSync(p)) { check(`${page} exists`, false, p); continue; }
  const html = fs.readFileSync(p, "utf8");
  check(`${page} loads the shared app, not its own copy`,
        /nfl-shared\/app\.js/.test(html),
        "it must reference ../nfl-shared/app.js");
  check(`${page} has no private app.js`,
        !fs.existsSync(path.join(ROOT, "dashboards", page, "app.js")),
        "a per-page app.js means the two pages can drift apart");
}

console.log(`\n${CONSTANTS.length} model constant(s) and 2 page(s) checked`);
console.log(`${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log("\nTo resync: run `py scripts/port_lineup_to_ezdubs.py --write` "
    + "from the AI_Agent_work repo.");
}
process.exit(fails.length ? 1 : 0);
