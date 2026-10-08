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
// Port 0 lets the OS assign a free one. A hardcoded port made this report
// "rendered: NO" on pages that render correctly: after repeated runs listen()
// still resolved while requests went unserved, so the page never loaded and it
// read as a CSP failure. Same trap as tests/mobile_layout.test.js upstream.
let PORT = Number(process.env.CSP_PORT || 0);
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

// Kill the whole tree, not just the parent. Chrome forks children, and killing
// only the process we spawned orphans them: after a dozen runs there were 13 live
// chrome.exe processes and new instances started returning nothing at all, which
// looked like a flaky test rather than a leak.
// Remove a throwaway profile directory once Chrome is done with it. Without this
// they accumulate -- 270 of them was enough to stop Chrome starting at all, with
// no output on stdout or stderr, which looks exactly like a broken page.
function rmProfile(dir) {
  if (!dir) return;
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); }
  catch { /* Chrome may still hold a handle; the startup sweep will get it */ }
}

// Clear temp directories left behind by earlier runs -- ours AND Chrome's own.
//
// `scoped_dir*` is Chrome's, not ours: it creates them per launch and does not
// reliably remove them when run headless in quick succession. Once about 150
// accumulate, headless Chrome exits 0 and writes NOTHING to stdout or stderr,
// which is indistinguishable from a broken page. A harness that launches a
// browser dozens of times per run poisons its own environment, so it has to
// clean up after the browser too. Deleting them fixes the failure immediately.
function sweepOldProfiles() {
  try {
    const tmp = require("os").tmpdir();
    const path2 = require("path");
    for (const name of fs.readdirSync(tmp)) {
      if (name.startsWith("chrome-test-") || name.startsWith("scoped_dir")) {
        // rmSync with force ignores a directory still locked by a live browser.
        rmProfile(path2.join(tmp, name));
      }
    }
  } catch { /* best effort */ }
}

function killTree(p) {
  if (!p || p.killed) return;
  try {
    if (process.platform === "win32") {
      require("child_process").execFileSync(
        "taskkill", ["/PID", String(p.pid), "/T", "/F"],
        { stdio: "ignore", timeout: 10000 });
    } else {
      process.kill(-p.pid, "SIGKILL");
    }
  } catch { /* already gone */ }
  try { p.kill("SIGKILL"); } catch { /* already gone */ }
}

function run(url) {
  return new Promise((resolve) => {
    let out = "";
    const profileDir = fs.mkdtempSync(
      require("path").join(require("os").tmpdir(), "chrome-test-"));
    const p = spawn(CHROME, [
      "--headless=new", "--disable-gpu", "--no-sandbox",
      // A throwaway profile per run. Two headless instances sharing the default
      // profile fail in confusing, silent ways.
      "--user-data-dir=" + profileDir,
      "--virtual-time-budget=10000",
      // --enable-logging=stderr reports console messages, which is where CSP
      // violations appear. NOT --v=1: that adds Chrome's full internal trace,
      // measured at 663 KB for a single trivial page, and the flood can fill
      // Node's stderr buffer and stall the process so stdout never completes.
      // That is the real cause of the intermittent "dom bytes: 0" failures.
      "--enable-logging=stderr",
      "--dump-dom", url,
    ]);
    // Kept SEPARATE deliberately. These were concatenated, and --v=1 logging is
    // voluminous enough to bury the DOM that --dump-dom writes to stdout, so the
    // render check was reading log lines and twice reported "rendered: NO" for
    // pages that render perfectly in the same browser.
    let log = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (log += d));
    const t = setTimeout(() => { killTree(p); }, 70000);
    p.on("close", () => {
      clearTimeout(t);
      // Resolve BEFORE sweeping the tree; killing on close can reap the pipe
      // before Node has drained it, which empties the captured DOM.
      resolve({ dom: out, log });
      setImmediate(() => { killTree(p); rmProfile(profileDir); });
    });
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
  sweepOldProfiles();
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  PORT = server.address().port;

  // Prove the harness works before it is allowed to blame the pages. This script
  // has twice reported "rendered: NO" for pages that render fine, both times
  // because of how it captured Chrome's output rather than anything on the page.
  // A trivial sentinel page rules that out.
  const sentinelRel = "__csp_sentinel.html";
  const sentinelAbs = path.join(REPO, sentinelRel);
  fs.writeFileSync(sentinelAbs,
    '<!doctype html><meta charset="utf-8"><body><div id="csp-sentinel-ok">x</div>');
  const probe = await run(`http://127.0.0.1:${PORT}/${sentinelRel}`);
  try { fs.unlinkSync(sentinelAbs); } catch {}
  if (!probe.dom.includes("csp-sentinel-ok")) {
    console.error("HARNESS BROKEN: Chrome returned no usable DOM for a trivial " +
                  "page, so this run tells us nothing about the real pages.");
    console.error("  dom bytes: " + probe.dom.length +
                  ", log bytes: " + probe.log.length);
    server.close();
    process.exit(1);
  }
  let bad = 0;

  for (const [slug, viewId] of [["nfl-start-sit", "sleeper-view"],
                                ["nfl-rooting", "rooting-view"]]) {
    const url = `http://127.0.0.1:${PORT}/dashboards/${slug}/index.html`;
    // Headless Chrome occasionally exits before --dump-dom has written the DOM,
    // giving an empty capture. That is a harness artefact, not a broken page, so
    // retry instead of reporting a false failure -- a flaky security check is
    // worse than none, because people learn to ignore it.
    let dom = "", log = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      const r = await run(url);
      dom = r.dom; log = r.log;
      if (dom.includes(viewId)) break;
      if (attempt < 3) console.log(`  (empty dump for ${slug}, retry ${attempt})`);
    }
    // Violations are logged to stderr; the markup arrives on stdout. These used to
    // be concatenated, and --v=1 logging is voluminous enough to bury the DOM, so
    // the render check was reading log lines and reported "rendered: NO" for pages
    // that render perfectly in the same browser.
    const viol = [...new Set(log.split("\n").filter((l) =>
      /Content Security Policy|Refused to (load|execute|apply|connect)/i.test(l)))];
    const rendered = dom.includes(viewId);
    // The inline config script must have run: it sets LINEUP_DATA_DIR, and the
    // app only fetches data if it did. If CSP blocked inline script, the app
    // never initialises and no data-dir-driven markup appears.
    const scriptRan = /class="[^"]*\bhidden\b/.test(dom) || dom.includes("data-book");

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
