/**
 * Every cross-origin <script> must be pinned with Subresource Integrity.
 *
 * Without SRI, anyone able to tamper with a CDN response -- a compromised CDN, a
 * hijacked DNS answer, a hostile network -- runs arbitrary JavaScript on the page,
 * with full access to whatever the visitor has typed into it. The hash makes the
 * browser refuse a file whose bytes changed.
 *
 * This also guards a subtler trap. The tag used to point at
 * dist/chart.umd.min.js, which does NOT exist in the published chart.js package:
 * jsdelivr minifies it on request and its own banner says "Do NOT use SRI with
 * dynamically generated files", because those bytes can change without the
 * version changing. So a hash pinned to that URL would eventually start blocking
 * the script. dist/chart.umd.js is the real published file -- byte-identical to
 * the npm tarball, already minified, and smaller.
 */
const fs = require("fs");
const path = require("path");

const ROOT = process.env.EZ_REPO || process.cwd();
let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { pass++; console.log("  ok    " + label); }
  else { fail++; console.log("  FAIL  " + label + (detail ? "  [" + detail + "]" : "")); }
};

// Every page in the repo, not a hardcoded list, so a new one cannot slip past.
function htmlFiles(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "_local" || e.name.startsWith(".")) continue;
    const f = path.join(dir, e.name);
    if (e.isDirectory()) htmlFiles(f, acc);
    else if (e.name.endsWith(".html")) acc.push(f);
  }
  return acc;
}

const pages = htmlFiles(ROOT);
check("found pages to scan", pages.length > 0, String(pages.length));

const SCRIPT = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
let external = 0;

for (const f of pages) {
  const html = fs.readFileSync(f, "utf8");
  const rel = path.relative(ROOT, f).replace(/\\/g, "/");
  for (const m of html.matchAll(SCRIPT)) {
    const tag = m[0], src = m[1];
    if (!/^https?:\/\//i.test(src)) continue;   // local file, same origin
    external++;
    check(rel + ": SRI on " + src.replace(/^https?:\/\//, "").slice(0, 60),
      /\bintegrity\s*=\s*["']sha(256|384|512)-/.test(tag), "no integrity attribute");
    check(rel + ": crossorigin set (SRI is ignored without it)",
      /\bcrossorigin\s*=/.test(tag), "missing crossorigin");
    // A hash cannot be pinned to a file the CDN generates per-request.
    check(rel + ": not pinning a CDN-generated file",
      !/cdn\.jsdelivr\.net\/.*\.min\.js/i.test(src),
      "jsdelivr minifies .min.js on the fly; its bytes are not stable");
  }
}

console.log("\n" + external + " external script tag(s) checked");
console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
