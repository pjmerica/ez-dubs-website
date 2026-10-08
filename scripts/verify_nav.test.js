/**
 * The nav and footer are copy-pasted into all 8 pages. Check they agree and that
 * every link resolves.
 *
 * This matters because there is no template and no build step: the shared chrome
 * exists as eight independent copies, so a link can rot or a menu item can go
 * missing on one page while the other seven stay correct, and nothing would
 * notice. ~39 KB of the site is duplicated CSS for the same reason.
 *
 * Deliberately a static check. The DOM-level version of this kept failing on
 * headless Chrome flakiness, and the properties worth asserting -- same links
 * everywhere, every target exists, relative depth correct -- are all visible in
 * the markup. A browser adds no information here.
 */
const fs = require("fs");
const path = require("path");

const ROOT = process.env.EZ_REPO || process.cwd();

let pass = 0;
const fails = [];
const check = (label, cond, detail) => {
  if (cond) { pass++; }
  else { fails.push(label); console.log("  FAIL  " + label + (detail ? "\n        " + detail : "")); }
};

function pages() {
  const out = [];
  for (const f of ["index.html", "contact.html"]) {
    if (fs.existsSync(path.join(ROOT, f))) out.push([f.replace(".html", ""), f]);
  }
  const dash = path.join(ROOT, "dashboards");
  if (fs.existsSync(dash)) {
    for (const e of fs.readdirSync(dash, { withFileTypes: true })) {
      if (e.isDirectory() && fs.existsSync(path.join(dash, e.name, "index.html"))) {
        out.push([e.name, "dashboards/" + e.name + "/index.html"]);
      }
    }
  }
  return out;
}

// Pull the <nav class="site-nav"> ... </nav> block out of a page.
function navOf(html) {
  const m = html.match(/<nav[^>]*class="[^"]*site-nav[^"]*"[\s\S]*?<\/nav>/i);
  return m ? m[0] : null;
}

const PAGES = pages();
check("found the site's pages", PAGES.length >= 6, String(PAGES.length));

const linkSets = new Map();
let broken = 0;

for (const [name, rel] of PAGES) {
  const abs = path.join(ROOT, rel);
  const html = fs.readFileSync(abs, "utf8");
  const nav = navOf(html);
  check(`${name}: has a site-nav block`, !!nav);
  if (!nav) continue;

  const links = [...nav.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)]
    .map((m) => ({
      href: m[1],
      text: m[2].replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ")
                .replace(/\s+/g, " ").trim(),
    }));
  check(`${name}: nav has links`, links.length > 0, String(links.length));
  linkSets.set(name, links);

  // Every internal link must resolve on disk, from THIS page's directory.
  const base = path.dirname(abs);
  for (const l of links) {
    if (/^(https?:|mailto:|tel:|#)/i.test(l.href)) continue;
    const target = l.href.split("?")[0].split("#")[0];
    if (!target) continue;
    let cand = target.startsWith("/")
      ? path.join(ROOT, target.slice(1))
      : path.join(base, target);
    cand = path.normalize(cand);
    if (target.endsWith("/") || (fs.existsSync(cand) && fs.statSync(cand).isDirectory())) {
      cand = path.join(cand, "index.html");
    }
    const ok = fs.existsSync(cand);
    if (!ok) broken++;
    check(`${name}: nav link "${l.text || l.href}" resolves`, ok,
          `${l.href} -> ${path.relative(ROOT, cand).replace(/\\/g, "/")} (missing)`);
  }

  // External links in the nav should not leak the referrer or opener.
  for (const m of nav.matchAll(/<a\b[^>]*target="_blank"[^>]*>/gi)) {
    const tag = m[0];
    const relAttr = (tag.match(/\brel="([^"]*)"/i) || [, ""])[1];
    check(`${name}: target=_blank link sets rel=noopener`,
          /noopener|noreferrer/i.test(relAttr), tag.slice(0, 90));
  }
}

// The link TEXT should be the same set on every page, or the nav has drifted.
const sigs = new Map();
for (const [p, links] of linkSets) {
  const sig = links.map((l) => l.text).filter(Boolean).sort().join(" | ");
  if (!sigs.has(sig)) sigs.set(sig, []);
  sigs.get(sig).push(p);
}
check("the nav offers the same items on every page", sigs.size === 1,
      sigs.size > 1
        ? [...sigs].map(([s, ps]) => `${ps.join(", ")}:\n          ${s.slice(0, 160)}`).join("\n        ")
        : "");

console.log(`\n${PAGES.length} page(s) checked, ${broken} broken nav link(s)`);
console.log(`${pass} passed, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);
