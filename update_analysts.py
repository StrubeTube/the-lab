#!/usr/bin/env python3
"""THE LAB - scripted analyst refresh (Flock).

Fetches the machine-readable source and rewrites its section of
data/analyst_lists.json, then prints a per-source change summary:

  - Flock Fantasy: public API, Mason Dodd's board -> positional lists +
    dense overall list (his ranks number skill players 1..N, no K/DST).
    The site shows a blend of eight Flock rankers; Alex wants Dodd only
    (2026-08-30, was Corey Buschlen).

(FantasyPros was removed from the consensus 2026-08-25 per Alex.)

Joel Smyth (Yahoo article) and The Fantasy Footballers (rendered pages) are
JS-rendered and updated by Claude via the `update-analysts` skill, which
edits the same JSON file. Run build_consensus.py + compute.py afterwards.
"""
import csv
import json
import re
import urllib.request
from pathlib import Path

ROOT = Path(__file__).parent
LISTS = ROOT / "data" / "analyst_lists.json"
PINS = ROOT / "data" / "flock_dodd_pins.json"
FFA_CSV = ROOT / "data" / "raw" / "ffa_rankings.csv"
POS = ["QB", "RB", "WR", "TE"]
POS_CAP = {"QB": 50, "RB": 110, "WR": 120, "TE": 60, "DEF": 32}
# DEF lists store Sleeper team codes directly (players.json names DEFs "LAR",
# "SEA", ...) so norm-matching needs no aliases. Sources that rank defenses:
# FFA (CSV "DST" rows) and the Fantasy Footballers (skill-scraped page).
DEF_CODE = {"LVR": "LV", "JAC": "JAX", "WSH": "WAS", "LA": "LAR"}  # source -> Sleeper
OVR_CAP = 260
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36",
      "Accept": "text/html,application/json"}


def get(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8", "replace")


FLOCK_RANKER = "Mason Dodd"


def fetch_flock():
    d = json.loads(get("https://api.flockfantasy.com/rankings?format=year"))
    rows = [(x["overallRanks"][FLOCK_RANKER], x["playerName"], x["position"])
            for x in d["data"]
            if x.get("position") in POS and (x.get("overallRanks") or {}).get(FLOCK_RANKER)]
    if not rows:
        raise RuntimeError(f"no ranks found for {FLOCK_RANKER}")
    rows.sort()
    positional = {pos: [n for _, n, p in rows if p == pos][: POS_CAP[pos]] for pos in POS}
    overall = [[i + 1, n] for i, (_, n, _p) in enumerate(rows[:OVR_CAP])]
    stamp = (d.get("lastUpdated") or {}).get(FLOCK_RANKER, "")
    positional, overall = apply_pins(positional, overall, stamp)
    return positional, overall, stamp


def apply_pins(positional, overall, stamp=""):
    """Dodd's tier images outrank his live board where they overlap.

    The images cover OVR 1-100, RB 1-50 and WR 1-49; the API supplies the tail.
    His images and his board genuinely disagreed at capture time, and Alex wants
    the images to win -- but only until Dodd himself moves. Once his live board
    is NEWER than the capture, news has happened (Jacobs RB18 -> RB40 on the
    2026-08-30 evening update) and his own fresher ranks take over completely.
    """
    if not PINS.exists():
        return positional, overall
    pins = json.loads(PINS.read_text(encoding="utf-8"))
    captured = pins.get("_captured") or ""
    if captured and stamp and stamp > captured:
        print(f"  pins RETIRED — his board ({stamp}) is newer than the images ({captured})")
        return positional, overall
    head = pins.get("overall") or []
    tail = [n for _, n in overall if n not in set(head)]
    overall = [[i + 1, n] for i, n in enumerate((head + tail)[:OVR_CAP])]
    for pos, plist in (pins.get("positional") or {}).items():
        tail = [n for n in positional.get(pos, []) if n not in set(plist)]
        positional[pos] = (plist + tail)[: POS_CAP[pos]]
    return positional, overall


def fetch_ffa():
    """Fantasy Football Advice — their rankings export.

    The site's rankings sit behind a paywall with no open endpoint, so this
    reads the CSV Alex exports from his account into data/raw/ffa_rankings.csv.
    Re-export and rerun to refresh.
    """
    rows = list(csv.DictReader(FFA_CSV.read_text(encoding="utf-8-sig").splitlines()))
    skill = [r for r in rows if r.get("Pos") in POS and r.get("Player")]
    skill.sort(key=lambda r: int(r["Rank"]))
    positional = {pos: [r["Player"] for r in skill if r["Pos"] == pos][: POS_CAP[pos]]
                  for pos in POS}
    # defenses ride as team codes; overall stays skill-only (house rule: K/DST
    # keep their rank numbers upstream but never enter the overall list)
    dst = sorted((r for r in rows if r.get("Pos") == "DST"), key=lambda r: int(r["Rank"]))
    positional["DEF"] = [DEF_CODE.get(r["Team"].strip().upper(), r["Team"].strip().upper())
                         for r in dst][: POS_CAP["DEF"]]
    overall = [[i + 1, r["Player"]] for i, r in enumerate(skill[:OVR_CAP])]
    stamp = f"CSV export, {len(skill)} skill players + {len(positional['DEF'])} DEF"
    return positional, overall, stamp


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
    for src, fetch in (("flock", fetch_flock), ("ffa", fetch_ffa)):
        print(f"{src}: fetching...")
        try:
            positional, overall, stamp = fetch()
        except Exception as e:
            print(f"  FAILED ({e}) — keeping existing lists")
            continue
        for pos in positional:  # a source ranks what it ranks (FFA adds DEF)
            lists["positional"].setdefault(pos, {})
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
