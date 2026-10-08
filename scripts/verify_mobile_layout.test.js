/**
 * Measure every EZ Dubs page at real phone widths and fail on broken layout.
 *
 * Ported from the upstream AI_Agent_work harness, which is where the approach and
 * its traps are documented: headless Chrome clamps --window-size to a 500px
 * minimum viewport, so this measures inside an iframe sized to the target width;
 * the server takes an OS-assigned port, because a fixed one silently stopped
 * serving after repeated runs; and the startup sweep removes Chrome's own
 * scoped_dir* temp directories, which otherwise accumulate until Chrome returns
 * no output at all.
 *
 * Widths: 390 (iPhone 14/15), 360 (most common Android), 320 (iPhone SE).
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const REPO = process.env.EZ_REPO || process.cwd();
const CHROME = process.env.CHROME_BIN ||
  "C:/Program Files/Google/Chrome/Application/chrome.exe";
// Port 0 lets the OS assign a free one. A hardcoded port left this test looking
// broken after repeated runs: listen() still resolved but requests were never
// served, so every probe returned nothing and it read as a page failure.
let PORT = Number(process.env.UI_PORT || 0);

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
                ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
                ".ico": "image/x-icon" };

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
  // Only remove what is genuinely stale. An earlier version deleted every
  // matching directory, including ones a Chrome process was using right then --
  // which produced exactly the "no output at all" failure the sweep exists to
  // prevent, and made it look intermittent because whichever harness ran second
  // would delete the other's working directory.
  //
  // Ten minutes is far longer than any launch here takes, so anything older
  // cannot belong to a live browser. Newer directories are left for a later run,
  // which still stops the unbounded growth that reached 270.
  const STALE_MS = 10 * 60 * 1000;
  try {
    const tmp = require("os").tmpdir();
    const path2 = require("path");
    const now = Date.now();
    for (const name of fs.readdirSync(tmp)) {
      if (!name.startsWith("chrome-test-") && !name.startsWith("scoped_dir")) continue;
      const full = path2.join(tmp, name);
      try {
        if (now - fs.statSync(full).mtimeMs > STALE_MS) rmProfile(full);
      } catch { /* vanished or inaccessible; nothing to do */ }
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

function runChrome(url) {
  return new Promise((resolve) => {
    let out = "";
    const profileDir = fs.mkdtempSync(
      require("path").join(require("os").tmpdir(), "chrome-test-"));
    const p = spawn(CHROME, [
      "--headless=new", "--disable-gpu", "--no-sandbox",
      // A throwaway profile per run. Two headless instances sharing the default
      // profile fail in confusing, silent ways.
      "--user-data-dir=" + profileDir, "--hide-scrollbars",
      "--window-size=1200,1000", "--virtual-time-budget=20000", "--dump-dom", url,
    ]);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", () => {});
    const t = setTimeout(() => { killTree(p); }, 90000);
    p.on("close", () => {
      clearTimeout(t);
      // Resolve BEFORE sweeping the tree. Killing on close reaped the pipe
      // before Node had drained it, so the captured DOM came back empty and
      // every page looked broken. The sweep still runs, just after.
      resolve(out);
      setImmediate(() => { killTree(p); rmProfile(profileDir); });
    });
  });
}

// Discovered from disk, not listed. A hardcoded list covered only the three pages
// I happened to be working on while twelve others went unmeasured -- and the bugs
// this test exists to catch (a nav strip forcing the page sideways, a table
// wrapper clipping its own columns) are not specific to those three.
// This repo keeps index.html and contact.html at the root and the rest under
// dashboards/, so both locations are discovered rather than listed.
const PAGES = [];
for (const f of ["index.html", "contact.html"]) {
  if (fs.existsSync(path.join(REPO, f))) PAGES.push([f.replace(".html", ""), f]);
}
const DASH = path.join(REPO, "dashboards");
if (fs.existsSync(DASH)) {
  for (const e of fs.readdirSync(DASH, { withFileTypes: true })) {
    if (e.isDirectory() && fs.existsSync(path.join(DASH, e.name, "index.html"))) {
      PAGES.push([e.name, "dashboards/" + e.name + "/index.html"]);
    }
  }
}
const WIDTHS = [390, 360, 320];

