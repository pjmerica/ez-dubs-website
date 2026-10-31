"""Mirror the election forecast from polling-agg-2026 into the Politics pages.

The forecast (the model, the map, the race-by-race page) is built and published
by the polling-agg-2026 repo on its own GitHub Pages site. This copies it here
in the site's own look, the same way pull_nfl_data.py mirrors the NFL data:

  dashboards/politics-data/      the four data files the pages load, verbatim
  dashboards/politics-map/       the forecast map       (upstream map.html)
  dashboards/politics-forecast/  race by race           (upstream predictions.html)

The two pages are REBUILT from upstream's published HTML on every run, not
hand-made copies. Upstream's pages are under active development, and a copy
would drift within a day. So the page logic (the inline <script>) and markup
are taken verbatim, and only the look changes:

  - upstream's own header and nav are dropped; the site's nav and footer (lifted
    from the arb calculator, the donor the NFL port also uses) go around it;
  - upstream's dark-theme CSS is re-themed (retheme_css) and the Box Score
    overrides in scripts/politics/*.css are appended after it;
  - colours hard-coded in the script are swapped for newsprint ones (JS_HEX),
    party colours made dark enough to read as text on paper (PCOL), and the
    text-on-shade choice made a real WCAG contrast test (INK_FN);
  - links between the two upstream pages are pointed at the two site pages.

If upstream changes shape so that something this relies on is missing (an
element id, the inline script, a required substitution), the run FAILS and
leaves the last good page in place rather than publishing a broken one. Data
files are still updated in that case, because the live pages read them.

A file is only written when its bytes change, so a no-op run commits nothing.

Usage:
    python scripts/pull_politics.py
    python scripts/pull_politics.py --dry-run
    python scripts/pull_politics.py --src "C:/path/to/polling-agg/docs"   # local files
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = "https://pjmerica.github.io/polling-agg-2026/"
DATA_DIR = ROOT / "dashboards" / "politics-data"
THEME_DIR = Path(__file__).resolve().parent / "politics"
DONOR = ROOT / "dashboards" / "arb-calculator" / "index.html"

# (file, the global it defines). All four are required: the map draws nothing
# without the shapes, and both pages are empty without the forecast.
DATA_FILES = [
    ("forecast_data.js", "FORECAST"),     # the model's projections and explainers
    ("data.js", "RACES"),                 # every race on the ballot + market books
    ("us_map_geo.js", "US_MAP"),          # state shapes, House tile grid
    ("us_house_2026_geo.js", "US_HOUSE"), # the 435 districts on the 2026 lines
]
MIN_BYTES = 2000
TIMEOUT = 60

TITLE = "The EZ Dub Election Forecast"   # the user's name for it (2026-10-31)

PAGES = {
    "politics-map": {
        "src": "map.html",
        "data": ["forecast_data.js", "data.js", "us_map_geo.js", "us_house_2026_geo.js"],
        "theme": "map.css",
        "nav": "Forecast Map",
        "kicker": "2026 Midterms &middot; Forecast Map",
        "title": "Election Forecast Map | EZ Dubs Analytics",
        "desc": "The EZ Dub Election Forecast: every 2026 Senate, House and governor race on one map, "
                "shaded by the model's win chance or margin, with Kalshi and Polymarket alongside.",
        # ids the script looks up; missing any of them means upstream changed shape
        "ids": ["map", "metric", "src", "tabs", "tally", "legend", "detail", "rows", "thead",
                "more", "drawer", "d-body", "tip", "title", "lede", "asof"],
    },
    "politics-forecast": {
        "src": "predictions.html",
        "data": ["forecast_data.js"],
        "theme": "forecast.css",
        "nav": "Race by Race",
        "kicker": "2026 Midterms &middot; Race by Race",
        "title": "Election Forecast, Race by Race | EZ Dubs Analytics",
        "desc": "The EZ Dub Election Forecast: who the model thinks wins every 2026 Senate, House and "
                "governor race, with each candidate's chance and the factors behind it.",
        "ids": ["chambers", "legend", "grid", "count", "q", "drawer", "d-body", "tip", "asof"],
    },
}
LINKS = {"map.html": "../politics-map/", "predictions.html": "../politics-forecast/"}

# ---------------------------------------------------------------------------
# Colours. Upstream is a dark navy page; this one is paper. The map shades are
# re-drawn as newsprint blues and reds (same order, same stops), the "no race"
# and "no data" greys become paper greys, and the demographic swatches are muted.
# Keys are upstream's literals. A hex in the script that is not listed here is
# reported (it would show in upstream's colour) but does not fail the run.
JS_HEX = {
    # Win % gradient (STOPS): D, R, I from 50% to 100%
    "#dbe8fe": "#e1e7f0", "#93c5fd": "#b3c6e0", "#3b82f6": "#4f78b0", "#1d4ed8": "#1f4e8c", "#1e3a8a": "#122f57",
    "#fee2e2": "#f5e0db", "#fca5a5": "#e8b0a6", "#ef4444": "#c95547", "#b91c1c": "#a3241c", "#7f1d1d": "#661410",
    "#ede9fe": "#ebe4f2", "#c4b5fd": "#cbbbe0", "#8b5cf6": "#6e4ea3", "#7c3aed": "#5f3f92", "#4c1d95": "#3c245f",
    # Model vs markets gradient (GSTOPS)
    "#d5dbe5": "#bfc6cc", "#bfdbfe": "#c4d2e6", "#60a5fa": "#7d9cc8", "#2563eb": "#2c5a97",
    "#fecaca": "#efc6be", "#f87171": "#d77b6e", "#dc2626": "#b2342a",
    # demographics bar (DCOL); #94a3b8 is also the unknown-party fallback, so it
    # must work as a badge behind paper text too (4.7:1)
    "#94a3b8": "#6f6a60", "#c084fc": "#7a5aa6", "#34d399": "#3f8f6a", "#fb923c": "#c97a2e", "#475569": "#b8b0a0",
    # explainer factor bars: the "against" bar and its number
    "#6b7489": "#8a8478", "#aab3c5": "#4a4740",
    # dark text on a light shade
    "#0b0e14": "#1a1a1a",
}
# Party colours are used as TEXT and as badges behind paper-coloured text, so
# they are the site's dark blue and red, not the map's mid shades. This is a
# whole-statement swap because upstream's D and R values also appear in GSTOPS,
# where they must stay mid shades.
PCOL_RE = re.compile(r"const PCOL = \{[^}]*\};")
PCOL_NEW = ("const PCOL = { DEM: '#1f4e8c', REP: '#b3261e', IND: '#5f3f92', "
            "D: '#1f4e8c', R: '#b3261e', I: '#5f3f92' };")
# Upstream picks white or dark text on a shade by a perceived-brightness cut
# that lets white sit on mid reds at 3.8:1. This picks whichever has the higher
# WCAG contrast.
INK_RE = re.compile(r"  function ink\(col\) \{.*?\n  \}", re.S)
INK_FN = """  function ink(col) {  // EZ Dubs: ink or white, whichever has the higher WCAG contrast on this shade
    const m = /^rgb\\((\\d+),(\\d+),(\\d+)\\)$/.exec(col);
    const c = m ? m.slice(1).map(Number) : /^#[0-9a-f]{6}$/i.test(col) ? hex(col) : null;
    if (!c) return '#1a1a1a';
    const L = c.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    const y = 0.2126 * L[0] + 0.7152 * L[1] + 0.0722 * L[2];
    return 1.05 / (y + 0.05) > (y + 0.05) / 0.0603 ? '#fff' : '#1a1a1a';
  }"""
# The forecast page writes the rating ("Lean D") in the tier's fill colour as
# text, which is unreadable on paper for the light tiers. Show it as the same
# pill the race cards use instead.
RATING_TEXT = ('<div class="stat"><div class="v" style="color:${ratingColor(r._rt)}">${esc(r._rt.label)}</div>')
RATING_PILL = ('<div class="stat"><div class="v"><span class="pill" style="${pillStyle(r._rt)}">'
               '${esc(r._rt.label)}</span></div>')

# The map's rating pills are filled with the race's own continuous shade. Some
# mid shades give neither white nor ink 4.5:1 (Likely R at 80% was 4.3), so on
# paper the pill is ink text beside a swatch of the shade instead.
PILL_OLD = ("const pill = v => `<span class=\"pill\" style=\"background:${v.col};"
            "color:${ink(v.col)}\">${esc(v.label)}</span>`;")
PILL_NEW = ("const pill = v => `<span class=\"pill\"><i class=\"sw\" style=\"background:${v.col}\">"
            "</i>${esc(v.label)}</span>`;")

# (page, pattern or literal, replacement, required). Required ones fail the run
# when they stop matching; the rest only warn, since the page still works.
JS_SUBS = [
    ("politics-map", PCOL_RE, PCOL_NEW, True),
    ("politics-map", INK_RE, INK_FN, False),
    ("politics-map", PILL_OLD, PILL_NEW, False),
    ("politics-forecast", RATING_TEXT, RATING_PILL, False),
]
FORECAST_HEX = {
    # the independent tiers on the forecast page; Likely must carry white text
    "#7c3aed": "#5f3f92", "#8b5cf6": "#6e4ea3", "#c4b5fd": "#cbbbe0",
    "#0b0e14": "#1a1a1a", "#6b7489": "#8a8478", "#aab3c5": "#4a4740",
}

# Hex colours in upstream's CSS. Dark backgrounds become paper, white text and
# strokes become ink, translucent tints are dropped. Anything else is decided by
# brightness and reported.
CSS_HEX = {
    "#fff": "var(--ink)", "#ffffff": "var(--ink)", "#fff3": "var(--ink)",
    "#ffffff26": "rgba(26,26,26,0.25)",
    "#000c": "rgba(26,26,26,0.25)", "#000a": "rgba(26,26,26,0.4)", "#0008": "rgba(26,26,26,0.2)",
    "#5b667d": "var(--rule-soft)",
    # translucent dark panels and tints from the dark theme; the overrides
    # give those elements their paper look
    "#0b0e14": "var(--paper)", "#0b0e14cc": "transparent", "#0b0e14ee": "transparent",
    "#0b0e14f2": "transparent", "#0b0e14f5": "transparent", "#121722e6": "transparent",
    "#6d8bff26": "transparent", "#e5b84b12": "transparent", "#e5b84b2e": "transparent",
    "#e5b84b44": "transparent",
}
DROP_RULES = re.compile(r"^\s*(\*|html|body|a|a:hover|\.top\b[^{]*|\.brand\b[^{]*|:root)\s*$")


def log(msg: str) -> None:
    print(msg, flush=True)


# ---------------------------------------------------------------------------
def fetch(name: str, src: str | None) -> bytes | None:
    if src:
        p = Path(src) / name
        return p.read_bytes() if p.exists() else None
    import requests
    try:
        r = requests.get(BASE + name, timeout=TIMEOUT)
    except requests.RequestException as e:
        log(f"  {name}: request failed ({e})")
        return None
    if r.status_code != 200:
        log(f"  {name}: HTTP {r.status_code}")
        return None
    return r.content


def check_data(name: str, glob: str, raw: bytes) -> str | None:
    """Why a data file is unusable, or None. It must be `const NAME = <json>;`."""
    if len(raw) < MIN_BYTES:
        return f"only {len(raw)} bytes"
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as e:
        return f"not UTF-8 ({e})"
    head = f"const {glob} = "
    if not text.startswith(head):
        return f"does not start with '{head}'"
    body = text[len(head):].rstrip().rstrip(";")
    try:
        json.loads(body)
    except json.JSONDecodeError as e:
        return f"not valid JSON ({e})"
    return None


def write_if_changed(path: Path, data: bytes, dry: bool) -> bool:
    if path.exists() and path.read_bytes() == data:
        return False
    if not dry:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    return True


# ---------------------------------------------------------------------------
def hex_lum(h: str) -> float:
    h = h.lstrip("#")
    if len(h) in (3, 4):
        h = "".join(c * 2 for c in h[:3])
    r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def retheme_css(css: str, notes: list[str]) -> str:
    """Upstream's dark CSS, re-themed for paper. The overrides come after it."""
    out = []
    # Walk top-level blocks; @media blocks are handled by recursing on their body.
    i = 0
    while i < len(css):
        j = css.find("{", i)
        if j == -1:
            break
        sel = css[i:j]
        depth, k = 1, j + 1
        while k < len(css) and depth:
            depth += {"{": 1, "}": -1}.get(css[k], 0)
            k += 1
        body = css[j + 1:k - 1]
        s = sel.strip()
        # strip a comment preceding the selector
        s_clean = re.sub(r"/\*.*?\*/", "", s, flags=re.S).strip()
        if s_clean.startswith("@"):
            if s_clean.startswith("@keyframes"):
                out.append(f"{s_clean} {{{body}}}")
            else:
                out.append(f"{s_clean} {{\n{retheme_css(body, notes)}\n}}")
        elif not any(DROP_RULES.match(part) for part in s_clean.split(",")):
            out.append(f"{s_clean} {{{body}}}")
        i = k
    text = "\n".join(out)
    text = re.sub(r"border-radius:\s*[^;}]+", "border-radius: 0", text)
    text = re.sub(r"(box-shadow|backdrop-filter|-webkit-backdrop-filter):\s*[^;}]+;?", "", text)
    text = re.sub(r"linear-gradient\([^)]*\)", "var(--paper)", text)

    def swap(m: re.Match) -> str:
        h = m.group(0).lower()
        if h in CSS_HEX:
            return CSS_HEX[h]
        # 8-digit or 4-digit hex = translucent tint over the dark page: drop it
        if len(h) in (5, 9):
            notes.append(f"css tint {h} dropped")
            return "transparent"
        new = "var(--paper)" if hex_lum(h) < 0.35 else "var(--ink)"
        notes.append(f"css {h} -> {new}")
        return new
    return re.sub(r"#[0-9a-fA-F]{3,8}\b", swap, text)


