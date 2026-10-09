# Archived ADP sources

Two ADP sources the site used to track and no longer does. They are kept here
**as data, not as code** — nothing reads these files. They are committed so the
history survives the machine they were sitting on.

## When each one actually stopped

The filename date range and the date the numbers last *moved* are not the same,
which matters if you ever use these for anything:

| source | rows | file covers | values last changed | dead tail |
|---|---|---|---|---|
| FFPC | 157,047 | 2026-05-07 → **2026-07-31** | **2026-07-07** | 24 dates (07-08 → 07-31) are carried-forward duplicates |
| Drafters | 88,015 | 2026-05-07 → **2026-07-31** | **2026-07-28** | 3 dates (07-29 → 07-31) are carried-forward duplicates |

So FFPC's last three and a half weeks are the same numbers repeated daily. The
puller carried values forward when an upstream source froze rather than writing
gaps, which is why the rows exist at all.

**Treat 2026-07-07 (FFPC) and 2026-07-28 (Drafters) as the real end of each
dataset.** Anything after that is the freeze, not the market.

## Why they were dropped

Both were archived on **2026-07-31**. Their columns in the upstream Google Sheet
had been byte-for-byte frozen for three months or more — the sources had stopped
being maintained upstream, so the site was recording a flat line. DK and Underdog
continued and are still in
`../dk_adp_history.csv` and `../ud_adp_history.csv`.

## Shape

Same schema as the live files:

```
date,name,pos,team,adp,source
2026-05-07,Bijan Robinson,RB,ATL,1.5,auto
```

- FFPC: 2,230 distinct players, `source` is always `auto`
- Drafters: 1,354 distinct players, `source` is `auto` or `manual`

## If you ever bring a source back

`scripts/pull_adp.py` still knows how to write both files — see the comment near
`ADP_FLOORS`. `CLAUDE.md` has the full restore checklist: the entries to add back
to `SOURCES` / `SOURCE_COLORS` / `ADP_FLOORS` / `source_cols` / `_REQUIRED_COLS`,
and the source-picker UI and "All 4 markets" tab to restore from git history
(around commit `bfc73fb`).

Copy the file you need up one level to `../<source>_adp_history.csv` first; the
puller appends to that path, not to this folder.

## Provenance

These lived in `_local/archive/` (gitignored) from 2026-07-31 until 2026-10-09,
so for ten weeks they existed only on one machine with no backup. Moved here and
committed on 2026-10-09, verified byte-identical to the originals.
