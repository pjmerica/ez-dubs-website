"""Wait until just before the next kickoff, for a refresh timed to the game.

GitHub's cron cannot hit "15 minutes before kickoff": on this account scheduled
runs start 1.5-4.5 hours late. A workflow_dispatch, though, starts in seconds,
and a workflow may dispatch itself in its own repo with the built-in token. So
a Sunday job is started early by cron, and this script sleeps it until the
next kickoff target; the workflow then refreshes and dispatches itself for the
target after. A GitHub job is capped at 6 hours, so a long wait takes several
hops (sleep up to --max-wait, then hand on with run=false, more=true).

Kickoffs come from gamelines.json, so the times follow the data: the clock
change in November, a London game, a flexed Sunday-night game. Kickoffs within
--cluster minutes share one refresh, timed to the earliest (4:05 and 4:25 ET
are one refresh at 3:45).

A target counts as already served when --fresh-file's lastUpdated is at or
after kickoff minus --served-after minutes, so a duplicate chain, or a re-run,
does not refresh twice.

--wait-upstream (the EZ Dubs mirror): after reaching the target, poll that URL
until its lastUpdated shows the pre-kickoff refresh, or kickoff minus 3 min.

Writes run= / more= / kickoff= to $GITHUB_OUTPUT.
This file is kept identical in AI_Agent_work and ez-dubs-website.
"""
from __future__ import annotations

import argparse
import json
import os
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path


def parse_ts(v):
    if not v or not isinstance(v, str):
        return None
    try:
        t = datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def last_updated(path: Path):
    try:
        return parse_ts(json.loads(path.read_text(encoding="utf-8")).get("lastUpdated"))
    except Exception:  # noqa: BLE001
        return None


def upstream_updated(url: str):
    try:
        with urllib.request.urlopen(f"{url}?t={int(time.time())}", timeout=20) as r:
            return parse_ts(json.loads(r.read().decode("utf-8")).get("lastUpdated"))
    except Exception:  # noqa: BLE001
        return None


def plan(kickoffs, now, lead, cluster, served_after, fresh):
    """Pending (target, kickoff) pairs, earliest first. Pure, for tests."""
    upcoming = sorted(k for k in set(kickoffs) if now + timedelta(minutes=3) < k <= now + timedelta(hours=20))
    starts = []
    for k in upcoming:
        if not starts or k - starts[-1] > timedelta(minutes=cluster):
            starts.append(k)
    out = []
    for k in starts:
        if fresh and fresh >= k - timedelta(minutes=served_after):
            continue                       # this kickoff already got its refresh
        out.append((k - timedelta(minutes=lead), k))
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gamelines", required=True)
    ap.add_argument("--fresh-file", required=True)
    ap.add_argument("--lead", type=float, default=20, help="minutes before kickoff")
    ap.add_argument("--served-after", type=float, default=22)
    ap.add_argument("--cluster", type=float, default=30)
    ap.add_argument("--max-wait", type=float, default=330, help="minutes; GitHub caps a job at 360")
    ap.add_argument("--wait-upstream", default="")
    ap.add_argument("--extra-kickoffs", default="",
                    help="comma-separated ISO times added to the slate; for testing the chain")
    args = ap.parse_args()

    out_path = os.environ.get("GITHUB_OUTPUT")

    def emit(**kv):
        line = "\n".join(f"{k}={v}" for k, v in kv.items())
        print(line)
        if out_path:
            with open(out_path, "a", encoding="utf-8") as f:
                f.write(line + "\n")

    try:
        games = json.loads(Path(args.gamelines).read_text(encoding="utf-8")).get("games") or []
    except Exception as e:  # noqa: BLE001
        print(f"cannot read {args.gamelines}: {e}")
        return emit(run="false", more="false", kickoff="")
    kicks = [t for t in (parse_ts(g.get("kickoff")) for g in games if isinstance(g, dict)) if t]
    extra = [t for t in (parse_ts(x.strip()) for x in args.extra_kickoffs.split(",")) if t]
    if extra:
        print("test kickoffs added: " + ", ".join(f"{t:%H:%M}" for t in extra))
        kicks += extra

    now = datetime.now(timezone.utc)
    pending = plan(kicks, now, args.lead, args.cluster, args.served_after,
                   last_updated(Path(args.fresh_file)))
    print(f"now {now:%a %H:%M} UTC; pending kickoffs: "
          + (", ".join(f"{k:%a %H:%M}" for _, k in pending) or "none"))
    if not pending:
        return emit(run="false", more="false", kickoff="")

    target, kick = pending[0]
    wait = (target - now).total_seconds()
    if wait > args.max_wait * 60:
        print(f"next target {target:%H:%M} UTC is {wait/3600:.1f} h away; "
              f"sleeping {args.max_wait:.0f} min, then handing on")
        time.sleep(args.max_wait * 60)
        return emit(run="false", more="true", kickoff=kick.isoformat())

    if wait > 0:
        print(f"sleeping {wait/60:.1f} min until {target:%H:%M} UTC "
              f"({args.lead:.0f} min before the {kick:%H:%M} kickoff)")
        time.sleep(wait)

    if args.wait_upstream:
        deadline = kick - timedelta(minutes=3)
        want = kick - timedelta(minutes=args.served_after)
        while True:
            up = upstream_updated(args.wait_upstream)
            if up and up >= want:
                print(f"upstream refreshed at {up:%H:%M:%S} UTC")
                break
            if datetime.now(timezone.utc) >= deadline:
                print("upstream has not refreshed for this kickoff; mirroring what is there")
                break
            time.sleep(30)

    emit(run="true", more="true" if len(pending) > 1 else "false", kickoff=kick.isoformat())


if __name__ == "__main__":
    main()
