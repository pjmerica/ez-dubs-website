/**
 * Load the NFL dashboards in real headless Chrome and report CSP violations.
 *
 * jsdom does not enforce CSP, so the jsdom suite passing is no evidence the
 * policy is safe: a bad policy breaks the page in a browser while the tests stay
 * green. This closes that gap.
 *
 * Previous version of this script spawned Chrome twice and conflated the two
 * outputs, which reported "DOM dumped: NO" on pages that render correctly. One
 * spawn, one buffer.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const REPO = process.env.EZ_REPO || process.cwd();
// Overridable so this can run on a CI runner, where Chrome lives elsewhere.
const CHROME = process.env.CHROME_BIN ||
  (process.platform === "win32"
    ? "C:/Program Files/Google/Chrome/Application/chrome.exe"
    : "/usr/bin/google-chrome");
const PORT = 8733;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
                ".json": "application/json", ".svg": "image/svg+xml" };

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "");
  const f = path.join(REPO, rel);
  if (!path.resolve(f).startsWith(path.resolve(REPO))) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
});

function run(url) {
  return new Promise((resolve) => {
    let out = "";
    const p = spawn(CHROME, [
      "--headless=new", "--disable-gpu", "--no-sandbox",
      "--virtual-time-budget=10000",
      "--enable-logging=stderr", "--v=1",
      "--dump-dom", url,
    ]);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    const t = setTimeout(() => { try { p.kill(); } catch {} }, 70000);
    p.on("close", () => { clearTimeout(t); resolve(out); });
  });
}

(async () => {
  if (!fs.existsSync(CHROME)) {
    // A real browser is the only thing that enforces CSP, so without one this
    // cannot be checked. Locally that is a loud skip; in CI it is a failure,
    // because a skip there would mean the job reports success while verifying
    // nothing -- which is exactly how the jsdom suite sat broken unnoticed.
    const msg = "no Chrome at " + CHROME + " (set CHROME_BIN)";
    if (process.env.CI) {
      console.error("FAIL: " + msg + ". Refusing to pass without verifying CSP.");
      process.exit(1);
    }
    console.log("SKIP: " + msg + ". CSP was NOT verified.");
    process.exit(0);
  }
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  let bad = 0;

  for (const [slug, viewId] of [["nfl-start-sit", "sleeper-view"],
                                ["nfl-rooting", "rooting-view"]]) {
    const url = `http://127.0.0.1:${PORT}/dashboards/${slug}/index.html`;
    // Headless Chrome occasionally exits before --dump-dom has written the DOM,
    // giving an empty capture. That is a harness artefact, not a broken page, so
    // retry instead of reporting a false failure -- a flaky security check is
    // worse than none, because people learn to ignore it.
    let out = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      out = await run(url);
      if (out.includes(viewId)) break;
      if (attempt < 3) console.log(`  (empty dump for ${slug}, retry ${attempt})`);
    }
    const viol = [...new Set(out.split("\n").filter((l) =>
      /Content Security Policy|Refused to (load|execute|apply|connect)/i.test(l)))];
    const rendered = out.includes(viewId);
    // The inline config script must have run: it sets LINEUP_DATA_DIR, and the
    // app only fetches data if it did. If CSP blocked inline script, the app
    // never initialises and no data-dir-driven markup appears.
    const scriptRan = /class="[^"]*\bhidden\b/.test(out) || out.includes("data-book");

    console.log(`\n=== ${slug} ===`);
    console.log("  rendered (" + viewId + " present): " + (rendered ? "yes" : "NO"));
    console.log("  page scripts executed: " + (scriptRan ? "yes" : "unclear"));
    if (viol.length) {
      bad += viol.length;
      console.log("  CSP VIOLATIONS:");
      viol.slice(0, 8).forEach((v) => console.log("    " + v.trim().slice(0, 170)));
    } else {
      console.log("  CSP violations: none");
    }
    if (!rendered) bad++;
  }

  server.close();
  console.log("\n" + (bad ? bad + " problem(s)" : "clean: the CSP does not break either page"));
  process.exit(bad ? 1 : 0);
})();