def retheme_js(js: str, slug: str, notes: list[str]) -> str:
    for page, pat, new, required in JS_SUBS:
        if page != slug:
            continue
        if isinstance(pat, re.Pattern):
            js, n = pat.subn(lambda _m: new, js, count=1)
        else:
            n = js.count(pat)
            js = js.replace(pat, new)
        if not n:
            msg = f"substitution not found: {getattr(pat, 'pattern', pat)[:70]}"
            if required:
                raise ValueError(msg)
            notes.append("WARNING " + msg)
    table = JS_HEX if slug == "politics-map" else FORECAST_HEX
    unknown = set()

    def swap(m: re.Match) -> str:
        h = m.group(0)
        if h.lower() in table:
            return table[h.lower()]
        if h.lower() not in ("#fff", "#ffffff") and h not in PCOL_NEW and h != "#1a1a1a":
            unknown.add(h)
        return h
    # Only quoted colour literals, so ids in selectors ('#map') are left alone.
    js = re.sub(r"(?<=['\"`:])#[0-9a-fA-F]{6}\b|(?<=['\"`:])#[0-9a-fA-F]{3}\b", swap, js)
    for h in sorted(unknown):
        notes.append(f"js colour {h} kept as upstream's (add it to the hex table)")
    for old, new in LINKS.items():
        js = js.replace(old, new)
    return js


