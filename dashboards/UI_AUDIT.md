# UI and accessibility audit

**Run:** 2026-10-08, against all 8 pages (index, contact, and the six dashboards).

Everything below was **measured in real Chrome** — computed colours against their
actual backgrounds, element rectangles, accessible names — not read off the
markup. Where a number appears, it came from the browser.

---

## Fixed

### Contrast: 77 declarations were below WCAG AA

The site had drifted into six near-identical dark greys for secondary text, and
every one of them failed the 4.5:1 floor for normal text:

| was | ratio | where |
|---|---|---|
| `#555555` | 2.05:1 | `.chart-empty`, `.legend-note` |
| `#555566` | 2.43:1 | `.updated` |
| `#666666` | 3.09:1 | `.section-sub` |
| `#556877` | 3.07:1 | footer meta |
| `#6a6a8a` | 3.41:1 | ported NFL footer |
| `#6f7e8d` | 4.00:1 | hints, legends, disclaimers |

They collapse to two values: **`#7f8c99`** (4.85:1 on the page background) and
**`#8a97a5`** (5.14:1, used where the text sits on the lighter card). Both are
close enough in tone that the design keeps its character — this was not a
redesign.

The primary buttons were the worst case: **white on the brand accent `#4a9eff`
is 2.75:1**, on the most important control on each page. Darkening the accent
would change a colour visitors recognise, so the *label* went dark instead —
`#0f1923` on `#4a9eff` is **6.44:1** and the button keeps its brand fill.

Re-measured afterwards: one apparently-failing rule remained, and it turned out
to be the audit's own injected element, not the site.

### Eleven form controls had no accessible name

Two different causes, needing different fixes.

The **arb calculator** already displayed "Side A label", "A: Yes price",
"Bankroll" and so on — but no label carried `for`, and the input was a sibling
rather than a child, so nothing associated them. Seven now do, which also means
clicking a label focuses its field.

The **search boxes and the password gate** had only a `placeholder`. A
placeholder is not a label: it disappears the moment someone types, so anyone who
looks away loses the only hint of what the field is, and it is announced
inconsistently by screen readers. Those got `aria-label`, which changes nothing
visually — the placeholder remains as the visible affordance.

### Tap targets below the 24px minimum

WCAG 2.2 (2.5.8, AA) asks for 24×24 CSS px. Measured: the brand link 140×22, and
the footer links `Contact` 45×17, `Blog (Substack)` 89×17, `Substack` 53×18,
`Buy Me a Coffee` 99×18, `Arb Calculator` 92×18.

They take vertical padding, absorbed by the existing line-height, so nothing
moves visually.

The nav caret stays at 11px **on purpose** — it is decoration beside a text label
that is itself the control, and enlarging it would change the nav's proportions
for no gain. It is now `aria-hidden="true"` so screen readers stop announcing a
meaningless glyph.

### best-ball-prices scrolled sideways at 320px

Measured 337px against a 320px viewport, with `span.rec-val` past the edge and no
scrollable ancestor — so the whole page moved, header included.

The Top-10 row is a flex line of near-fixed parts:

```
.rec-rank  22px  +  margins 24px  +  .rec-adps min-width 90px  +  .rec-val 55px
= 191px before the player name gets any width at all
```

`.rec-adps` cannot compress past its minimum, so past a point the line overflows.
The page had media queries at 720px and 760px but nothing for the narrowest
phones. Below 380px the two numeric columns release their minimums and the ADP
detail wraps onto its own line under the name — which is the better reading order
regardless: the name is what you scan, the numbers are what you read second.

### Missing meta descriptions

The two NFL pages had none, so a search result or shared link showed a scrape of
body text instead of a sentence. Added, matching the house style of the other
dashboards.

---

## Checked and found healthy

- All 8 pages return 200 on the live site.
- No broken local references across 99 `src`/`href` links.
- `frame-ancestors 'none'` is present on six pages. Note it is **inert in a
  `<meta>` tag** — Chrome ignores it there and says so in the console. GitHub
  Pages cannot set response headers, so clickjacking protection is not available
  on this host; the directive is harmless but does nothing.
- `daily-adp-pull` shows three consecutive failures from 2026-09-19 and has not
  run since. That is **deliberate and correctly documented** in the workflow: the
  2026 Best Ball season closed Sept 4 and the cron was disabled, with
  `workflow_dispatch` retained for 2027. Not a problem.

---

## Open: the shared chrome is eight copies

There is no template and no build step, so the nav, the footer and their styles
exist as eight independent copies.

Measured: **56 CSS rules appear on 6 or more of the 8 pages**, totalling roughly
**39 KB of duplicated CSS**. Every page carries its own `<style>` block of
78–144 rules, about half of which are shared chrome.

What this costs:

- The contrast fix above had to edit 8 files instead of 1.
- Any nav change means 8 edits, and a missed one drifts silently.
- Every visitor downloads the chrome CSS again on every page, uncached.

The shared rules are **mostly contiguous** within each `<style>` block — runs of
23, 15 and 14 rules — so extracting them into a single `assets/chrome.css` is
feasible rather than a rewrite. It is still a refactor across 8 live pages, so it
is left as a decision rather than done unilaterally.

Checked today: the eight copies have **not** drifted. The apparent differences
are base rules against their own media-query overrides, not inconsistencies.
`scripts/verify_nav.test.js` now asserts they stay that way.

---

## What runs in CI now

| check | needs a browser | what it catches |
|---|---|---|
| `verify_cdn_integrity.test.js` | no | a cross-origin script without SRI, or one pinned to a CDN-generated file |
| `verify_nav.test.js` | no | nav drift between pages, a broken nav link, a `target=_blank` without `rel=noopener` |
| `verify_nfl_pages.test.js` | yes (jsdom) | the NFL dashboards failing to render or sign in |
| `verify_csp.test.js` | yes (Chrome) | a CSP that blocks the page's own scripts |
| `verify_mobile_layout.test.js` | yes (Chrome) | sideways scroll or a clipped scroll container at 390/360/320px |

The two Chrome-based checks measure inside an iframe, because headless Chrome
clamps `--window-size` to a 500px minimum viewport — both layout bugs found in
this work were invisible at 500px.
