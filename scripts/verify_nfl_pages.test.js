/* Verify the NFL Redraft/In-Season pages and the nav they added.
 *
 * Run from this repo's root:
 *     npm install --no-save jsdom
 *     node scripts/verify_nfl_pages.test.js
 *
 * It checks three things that are easy to break by hand:
 *
 *   1. Every HTML page carries the same two-level NFL nav AND the .nav-dd-sub
 *      CSS it needs. The nav is copy-pasted per page in this repo, so editing
 *      one page is how the eight drift apart.
 *   2. There is exactly ONE app.js, in dashboards/nfl-shared/. Both NFL pages
 *      load it; giving each its own copy is the mistake this guards against.
 *   3. Both pages actually run -- they open on the right tab, fetch their data
 *      with no 404s, and sign in to Sleeper for real.
 *
 * Hits the live Sleeper API, so it needs a network connection and takes ~30s.
 * See dashboards/NFL_REDRAFT.md for what these pages are.
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { JSDOM } = require("jsdom");

const REPO = process.env.EZ_REPO || process.cwd();
let pass = 0, fail = 0;
const check = (l, c, d) => {
  if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "   -> " + d : "")); }
};

// ---- nav structure, on every page ------------------------------------------
console.log("=== nav: NFL > Best Ball / Redraft, on every page ===");
const htmlPages = [
  "index.html", "contact.html",
  "dashboards/arb-calculator/index.html",
  "dashboards/best-ball-history/index.html",
  "dashboards/best-ball-prices/index.html",
  "dashboards/prediction-arbitrage/index.html",
  "dashboards/nfl-start-sit/index.html",
  "dashboards/nfl-rooting/index.html",
];
for (const rel of htmlPages) {
  const f = path.join(REPO, rel);
  if (!fs.existsSync(f)) { check(rel + " exists", false); continue; }
  const dom = new JSDOM(fs.readFileSync(f, "utf8"));
  const d = dom.window.document;
  const nav = d.querySelector("nav.site-nav");
  if (!nav) { check(rel + " has a nav", false); continue; }

  const btns = [...nav.querySelectorAll(".nav-dd-btn")].map((b) => b.textContent.trim());
  const subs = [...nav.querySelectorAll(".nav-dd-sub-btn")].map((b) => b.textContent.trim());
  const links = [...nav.querySelectorAll(".nav-dd-sub-menu a")].map((a) => a.textContent.trim());
  const ok =
    btns.some((b) => b.startsWith("NFL")) &&
    !btns.some((b) => /Best Ball \(NFL\)/.test(b)) &&
    subs.some((x) => x.startsWith("Best Ball")) &&
    subs.some((x) => x.startsWith("Redraft/In-Season")) &&
    ["Price Differences", "History Risers/Fallers", "Start/Sit", "Root For/Against"]
      .every((x) => links.includes(x));
  check(rel, ok, "top: " + btns.join("/") + "  sub: " + subs.join("/"));
  // The submenu needs its CSS on the page, since CSS is inlined per page here.
  check("  " + rel + " carries the submenu CSS",
    fs.readFileSync(f, "utf8").includes(".nav-dd-sub-menu"));
}

// A page must mark itself current, and only itself.
console.log("");
console.log("=== active state ===");
for (const [rel, want] of [
  ["dashboards/nfl-start-sit/index.html", "Start/Sit"],
  ["dashboards/nfl-rooting/index.html", "Root For/Against"],
  ["dashboards/best-ball-prices/index.html", "Price Differences"],
]) {
  const dom = new JSDOM(fs.readFileSync(path.join(REPO, rel), "utf8"));
  const act = [...dom.window.document.querySelectorAll("nav.site-nav a.active")]
    .map((a) => a.textContent.trim());
  check(rel + " marks only " + want, act.length === 1 && act[0] === want,
    act.join(", ") || "(none)");
}

// ---- one copy of the logic -------------------------------------------------
console.log("");
console.log("=== shared assets, not duplicated ===");
const appFiles = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git" || e.name === "_local") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name === "app.js") appFiles.push(path.relative(REPO, p));
  }
})(REPO);
check("exactly one lineup app.js in the repo", appFiles.length === 1,
  appFiles.join(", "));
check("it lives in the shared directory",
  appFiles[0] && appFiles[0].includes("nfl-shared"), appFiles[0]);
// Data stored once, not twice.
check("only nfl-start-sit carries data/",
  fs.existsSync(path.join(REPO, "dashboards/nfl-start-sit/data/weekly.json")) &&
  !fs.existsSync(path.join(REPO, "dashboards/nfl-rooting/data")));

// ---- both pages actually run ----------------------------------------------
async function runPage(slug, expectView) {
  const dir = path.join(REPO, "dashboards", slug);
  const dom = new JSDOM(fs.readFileSync(path.join(dir, "index.html"), "utf8"), {
    runScripts: "outside-only",
    url: "https://ezdubsanalytics.com/dashboards/" + slug + "/",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const store = {};
  Object.defineProperty(window, "localStorage", { value: {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  } });
  // The page's own inline <script> sets the config; jsdom with outside-only
  // will not run it, so apply it the way the browser would.
  const cfg = fs.readFileSync(path.join(dir, "index.html"), "utf8")
    .match(/window\.LINEUP_DEFAULT_VIEW = "(\w+)".*?window\.LINEUP_DATA_DIR = "([^"]+)"/);
  if (cfg) { window.LINEUP_DEFAULT_VIEW = cfg[1]; window.LINEUP_DATA_DIR = cfg[2]; }
  const missing = [];
  window.fetch = async (u) => {
    const str = String(u);
    if (str.includes("sleeper.app")) {
      try {
        const r = await fetch(str);
        let b = Buffer.from(await r.arrayBuffer());
        if (b.length > 2 && b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b);
        const t = b.toString("utf8");
        return { ok: r.ok, status: r.status,
                 json: async () => { try { return JSON.parse(t); } catch (e) { return null; } } };
      } catch (e) { return { ok: false, status: 0, json: async () => null }; }
    }
    // Resolve relative to this page, as a browser would. The app requests a
    // RELATIVE path ("data/x.json" or "../nfl-start-sit/data/x.json"), so
    // resolve it against the page directory rather than string-matching.
    const want = str.split("?")[0];
    const cands = [path.resolve(dir, want)];
    if (/^https?:/.test(want)) cands.length = 0;
    for (const cand of cands) {
      if (fs.existsSync(cand)) {
        return { ok: true, status: 200,
                 json: async () => JSON.parse(fs.readFileSync(cand, "utf8")) };
      }
    }
    missing.push(str.split("?")[0]);
    return { ok: false, status: 404, json: async () => null };
  };
  const errors = [];
  window.addEventListener("error", (e) => errors.push(String(e.error || e.message)));
  window.eval(fs.readFileSync(path.join(REPO, "dashboards", "nfl-shared", "app.js"), "utf8"));
  await new Promise((r) => setTimeout(r, 1200));
  const $ = (id) => window.document.getElementById(id);

  console.log("");
  console.log("=== " + slug + " ===");
  check("config read from the page",
    window.LINEUP_DEFAULT_VIEW === expectView, window.LINEUP_DEFAULT_VIEW);
  const shown = ["sitstart", "sleeper", "rooting"]
    .filter((v) => $(v + "-view") && !$(v + "-view").classList.contains("hidden"));
  check("opens on the " + expectView + " tab",
    shown.length === 1 && shown[0] === expectView, shown.join(","));
  check("no 404s", missing.length === 0, [...new Set(missing)].join(", "));

  // Sign in and confirm the real thing renders.
  const uid = expectView === "rooting" ? "rooting-user" : "sleeper-user";
  const go = expectView === "rooting" ? "rooting-go" : "sleeper-go";
  $(uid).value = "pjmerica";
  $(go).click();
  await new Promise((r) => setTimeout(r, 14000));
  const out = expectView === "rooting" ? $("rooting-output") : $("sleeper-output");
  const txt = out.textContent.replace(/\s+/g, " ").trim();
  check("signed in and rendered", txt.length > 120 && !/Enter a Sleeper/.test(txt),
    txt.slice(0, 70));
  check("no console errors", errors.length === 0, errors.slice(0, 2).join(" | "));
  return errors.length + missing.length;
}

(async () => {
  await runPage("nfl-start-sit", "sleeper");
  await runPage("nfl-rooting", "rooting");
  console.log("");
  console.log(pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