# ---------------------------------------------------------------------------
def lift(pattern: str, html: str, what: str) -> str:
    m = re.search(pattern, html, re.S)
    if not m:
        raise ValueError(f"could not find {what}")
    return m.group(0)


def site_nav(active_slug: str) -> str:
    html = DONOR.read_text(encoding="utf-8")
    nav = lift(r"[ \t]*<nav class=\"site-nav\">.*?</nav>", html, "the site nav in the calculator page")
    nav = nav.replace(' class="active"', "").replace(" has-active", "")
    if "Politics" not in nav:
        raise ValueError("the calculator's nav has no Politics menu; add it to the site nav first")
    nav = nav.replace(f'<a href="../{active_slug}/">', f'<a href="./" class="active">', 1)
    nav = re.sub(r'(<button type="button" class="nav-dd-btn)(">Politics)', r"\1 has-active\2", nav, count=1)
    return nav


def site_footer() -> str:
    return lift(r"[ \t]*<footer class=\"site-footer\">.*?</footer>", DONOR.read_text(encoding="utf-8"),
                "the site footer")


def site_css_link() -> str:
    m = re.search(r'<link rel="stylesheet" href="\.\./\.\./assets/site\.css(\?v=[^"]*)?">',
                  DONOR.read_text(encoding="utf-8"))
    if not m:
        raise ValueError("could not find the site.css link in the calculator page")
    return m.group(0)


