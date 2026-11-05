// Link previews: a screenshot of each page is the image Reddit, X, iMessage and the rest show
// when the page is shared (user, 2026-11-03: "for every specific page ... Best is just a
// screenshot or preview of the page"). The forecast map has its own drawn card instead
// (render_og_card.js / og-map.png).
//
//   node scripts/render_previews.js                 every page below
//   node scripts/render_previews.js home politics-forecast
//
// Serves the repo on a local port, opens each page in headless Chrome at 1440x756 scaled to
// 1200x630 (the size previews use), saves assets/previews/<name>.png, then points the page's
// og:image / twitter:image at it with a content-hash ?v= (sites cache previews by URL).
// Generated pages keep the tags too: pull_politics.py and the NFL port (AI_Agent_work
// port_lineup_to_ezdubs.py) build the same URL from the same file.
//
// CHROME_BIN names Chrome; otherwise the usual install paths are tried.
const fs = require("fs");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const puppeteer = require("puppeteer-core");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "assets", "previews");
const SITE = "https://ezdubsanalytics.com";

// name -> the page's URL path, its file, and anything to do before the shot.
const PAGES = {
  "home":                 { url: "/",                                 file: "index.html" },
  "contact":              { url: "/contact.html",                     file: "contact.html" },
  "politics-forecast":    { url: "/dashboards/politics-forecast/",    file: "dashboards/politics-forecast/index.html" },
  "nfl-start-sit":        { url: "/dashboards/nfl-start-sit/",        file: "dashboards/nfl-start-sit/index.html" },
  "nfl-rooting":          { url: "/dashboards/nfl-rooting/",          file: "dashboards/nfl-rooting/index.html" },
  "nfl-book-spread":      { url: "/dashboards/nfl-book-spread/",      file: "dashboards/nfl-book-spread/index.html" },
  "prediction-arbitrage": { url: "/dashboards/prediction-arbitrage/", file: "dashboards/prediction-arbitrage/index.html" },
  "arb-calculator":       { url: "/dashboards/arb-calculator/",       file: "dashboards/arb-calculator/index.html" },
  "best-ball-prices":     { url: "/dashboards/best-ball-prices/",     file: "dashboards/best-ball-prices/index.html" },
  "best-ball-history":    { url: "/dashboards/best-ball-history/",    file: "dashboards/best-ball-history/index.html" },
};

const CHROME = [
  process.env.CHROME_BIN,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean).find((p) => fs.existsSync(p));

// The election forecast locks at 6 p.m. Eastern on Election Day (LOCK_AT in pull_politics.py), and
// its last screenshots are taken by the final pull a couple of minutes before. Within 15 minutes of
// the lock the pages are shot with their clock a minute past it, so they read "Locked at 6 p.m.".
const LOCK = Date.UTC(2026, 10, 3, 23);
const SHIFT = Date.now() >= LOCK - 15 * 60e3 && Date.now() < LOCK ? LOCK + 60e3 - Date.now() : 0;

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".csv": "text/csv", ".ico": "image/x-icon" };

function serve() {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p.endsWith("/")) p += "index.html";
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

// Replace the page's preview-image tags with ones for its screenshot, keeping its own style
// (indent, and " />" on the NFL pages). The block goes straight after og:type.
function previewTags(name, indent, close) {
  const png = fs.readFileSync(path.join(OUT_DIR, name + ".png"));
  const img = `${SITE}/assets/previews/${name}.png?v=${crypto.createHash("sha256").update(png).digest("hex").slice(0, 10)}`;
  return [
    `<meta property="og:image" content="${img}"${close}`,
    `<meta property="og:image:width" content="1200"${close}`,
    `<meta property="og:image:height" content="630"${close}`,
    `<meta name="twitter:card" content="summary_large_image"${close}`,
    `<meta name="twitter:image" content="${img}"${close}`,
  ].map((l) => indent + l).join("\n");
}

function retag(name) {
  const file = path.join(ROOT, PAGES[name].file);
  const html = fs.readFileSync(file, "utf8");
  const type = html.match(/^([ \t]*)<meta property="og:type"[^>]*?(\s?\/?>)[ \t]*$/m);
  if (!type) throw new Error(`${PAGES[name].file} has no og:type tag to anchor the preview tags`);
  const close = type[2].includes("/") ? " />" : ">";
  const stripped = html.replace(/^[ \t]*<meta (property="og:image(:width|:height|:alt)?"|name="twitter:(card|image)")[^>]*>[ \t]*\r?\n/gm, "");
  const out = stripped.replace(type[0], type[0] + "\n" + previewTags(name, type[1], close));
  if (out !== html) fs.writeFileSync(file, out);
  return out !== html;
}

(async () => {
  const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(PAGES);
  const bad = names.filter((n) => !PAGES[n]);
  if (bad.length) throw new Error(`unknown page(s): ${bad.join(", ")}`);
  if (!CHROME) throw new Error("no Chrome found (set CHROME_BIN)");
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--hide-scrollbars"] });
  let failed = 0;
  try {
    for (const name of names) {
      const page = await browser.newPage();
      try {
        // 1440 wide (the desktop layout) scaled down to the 1200x630 previews use
        await page.setViewport({ width: 1440, height: 756, deviceScaleFactor: 1200 / 1440 });
        if (SHIFT) await page.evaluateOnNewDocument((shift) => {
          const D = Date, now = () => D.now() + shift;
          window.Date = class extends D { constructor(...a) { if (a.length) super(...a); else super(now()); } static now() { return now(); } };
        }, SHIFT);
        await page.goto(base + PAGES[name].url, { waitUntil: "networkidle0", timeout: 60000 });
        await page.evaluate(() => document.fonts.ready);
        await new Promise((r) => setTimeout(r, 600));   // charts and late-filled tables
        const tmp = path.join(OUT_DIR, name + ".tmp.png");
        await page.screenshot({ path: tmp, clip: { x: 0, y: 0, width: 1440, height: 756 } });
        fs.renameSync(tmp, path.join(OUT_DIR, name + ".png"));
        console.log(`${name}.png: rendered${retag(name) ? ", tags updated" : ""}`);
      } catch (e) {
        failed++;
        console.error(`${name}.png: not rendered, ${e.message}`);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("previews: " + e.message); process.exit(1); });
