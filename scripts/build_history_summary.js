/**
 * One-time build of dashboards/best-ball-history/history.json from the frozen
 * 2026 ADP history CSVs. Run 2026-10-15; the 2026 files are permanent, so this
 * never needs re-running for them (see "Best Ball is frozen" in CLAUDE.md).
 *
 * Why: the Risers/Fallers page used to download both CSVs on every visit --
 * about 3.1 MB gzipped, 13.8 MB and 320K rows to parse -- to build the same
 * structure each time. This builds that structure once and stores only what
 * the page reads: the dates, the players in their original order, and one ADP
 * per source per player per date.
 *
 * The parsing below is the page's own loader (parseCSV, normalizeName,
 * isRealAdp, the manual-over-auto rule), copied verbatim from
 * dashboards/best-ball-history/index.html before it switched to this file.
 * verify_history_summary.test.js rebuilds from the CSVs and checks the page
 * ends up with byte-identical data either way.
 *
 * Usage: node scripts/build_history_summary.js
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "dashboards", "best-ball-history", "history.json");

const ADP_FLOORS = { DK: 240, UD: 216 };
const ALL_SOURCES = ["DK", "UD"];
const SOURCE_CSV = {
  DK: path.join(ROOT, "dashboards", "best-ball-prices", "dk_adp_history.csv"),
  UD: path.join(ROOT, "dashboards", "best-ball-prices", "ud_adp_history.csv"),
};

function parseCSV(text) {
  const rows = [];
  const lines = text.trim().split("\n");
  for (const line of lines) {
    const row = [];
    let inQuote = false, field = "";
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQuote = !inQuote; }
      else if (ch === "," && !inQuote) { row.push(field.trim()); field = ""; }
      else { field += ch; }
    }
    row.push(field.trim());
    rows.push(row);
  }
  return rows;
}

function normalizeName(name) {
  return name.toLowerCase()
    .replace(/[.']/g, "")
    .replace(/\s+(jr|sr|i{1,3}|iv|v|1st|2nd|3rd|4th|5th)\.?$/i, "")
    .replace(/\s+(jr|sr|i{1,3}|iv|v)\.?$/i, "")
    .replace(/\s+/g, " ").trim();
}

function isRealAdp(adp, floor) {
  return !isNaN(adp) && adp < floor;
}

function buildSnapshotMaps(rows, floor) {
  const byDate = new Map();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length < 5 || !r[0] || !r[1]) continue;
    const date = r[0], name = r[1], pos = r[2] || "", source = r[5] || "";
    const adp = parseFloat(r[4]);
    if (!isRealAdp(adp, floor)) continue;
    let bucket = byDate.get(date);
    if (!bucket) { bucket = { manual: {}, auto: {} }; byDate.set(date, bucket); }
    const target = source === "manual" ? bucket.manual : bucket.auto;
    target[normalizeName(name)] = { name, pos, adp };
  }
  return byDate;
}

// The page's snapshot + player-index construction, unchanged.
function buildFromCsvTexts(texts) {
  const byDateBySource = {};
  ALL_SOURCES.forEach((src, i) => {
    byDateBySource[src] = buildSnapshotMaps(parseCSV(texts[i]), ADP_FLOORS[src]);
  });
  const allDates = new Set();
  ALL_SOURCES.forEach(src => byDateBySource[src].forEach((_, d) => allDates.add(d)));
  const dates = [...allDates].sort();
  const maps = dates.map(date => {
    const m = {};
    for (const src of ALL_SOURCES) {
      const b = byDateBySource[src].get(date) || { manual: {}, auto: {} };
      m[src] = Object.keys(b.manual).length ? b.manual : b.auto;
    }
    return m;
  });
  const allKeys = new Set();
  maps.forEach(m => ALL_SOURCES.forEach(src => Object.keys(m[src]).forEach(k => allKeys.add(k))));
  const players = [];
  for (const key of allKeys) {
    let hit = null;
    outer:
    for (const m of maps) {
      for (const src of ALL_SOURCES) {
        if (m[src][key]) { hit = m[src][key]; break outer; }
      }
    }
    if (hit) players.push([key, hit.name, hit.pos]);
  }
  // One row per player per source, aligned to `dates`; null = no ADP that day.
  const adp = {};
  for (const src of ALL_SOURCES) {
    adp[src] = players.map(([key]) => maps.map(m => (m[src][key] ? m[src][key].adp : null)));
  }
  return { dates, players, adp };
}

module.exports = { buildFromCsvTexts, SOURCE_CSV, ALL_SOURCES };

if (require.main === module) {
  const texts = ALL_SOURCES.map(src => fs.readFileSync(SOURCE_CSV[src], "utf8"));
  const summary = buildFromCsvTexts(texts);
  const out = {
    note: "Built once by scripts/build_history_summary.js from the frozen 2026 " +
          "DK and UD ADP history CSVs. adp[source][player][date] lines up with " +
          "players[] and dates[]; null means no ADP that day.",
    ...summary,
  };
  fs.writeFileSync(OUT, JSON.stringify(out) + "\n");
  const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
  console.log(`wrote ${path.relative(ROOT, OUT)}: ${summary.dates.length} dates, ` +
              `${summary.players.length} players, ${kb} KB`);
}