HEAD = """<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'self'; form-action 'self'">
    <meta name="referrer" content="strict-origin-when-cross-origin">
    <title>{title}</title>
    <meta name="description" content="{desc}">
    <link rel="icon" href="/EDA.png" type="image/png">
    <meta property="og:title" content="{title}">
    <meta property="og:description" content="{desc}">
    <meta property="og:url" content="https://ezdubsanalytics.com/dashboards/{slug}/">
    <meta property="og:type" content="website">
    <meta property="og:image" content="https://ezdubsanalytics.com/EDA.png">
    <meta name="twitter:card" content="summary">
    <meta name="twitter:image" content="https://ezdubsanalytics.com/EDA.png">
    <!-- GENERATED by scripts/pull_politics.py from the polling-agg-2026 forecast
         ({src}). Do not edit by hand: the next run rebuilds it. The look lives in
         scripts/politics/*.css and the colour tables in that script. -->
    {css_link}
    <style>
{style}
    </style>
</head>
<body>
{nav}

    <main class="pol" id="main">
    <header class="pol-head">
        <p class="kicker">{kicker}</p>
        <h1 class="headline">{h1}</h1>
        <div id="pol-load-error" hidden></div>
    </header>
{body}
    </main>

{footer}

{data_scripts}
    <script>
    // The page's own script below assumes its data loaded. If a file failed,
    // say so once, where the content would have been (site convention:
    // assets/site.css .load-error), and leave the empty controls hidden.
    (function () {{
        const nav = document.querySelector('.site-nav');
        const setNav = () => document.documentElement.style.setProperty('--nav-h', (nav ? nav.offsetHeight : 0) + 'px');
        setNav(); addEventListener('resize', setNav);
        // The data files declare top-level consts, which are not window
        // properties, so each is tested by name.
        const missing = [];
{globals}
        if (!missing.length) return;
        const el = document.getElementById('pol-load-error');
        el.className = 'load-error'; el.setAttribute('role', 'alert');
        const s = document.createElement('strong'); s.textContent = 'The forecast could not be loaded.';
        const w = document.createElement('span'); w.className = 'why'; w.textContent = '(missing: ' + missing.join(', ') + ')';
        el.append(s, 'Refresh the page to try again. ', w);
        el.hidden = false;
        document.querySelectorAll('main.pol > .wrap, main.pol > .views, main.pol > .controls').forEach(n => n.hidden = true);
    }})();
    </script>
    <script>
{script}
    </script>
</body>
</html>
"""


