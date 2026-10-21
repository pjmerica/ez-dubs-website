/**
 * Automated accessibility audit (axe-core) of every page, in real Chrome, at
 * desktop and phone width.
 *
 * Added 2026-10-20 after an axe run found 262 low-contrast position badges on
 * the Best Ball pages, pages with no <main> landmark, a retired grey (#6a6a8a)
 * back in the NFL app, and phone tables that scrolled but could not be reached
 * by keyboard -- none of which the other checks look for. All fixed; this keeps
 * them fixed. Rules: WCAG 2.0/2.1 A and AA plus axe's best practices.
 *
 * Pages are audited signed out (the NFL views also render signed in, but that
 * needs Sleeper's live API; verify_nfl_pages covers that path). The
 * password-gated arbs page is audited unlocked, by setting the same
 * sessionStorage flag the gate sets.
 *
 * Needs Chrome: CHROME_BIN, or the usual install path. Without it this skips
 * locally and FAILS in CI, like verify_csp, so CI can never pass unverified.
 */
const fs = require("fs");
const http = require("http");
const path = require("path");
const puppeteer = require("puppeteer-core");

// Resolved, so the containment check below compares like with like on Windows.
const REPO = path.resolve(process.env.EZ_REPO || path.join(__dirname, ".."));
const CHROME = process.env.CHROME_BIN ||
  (process.platform === "win32"
    ? "C:/Program Files/Google/Chrome/Application/chrome.exe"
    : "/usr/bin/google-chrome");
const AXE = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
                ".json": "application/json", ".png": "image/png", ".xml": "application/xml" };

const PAGES = ["/", "/contact.html", "/404.html",
  "/dashboards/best-ball-prices/", "/dashboards/best-ball-history/",
  "/dashboards/prediction-arbitrage/", "/dashboards/arb-calculator/?ayes=0.42&bno=0.55",
  "/dashboards/nfl-start-sit/", "/dashboards/nfl-rooting/"];
const VIEWPORTS = [{ width: 1440, height: 900 }, { width: 390, height: 844, isMobile: true }];

if (!fs.existsSync(CHROME)) {
  const msg = "no Chrome at " + CHROME + " (set CHROME_BIN)";
  if (process.env.CI) { console.error("FAIL: " + msg); process.exit(1); }
  console.log("SKIP: " + msg + ". Accessibility was NOT verified.");
  process.exit(0);
}

// Static server over the repo; port 0 lets the OS pick a free one.
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p.endsWith("/")) p += "index.html";
  const f = path.join(REPO, p);
  if (!f.startsWith(REPO) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
});

server.listen(0, async () => {
  const base = "http://127.0.0.1:" + server.address().port;
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new",
    args: ["--no-sandbox", "--disable-gpu"] });
  let pass = 0, fail = 0;
  try {
    for (const url of PAGES) for (const vp of VIEWPORTS) {
      const ctx = await browser.createBrowserContext();
      const page = await ctx.newPage();
      await page.setViewport(vp);
      if (url.includes("prediction-arbitrage")) {
        await page.evaluateOnNewDocument(() => {
          try { sessionStorage.setItem("ezdubs-pred-arb-unlocked-v2", "1"); } catch (e) { /* */ }
        });
      }
      await page.goto(base + url, { waitUntil: "networkidle0", timeout: 60000 });
      await new Promise((r) => setTimeout(r, 600));
      await page.evaluate(AXE);
      const violations = await page.evaluate(async () =>
        (await axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "best-practice"] }))
          .violations.map((v) => ({ id: v.id, n: v.nodes.length, ex: v.nodes[0].target.join(" ") })));
      const label = `${url} @ ${vp.width}px`;
      if (violations.length) {
        fail++;
        console.log("  FAIL  " + label);
        for (const v of violations) console.log(`          ${v.id} x${v.n}  e.g. ${v.ex}`);
      } else {
        pass++;
        console.log("  ok    " + label);
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
