/**
 * The Risers/Fallers page reads dashboards/best-ball-history/history.json, a
 * one-time build of the frozen 2026 ADP history CSVs
 * (scripts/build_history_summary.js, 2026-10-15). This checks two things:
 *
 *  1. history.json is still exactly what the CSVs produce. The CSVs are the
 *     permanent record; if either is ever edited, the page would silently show
 *     the old numbers. Rebuild with `node scripts/build_history_summary.js`.
 *  2. The page loads from it in a real DOM and renders movers with no errors.
 *
 * When this switched over, the old CSV loader and the new one were compared on
 * every era x position x lookback combination (105) and the chart series: all
 * identical.
 */
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");
const { buildFromCsvTexts, SOURCE_CSV, ALL_SOURCES } = require("./build_history_summary.js");

const ROOT = path.resolve(__dirname, "..");
const PAGE_DIR = path.join(ROOT, "dashboards", "best-ball-history");

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { pass++; console.log("  ok    " + label); }
  else { fail++; console.log("  FAIL  " + label + (detail ? "  [" + detail + "]" : "")); }
};

(async () => {
  const onDisk = JSON.parse(fs.readFileSync(path.join(PAGE_DIR, "history.json"), "utf8"));
  const rebuilt = buildFromCsvTexts(ALL_SOURCES.map(s => fs.readFileSync(SOURCE_CSV[s], "utf8")));
  for (const k of ["dates", "players", "adp"]) {
    check(`history.json ${k} matches the CSVs`,
          JSON.stringify(onDisk[k]) === JSON.stringify(rebuilt[k]),
          "rebuild: node scripts/build_history_summary.js");
  }
  // Five players were split across two spellings until 2026-10-19 (see
  // SAME_PLAYER in the build script). Each must be one entry, and the two that
  // were cleanly complementary must now span the whole season on both books.
  const keys = new Set(onDisk.players.map(p => p[0]));
  for (const v of ["kenny gainwell", "hollywood brown", "cam skattebo", "mitch tinsley", "j michael sturdivant"]) {
    check(`"${v}" is merged into its season-close name`, !keys.has(v));
  }
  for (const k of ["kenneth gainwell", "cameron skattebo"]) {
    const i = onDisk.players.findIndex(p => p[0] === k);
    const full = i >= 0 && ALL_SOURCES.every(s => onDisk.adp[s][i].every(x => x !== null));
    check(`${k} has an ADP on every date on both books`, full);
  }
  check("covers the whole 2026 season",
        onDisk.dates[0] === "2026-03-17" && onDisk.dates[onDisk.dates.length - 1] === "2026-09-04",
        `${onDisk.dates[0]}..${onDisk.dates[onDisk.dates.length - 1]}`);

  // Load the page with fetch served from disk, so no server or network.
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", e => errors.push(String(e.message || e)));
  vc.on("error", e => errors.push(String(e)));
  const fetched = [];
  const dom = new JSDOM(fs.readFileSync(path.join(PAGE_DIR, "index.html"), "utf8"), {
    url: "https://ezdubsanalytics.com/dashboards/best-ball-history/",
    runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.fetch = async u => {
        const rel = new URL(u, w.location.href).pathname.replace(/^\//, "");
        fetched.push(rel);
        const f = path.join(ROOT, rel);
        if (!fs.existsSync(f)) return new w.Response("", { status: 404 });
        return new Response(fs.readFileSync(f));
      };
    },
  });
  const w = dom.window;
  for (let i = 0; i < 40 && !w.eval("historyData"); i++) await new Promise(r => setTimeout(r, 250));

  check("page built its data", !!w.eval("historyData"));
  check("page did not fetch the raw CSVs", !fetched.some(f => f.endsWith(".csv")), fetched.join(", "));
  const recs = w.document.getElementById("recs-container");
  check("movers rendered", recs && recs.querySelectorAll("li").length > 0);
  check("subtitle shows the comparison",
        /^Comparing /.test(w.document.getElementById("movers-subtitle").textContent.trim()),
        w.document.getElementById("movers-subtitle").textContent.trim());
  check("no script errors", errors.length === 0, errors.slice(0, 3).join(" | "));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