def build_page(slug: str, cfg: dict, upstream: str, data_hash: dict, notes: list[str]) -> str:
    style = lift(r"<style>(.*?)</style>", upstream, "upstream's <style>")[len("<style>"):-len("</style>")]
    scripts = re.findall(r"<script>(.*?)</script>", upstream, re.S)
    if not scripts or len(scripts[-1]) < 5000:
        raise ValueError("could not find upstream's inline page script")
    script = scripts[-1]
    body = lift(r"<body>(.*)</body>", upstream, "upstream's <body>")[len("<body>"):-len("</body>")]
    body = body.replace(f"<script>{script}</script>", "")
    # upstream's own masthead and links to its other pages
    body, n = re.subn(r'\s*<div class="top"><div class="wrap">.*?</div></div>', "", body, count=1, flags=re.S)
    if not n:
        notes.append("WARNING upstream header (.top) not found; nothing removed")
    for old, new in LINKS.items():
        body = body.replace(f'href="{old}', f'href="{new}')
    linked = script
    for old, new in LINKS.items():
        linked = linked.replace(old, new)
    stray = sorted(set(re.findall(r'href="([a-z0-9_-]+\.html)', body + linked)))
    if stray:
        raise ValueError(f"links to upstream pages the site does not have: {', '.join(stray)}")
    for i in cfg["ids"]:
        if f'id="{i}"' not in body:
            raise ValueError(f"element #{i} is gone from upstream's {cfg['src']}")
    # The page's <h1> is the site's; upstream's page heading becomes an <h2>.
    body = re.sub(r"<h1\b", "<h2", body).replace("</h1>", "</h2>")
    # Scrolling regions must be reachable by keyboard (axe: scrollable-region-focusable).
    body = re.sub(r'<div class="(tw|mapscroll)">', r'<div class="\1" tabindex="0">', body)

    theme = "\n".join((THEME_DIR / f).read_text(encoding="utf-8") for f in ("common.css", cfg["theme"]))
    css = "/* upstream's styles, re-themed */\n" + retheme_css(style, notes) + "\n/* EZ Dubs overrides */\n" + theme
    css = "\n".join("        " + ln if ln.strip() else "" for ln in css.splitlines())

    data_scripts = "\n".join(
        f'    <script src="../politics-data/{f}?v={data_hash[f]}"></script>' for f in cfg["data"])
    globals_ = "\n".join(f"        if (typeof {g} === 'undefined') missing.push('{f}');"
                         for f, g in DATA_FILES if f in cfg["data"])
    return HEAD.format(
        title=cfg["title"], desc=cfg["desc"], slug=slug, src=cfg["src"], css_link=site_css_link(),
        style=css, nav=site_nav(slug), kicker=cfg["kicker"], h1=TITLE, body=body.rstrip(),
        footer=site_footer(), data_scripts=data_scripts, globals=globals_,
        script=retheme_js(script, slug, notes).strip("\n"))


