/**
 * Nothing the site publishes may name the GitHub account or the owner's email.
 *
 * The brand is pseudonymous, but GitHub Pages publishes every file in the repo
 * unless _config.yml excludes it. Until 2026-10-14 that meant /CLAUDE.md (with
 * the owner's email), /README.md, every script, and a data file whose "source"
 * was the account's Pages URL were all live on ezdubsanalytics.com.
 *
 * This works out what Jekyll would publish -- every tracked file, minus
 * _config.yml's exclude list and Jekyll's own rules (underscore and dot names)
 * -- and fails if any of it contains an identifying string. Add a new internal
 * doc without excluding it and this catches it before it ships.
 *
 * It cannot see what lives outside the repo: the DNS CNAME and the public repo
 * itself still lead to the account. See docs/site-audit-2026-10-14.md.
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = process.env.EZ_REPO || process.cwd();
const IDENTIFIERS = [/pjmerica/i, /umich\.edu/i];

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { pass++; console.log("  ok    " + label); }
  else { fail++; console.log("  FAIL  " + label + (detail ? "  [" + detail + "]" : "")); }
};

// The exclude list, read from _config.yml without a YAML dependency: it is a
// flat list of "  - path" lines under "exclude:".
function excludes() {
  const cfg = path.join(ROOT, "_config.yml");
  if (!fs.existsSync(cfg)) return [];
  const out = [];
  let inList = false;
  for (const line of fs.readFileSync(cfg, "utf8").split(/\r?\n/)) {
    if (/^exclude:\s*$/.test(line)) { inList = true; continue; }
    if (inList) {
      const m = line.match(/^\s+-\s+(\S+)/);
      if (m) out.push(m[1]);
      else if (/^\S/.test(line)) inList = false;
    }
  }
  return out;
}

const ex = excludes();
check("_config.yml has an exclude list", ex.length > 0);

const tracked = execSync("git ls-files", { cwd: ROOT, encoding: "utf8" })
  .split("\n").filter(Boolean);

const published = tracked.filter(f => {
  // Jekyll skips any path segment starting with "_" or "." (except a few it
  // whitelists, none of which apply here).
  if (f.split("/").some(seg => seg.startsWith("_") || seg.startsWith("."))) return false;
  return !ex.some(e => e.endsWith("/") ? f.startsWith(e) : f === e);
});

check("some files are still published (exclude list is not over-broad)",
      published.includes("index.html") && published.includes("CNAME"));

for (const must of ["CLAUDE.md", "README.md", "scripts/pull_nfl_data.py"]) {
  check(`${must} is not published`, !published.includes(must));
}

let leaks = 0;
for (const f of published) {
  const text = fs.readFileSync(path.join(ROOT, f), "utf8");
  for (const re of IDENTIFIERS) {
    if (re.test(text)) {
      leaks++;
      check(`${f} does not contain ${re}`, false);
    }
  }
}
check(`${published.length} published file(s) name no account or email`, leaks === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
