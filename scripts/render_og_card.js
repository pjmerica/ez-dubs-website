// Renders the forecast map's link-preview image (dashboards/politics-data/og-map.png, 1200x630)
// from scripts/politics/og_card.html and the mirrored summary.json (2026-11-03: a shared link
// showed only the EDA logo). Called by pull_politics.py whenever summary.json changes or the
// image is missing; the page's og:image then carries the image's content hash.
//
//   node scripts/render_og_card.js          (CHROME_BIN names Chrome; otherwise the usual paths)
//
// Exits 1 without touching the old image if Chrome or the data is missing, so the page keeps
// pointing at the last good one.
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const puppeteer = require("puppeteer-core");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "dashboards", "politics-data", "og-map.png");
const CANDIDATES = [
  process.env.CHROME_BIN,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

(async () => {
  const chrome = CANDIDATES.find((p) => fs.existsSync(p));
  if (!chrome) throw new Error("no Chrome found (set CHROME_BIN)");
  const summary = JSON.parse(fs.readFileSync(path.join(ROOT, "dashboards", "politics-data", "summary.json"), "utf8"));
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true,
    args: ["--no-sandbox", "--allow-file-access-from-files", "--hide-scrollbars"] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 });
    await page.evaluateOnNewDocument((s) => { window.SUMMARY = s; }, summary);
    await page.goto(pathToFileURL(path.join(__dirname, "politics", "og_card.html")).href, { waitUntil: "load" });
    await page.waitForSelector("body[data-ready]", { timeout: 15000 });
    await page.evaluate(() => document.fonts.ready);
    const tmp = OUT + ".tmp.png";
    await page.screenshot({ path: tmp, clip: { x: 0, y: 0, width: 1200, height: 630 } });
    fs.renameSync(tmp, OUT);
    console.log(`og-map.png: rendered (${fs.statSync(OUT).size.toLocaleString()} bytes)`);
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error("og-map.png: not rendered, " + e.message); process.exit(1); });