# ---------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="fetch and report, write nothing")
    ap.add_argument("--src", help="read upstream's docs/ folder from disk instead of its Pages site")
    args = ap.parse_args()

    log(f"Mirroring the election forecast from {args.src or BASE}")
    failed = False

    # --- data ---------------------------------------------------------------
    data_hash = {}
    for name, glob in DATA_FILES:
        raw = fetch(name, args.src)
        dest = DATA_DIR / name
        why = "unavailable" if raw is None else check_data(name, glob, raw)
        if why:
            log(f"  {name}: {why}; existing file left in place")
            failed = True
            if not dest.exists():
                continue
            raw = dest.read_bytes()
        elif write_if_changed(dest, raw, args.dry_run):
            log(f"  {name}: {'WOULD UPDATE' if args.dry_run else 'updated'} ({len(raw):,} bytes)")
        else:
            log(f"  {name}: unchanged")
        data_hash[name] = hashlib.sha256(raw).hexdigest()[:10]

    # --- pages --------------------------------------------------------------
    for slug, cfg in PAGES.items():
        notes: list[str] = []
        if any(f not in data_hash for f in cfg["data"]):
            log(f"  {slug}: skipped, a data file it needs has never been mirrored")
            failed = True
            continue
        raw = fetch(cfg["src"], args.src)
        if raw is None:
            log(f"  {slug}: could not fetch {cfg['src']}; page left as it was")
            failed = True
            continue
        try:
            html = build_page(slug, cfg, raw.decode("utf-8"), data_hash, notes)
        except ValueError as e:
            log(f"  {slug}: NOT REBUILT, {e}. The last good page stays live; fix this script.")
            failed = True
            continue
        out = ROOT / "dashboards" / slug / "index.html"
        # LF throughout: upstream's pages mix in CRLF, and the repo stores LF.
        changed = write_if_changed(out, html.replace("\r\n", "\n").encode("utf-8"), args.dry_run)
        log(f"  {slug}: {('WOULD UPDATE' if args.dry_run else 'rebuilt') if changed else 'unchanged'}")
        for n in sorted(set(notes)):
            log(f"      {n}")

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