(async () => {
  if (!fs.existsSync(CHROME)) {
    // Only a real engine applies media queries and measures layout. Locally that
    // is a skip; in CI it is a failure, because a skip there means the job reports
    // success while verifying nothing.
    const msg = "no Chrome at " + CHROME + " (set CHROME_BIN)";
    if (process.env.CI) { console.error("FAIL: " + msg); process.exit(1); }
    console.log("SKIP: " + msg + ". Mobile layout NOT verified.");
    process.exit(0);
  }
  sweepOldProfiles();
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  PORT = server.address().port;
  const tmp = [];
  let findings = 0;

  for (const [name, rel] of PAGES) {
    for (const W of WIDTHS) {
      // A harness page holding one iframe at the exact phone width.
      const harness = `<!doctype html><html><head><meta charset="utf-8"><title>h</title>
<style>html,body{margin:0;padding:0}iframe{border:0;width:${W}px;height:844px}</style></head>
<body><iframe id="f" src="/${encodeURI(rel)}"></iframe>
<script>
window.addEventListener("load", function () {
  setTimeout(function () {
    var out = { width: ${W}, page: ${JSON.stringify(name)} };
    try {
      var w = document.getElementById("f").contentWindow;
      var d = w.document, de = d.documentElement;
      out.innerWidth = w.innerWidth;
      out.scrollW = de.scrollWidth;
      out.clientW = de.clientWidth;
      out.overflows = de.scrollWidth > de.clientWidth + 1;
      out.bodyScrollW = d.body ? d.body.scrollWidth : null;
      var wide = [], seen = {};
      var all = d.querySelectorAll("*");
      for (var i = 0; i < all.length; i++) {
        var el = all[i], r = el.getBoundingClientRect();
        if (!r.width) continue;
        var cs = w.getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden") continue;
        if (r.width > w.innerWidth + 1 && el.children.length <= 14) {
          var id = el.id ? "#" + el.id : "";
          var cls = (typeof el.className === "string" && el.className)
            ? "." + el.className.trim().split(/\\s+/).slice(0,2).join(".") : "";
          var key = el.tagName.toLowerCase() + id + cls;
          if (seen[key]) continue; seen[key] = 1;
          // Is it inside a container that scrolls horizontally on purpose?
          var scrollableAncestor = null, p2 = el.parentElement;
          while (p2) {
            var pcs = w.getComputedStyle(p2);
            if (/auto|scroll/.test(pcs.overflowX)) { scrollableAncestor = p2.tagName.toLowerCase() + (p2.className ? "." + String(p2.className).trim().split(/\\s+/)[0] : ""); break; }
            p2 = p2.parentElement;
          }
          wide.push({ el: key, w: Math.round(r.width), scrollParent: scrollableAncestor });
        }
      }
      out.wide = wide.slice(0, 8);
      // Any scroll container whose content does not fit AND cannot be scrolled is
      // silently hiding part of itself -- columns the visitor can never reach.
      var clipped = [];
      var wraps = d.querySelectorAll(".table-wrap");
      for (var j = 0; j < wraps.length; j++) {
        var el2 = wraps[j], cs2 = w.getComputedStyle(el2);
        if (cs2.display === "none") continue;
        if (el2.scrollWidth > el2.clientWidth + 1 && !/auto|scroll/.test(cs2.overflowX)) {
          var cn = String(el2.className || "").split(" ")[0];
          clipped.push({ cls: cn, overflowX: cs2.overflowX,
                         clientW: el2.clientWidth, scrollW: el2.scrollWidth });
        }
      }
      out.clippedWraps = clipped.slice(0, 6);
    } catch (e) { out.error = String(e); }
    var pre = document.createElement("pre");
    pre.id = "__phone__";
    pre.textContent = JSON.stringify(out);
    document.body.appendChild(pre);
  }, 9000);
});
</script></body></html>`;
      // Unique per page/width so consecutive Chrome launches never read a file
      // the next iteration is overwriting.
      // Slugified: one page is "Net Worth and income calculator", and a
      // filename with spaces produced a URL with raw spaces that no page
      // could load -- which looked like all 15 pages failing at once.
      const slug = name.replace(/[^A-Za-z0-9_-]+/g, "-");
      const hRel = `__phone_harness_${slug}_${W}.html`;
      const hAbs = path.join(REPO, hRel);
      fs.writeFileSync(hAbs, harness);
      tmp.push(hAbs);

      const dom = await runChrome(`http://127.0.0.1:${PORT}/${encodeURI(hRel)}`);
      const m = dom.match(/<pre id="__phone__">([\s\S]*?)<\/pre>/);
      if (!m) {
        console.log(`${name} @ ${W}px: probe did not run`);
        findings++; continue;
      }
      const un = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&")
                     .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'");
      let r;
      try { r = JSON.parse(un); } catch { console.log(`${name} @ ${W}px: bad JSON`); findings++; continue; }

      const tag = `${name} @ ${W}px`;
      if (r.error) { console.log(`${tag}: probe error ${r.error}`); findings++; continue; }
      if (r.innerWidth !== W) {
        console.log(`${tag}: NOTE iframe reports innerWidth=${r.innerWidth}`);
      }
      if (r.overflows) {
        findings++;
        console.log(`${tag}: SIDEWAYS SCROLL  scrollW=${r.scrollW} clientW=${r.clientW}`);
      } else {
        console.log(`${tag}: no page overflow (scrollW=${r.scrollW} clientW=${r.clientW})`);
      }
      for (const c of (r.clippedWraps || [])) {
        findings++;
        console.log(`    CLIPPED .${c.cls} overflow-x:${c.overflowX} content ${c.scrollW}px in ${c.clientW}px -- columns unreachable`);
      }
      for (const x of (r.wide || [])) {
        // Inside an intentionally scrollable container is fine; outside it is not.
        const ok = x.scrollParent ? "  (inside scrollable " + x.scrollParent + " - OK)" : "  <-- NOT scrollable";
        if (!x.scrollParent) findings++;
        console.log(`    ${x.el} = ${x.w}px${ok}`);
      }
    }
  }
  tmp.forEach((f) => { try { fs.unlinkSync(f); } catch {} });
  server.close();
  console.log(`\n${findings} finding(s) needing attention`);
  // Must exit non-zero: otherwise it prints findings and still passes, which is
  // indistinguishable from a clean run to CI and to anyone reading a log tail.
  process.exit(findings ? 1 : 0);
})();
