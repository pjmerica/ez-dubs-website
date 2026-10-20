/**
 * The site-wide styles (reset, nav, phone menu, NFL submenu) live in one file,
 * assets/site.css, since 2026-10-19. Before that they were eight identical
 * inline copies, about 39 KB in all, and a nav change meant eight edits.
 *
 * Moving them was only safe because each page links the file exactly where the
 * rules used to sit -- immediately before its own <style> -- so every page rule
 * still comes after them and wins ties the way it always did. This keeps that
 * true, and keeps the copies from creeping back:
 *
 *  - every page with the site nav links site.css, by a path that resolves,
 *    directly before its <style>;
 *  - no page's inline <style> repeats a rule that is in site.css (the port
 *    script used to paste the submenu CSS into every page; see rewrite_nav in
 *    AI_Agent_work/scripts/port_lineup_to_ezdubs.py).
 */
const fs = require("fs");
const path = require("path");
const csstree = require("css-tree");

const ROOT = process.env.EZ_REPO || path.resolve(__dirname, "..");
const SITE_CSS = path.join(ROOT, "assets", "site.css");

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { pass++; console.log("  ok    " + label); }
  else { fail++; console.log("  FAIL  " + label + (detail ? "  [" + detail + "]" : "")); }
};

// Rules flattened to "media|rule" so the same rule compares equal wherever it
// sits and however it is indented.
function flat(css) {
  const out = [];
  const walk = (list, media) => list.forEach((n) => {
    if (n.type === "Atrule" && n.name === "media") walk(n.block.children, "@media " + csstree.generate(n.prelude));
    else if (n.type === "Rule") out.push(media + "|" + csstree.generate(n));
  });
  walk(csstree.parse(css, { parseValue: false }).children, "");
  return out;
}

check("assets/site.css exists", fs.existsSync(SITE_CSS));
if (!fs.existsSync(SITE_CSS)) { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); }
const shared = new Set(flat(fs.readFileSync(SITE_CSS, "utf8")));
check("site.css holds the nav rules", [...shared].some((r) => r.startsWith("|.site-nav{")), `${shared.size} rules`);

const pages = ["index.html", "contact.html"];
for (const d of fs.readdirSync(path.join(ROOT, "dashboards"), { withFileTypes: true })) {
  if (d.isDirectory() && fs.existsSync(path.join(ROOT, "dashboards", d.name, "index.html"))) {
    pages.push(`dashboards/${d.name}/index.html`);
  }
}

let navPages = 0;
for (const rel of pages) {
  const abs = path.join(ROOT, rel);
  const html = fs.readFileSync(abs, "utf8");
  if (!html.includes('<nav class="site-nav">')) continue;
  navPages++;
  const m = html.match(/<link rel="stylesheet" href="([^"]+)">\s*<style>([\s\S]*?)<\/style>/);
  const href = m && /assets\/site\.css/.test(m[1]) ? m[1] : null;
  check(`${rel}: links site.css directly before its <style>`, !!href);
  if (!href) continue;
  check(`${rel}: site.css link resolves`,
        path.normalize(path.join(path.dirname(abs), href.split("?")[0])) === path.normalize(SITE_CSS), href);
  const dupes = flat(m[2]).filter((r) => shared.has(r));
  check(`${rel}: inline <style> repeats nothing from site.css`, dupes.length === 0,
        `${dupes.length} repeated, e.g. ${(dupes[0] || "").slice(0, 70)}`);
}
check("found the pages with the site nav", navPages >= 8, String(navPages));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
