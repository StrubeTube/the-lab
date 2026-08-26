#!/usr/bin/env python3
"""THE LAB - scripted analyst refresh (Flock).

Fetches the machine-readable source and rewrites its section of
data/analyst_lists.json, then prints a per-source change summary:

  - Flock Fantasy: public API, Corey Buschlen's board -> positional lists +
    dense overall list (his ranks number skill players 1..N, no K/DST).

(FantasyPros was removed from the consensus 2026-08-25 per Alex.)

Joel Smyth (Yahoo article) and The Fantasy Footballers (rendered pages) are
JS-rendered and updated by Claude via the `update-analysts` skill, which
edits the same JSON file. Run build_consensus.py + compute.py afterwards.
"""
import json
import re
import urllib.request
from pathlib import Path

ROOT = Path(__file__).parent
LISTS = ROOT / "data" / "analyst_lists.json"
POS = ["QB", "RB", "WR", "TE"]
POS_CAP = {"QB": 50, "RB": 110, "WR": 120, "TE": 60}
OVR_CAP = 260
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36",
      "Accept": "text/html,application/json"}


def get(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8", "replace")


def fetch_flock():
    d = json.loads(get("https://api.flockfantasy.com/rankings?format=year"))
    rows = [(x["overallRanks"]["Corey Buschlen"], x["playerName"], x["position"])
            for x in d["data"]
            if x.get("position") in POS and (x.get("overallRanks") or {}).get("Corey Buschlen")]
    rows.sort()
    positional = {pos: [n for _, n, p in rows if p == pos][: POS_CAP[pos]] for pos in POS}
    overall = [[i + 1, n] for i, (_, n, _p) in enumerate(rows[:OVR_CAP])]
    return positional, overall, (d.get("lastUpdated") or {}).get("Corey Buschlen", "")


def diff(old, new, label):
    """Change summary between two ordered name lists."""
    op = {n: i + 1 for i, n in enumerate(old)}
    np_ = {n: i + 1 for i, n in enumerate(new)}
    added = [n for n in new if n not in op]
    dropped = [n for n in old if n not in np_]
    moved = sorted(((abs(np_[n] - op[n]), n, op[n], np_[n]) for n in np_ if n in op and np_[n] != op[n]),
                   reverse=True)
    print(f"  {label}: {len(moved)} moved, {len(added)} added, {len(dropped)} dropped"
          + (f"; biggest: " + ", ".join(f"{n} {o}->{w}" for _, n, o, w in moved[:3]) if moved else ""))
    return len(moved) + len(added) + len(dropped)


def main():
    lists = json.loads(LISTS.read_text(encoding="utf-8"))
    total = 0
    for src, fetch in (("flock", fetch_flock),):
        print(f"{src}: fetching...")
        try:
            positional, overall, stamp = fetch()
        except Exception as e:
            print(f"  FAILED ({e}) — keeping existing lists")
            continue
        for pos in POS:
            total += diff(lists["positional"][pos].get(src, []), positional[pos], f"{pos}")
            lists["positional"][pos][src] = positional[pos]
        total += diff([n for _, n in lists["overall"].get(src, [])], [n for _, n in overall], "OVR")
        lists["overall"][src] = overall
        lists["updated"][src] = stamp or lists["updated"].get(src, "")
        print(f"  source timestamp: {lists['updated'][src]}")
    LISTS.write_text(json.dumps(lists, indent=1), encoding="utf-8")
    print(f"wrote {LISTS} — {total} total ranking changes across scripted sources")


if __name__ == "__main__":
    main()
